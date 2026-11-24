// ADR-0044, ADR-0046, ADR-0068: who pays for a run, budgets, and the subscription fallback.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishRun, openCoreDatabase, setSetting, startRun } from "@achords/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBilling } from "./billing.ts";

describe("billing (ADR-0044, ADR-0046, ADR-0068)", () => {
  let dir: string;
  let db: ReturnType<typeof openCoreDatabase>;
  let notes: string[];
  let keys: Set<string>;
  const make = () =>
    createBilling({
      db,
      notify: (text) => notes.push(text),
      keySet: (id) => keys.has(id),
      resolveKey: (id) => `secret-of-${id}`,
    });
  const spend = (usd: number, billing: "api" | "subscription" = "api") => {
    const run = startRun(db, { provider: "cli-claude", billing });
    finishRun(db, run.id, "succeeded", { costUsd: usd });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "achords-billing-"));
    db = openCoreDatabase(join(dir, "core.db"));
    notes = [];
    keys = new Set(["anthropic-api-key"]);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("follows the provider's setting when the agent names none", () => {
    const b = make();
    expect(b.billing("cli-claude")).toEqual({ mode: "subscription" });
    setSetting(db, "billing.cli-claude", "api");
    expect(b.billing("cli-claude")).toEqual({
      mode: "api",
      env: { ANTHROPIC_API_KEY: "secret-of-anthropic-api-key" },
    });
  });

  it("lets the agent's own choice override the provider's setting, both ways", () => {
    const b = make();
    expect(b.billing("cli-claude", "api")).toMatchObject({ mode: "api" });
    setSetting(db, "billing.cli-claude", "api");
    expect(b.billing("cli-claude", "subscription")).toEqual({ mode: "subscription" });
  });

  it("refuses API mode without a key, also when an agent asks for it", () => {
    keys.clear();
    expect(() => make().billing("cli-claude", "api")).toThrow(/needs its API key/);
  });

  it("without the fallback, a used-up budget makes API work wait (ADR-0046)", () => {
    setSetting(db, "budget.cli-claude.month", "10");
    spend(10);
    const b = make();
    expect(b.billing("cli-claude", "api")).toMatchObject({ mode: "api" });
    expect(b.budget("cli-claude")).toMatch(/used up/);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/waits/);
  });

  it("with the fallback, a used-up budget moves API work to the subscription", () => {
    setSetting(db, "budget.cli-claude.month", "10");
    setSetting(db, "budget.cli-claude.fallback", "subscription");
    spend(9.99);
    const b = make();
    expect(b.billing("cli-claude", "api")).toMatchObject({ mode: "api" });
    spend(0.01);
    expect(b.billing("cli-claude", "api")).toEqual({ mode: "subscription" });
    expect(b.billing("cli-claude", "api")).toEqual({ mode: "subscription" });
    // Told once, that the subscription took over (not that work waits).
    const stops = notes.filter((n) => n.startsWith("⛔"));
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatch(/subscription/);
    expect(stops[0]).not.toMatch(/waits/);
  });

  it("goes back to the API when the budget is raised", () => {
    setSetting(db, "budget.cli-claude.month", "10");
    setSetting(db, "budget.cli-claude.fallback", "subscription");
    spend(10);
    const b = make();
    expect(b.billing("cli-claude", "api")).toEqual({ mode: "subscription" });
    setSetting(db, "budget.cli-claude.month", "20");
    expect(b.billing("cli-claude", "api")).toMatchObject({ mode: "api" });
  });

  it("counts only API money toward the budget", () => {
    setSetting(db, "budget.cli-claude.month", "10");
    setSetting(db, "budget.cli-claude.fallback", "subscription");
    spend(50, "subscription");
    expect(make().billing("cli-claude", "api")).toMatchObject({ mode: "api" });
  });
});

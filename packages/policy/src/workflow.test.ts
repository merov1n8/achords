import { describe, expect, it } from "vitest";
import {
  checkMove,
  DEFAULT_WORKFLOW_YAML,
  doneColumn,
  parseWorkflow,
  permissionMatrix,
} from "./workflow.ts";

const wf = parseWorkflow(DEFAULT_WORKFLOW_YAML, "default");
const task = { assignee: "dev", column: "in_progress" };
const dev = { kind: "agent" as const, id: "dev", roles: ["dev"] };
const qa = { kind: "agent" as const, id: "qa", roles: ["qa"] };
const owner = { kind: "owner" as const };

describe("default workflow", () => {
  it("has the agreed columns, start and finish", () => {
    expect(wf.columns).toEqual(["backlog", "todo", "in_progress", "review", "done", "deployed"]);
    expect(wf.start).toBe("in_progress");
    expect(wf.finish).toBe("review");
    expect(wf.on_enter.review).toEqual({ assign: "role:qa" });
    // ADR-0066: the owner dropping a card into in_progress starts its agent.
    expect(wf.on_enter.in_progress).toEqual({ start: "assignee" });
  });
});

describe("checkMove", () => {
  it("lets the assignee hand its work to review", () => {
    expect(checkMove(wf, task, "review", dev)).toEqual({ ok: true, override: false });
  });

  it("a dev cannot move its own work to done", () => {
    const out = checkMove(wf, { ...task, column: "review" }, "done", dev);
    expect(out.ok).toBe(false);
  });

  it("QA can move reviewed work to done", () => {
    expect(checkMove(wf, { ...task, column: "review" }, "done", qa)).toEqual({
      ok: true,
      override: false,
    });
  });

  it("four eyes: an assignee that also has the qa role still cannot approve its own work", () => {
    const devQa = { kind: "agent" as const, id: "dev", roles: ["dev", "qa"] };
    const out = checkMove(wf, { ...task, column: "review" }, "done", devQa);
    expect(out).toEqual({ ok: false, reason: expect.stringMatching(/four-eyes|own work/) });
  });

  it("agents cannot skip columns or move to unknown ones", () => {
    expect(checkMove(wf, task, "deployed", dev).ok).toBe(false);
    expect(checkMove(wf, task, "nowhere", dev)).toEqual({
      ok: false,
      reason: expect.stringMatching(/unknown column/),
    });
  });

  it("the owner may move anything; moves outside the rules are flagged as overrides", () => {
    expect(checkMove(wf, { ...task, column: "done" }, "deployed", owner)).toEqual({
      ok: true,
      override: false,
    });
    expect(checkMove(wf, task, "deployed", owner)).toEqual({ ok: true, override: true });
  });

  it("moving to the same column is refused", () => {
    expect(checkMove(wf, task, "in_progress", owner).ok).toBe(false);
  });
});

describe("parseWorkflow", () => {
  it("accepts on_enter.start: assignee on any column, and nothing else for start", () => {
    const custom = parseWorkflow(
      "columns: [a, b]\nstart: a\nfinish: b\ntransitions: []\non_enter:\n  b: { start: assignee }\n",
      "w",
    );
    expect(custom.on_enter.b).toEqual({ start: "assignee" });
    expect(() =>
      parseWorkflow(
        "columns: [a, b]\nstart: a\nfinish: b\ntransitions: []\non_enter:\n  b: { start: owner }\n",
        "w",
      ),
    ).toThrow(/on_enter.b.start/);
  });

  it("rejects transitions, start or on_enter that name unknown columns", () => {
    expect(() =>
      parseWorkflow(
        "columns: [a, b]\nstart: a\nfinish: b\ntransitions:\n  - { from: a, to: c, by: owner }\n",
        "w",
      ),
    ).toThrow(/transitions.0.to/);
    expect(() =>
      parseWorkflow("columns: [a, b]\nstart: x\nfinish: b\ntransitions: []\n", "w"),
    ).toThrow(/start/);
    expect(() =>
      parseWorkflow(
        "columns: [a, b]\nstart: a\nfinish: b\ntransitions: []\non_enter:\n  z: { approve: owner }\n",
        "w",
      ),
    ).toThrow(/on_enter.z/);
  });

  it("rejects unknown keys and malformed 'by'", () => {
    expect(() =>
      parseWorkflow("columns: [a]\nstart: a\nfinish: a\ntransitions: []\nextra: 1\n", "w"),
    ).toThrow(/extra/);
    expect(() =>
      parseWorkflow(
        "columns: [a, b]\nstart: a\nfinish: b\ntransitions:\n  - { from: a, to: b, by: anyone }\n",
        "w",
      ),
    ).toThrow(/by/);
  });
});

describe("permissionMatrix", () => {
  it("lists who may enter each column from where", () => {
    const m = permissionMatrix(wf);
    expect(m.find((r) => r.to === "done")).toEqual({
      to: "done",
      rules: [{ from: "review", by: "role:qa", not: "assignee" }],
    });
  });
});

describe("doneColumn", () => {
  it("is the column after finish, or finish when it is the last one", () => {
    expect(doneColumn(wf)).toBe("done");
    const last = parseWorkflow(
      "columns: [todo, doing, review]\nstart: doing\nfinish: review\ntransitions: []\n",
      "w",
    );
    expect(doneColumn(last)).toBe("review");
  });
});

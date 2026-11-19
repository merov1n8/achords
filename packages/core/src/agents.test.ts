import { describe, expect, it } from "vitest";
import { listAgents, upsertAgent } from "./agents.ts";
import { openCoreDatabase } from "./db/database.ts";

describe("agents", () => {
  it("upserts agents from manifests", () => {
    const db = openCoreDatabase(":memory:");
    upsertAgent(db, { id: "boss", name: "Boss", role: "orchestrator", workspace: "shared" }, 1);
    upsertAgent(db, { id: "boss", name: "Boss v2", role: "orchestrator", workspace: "shared" }, 2);
    expect(listAgents(db)).toEqual([
      { id: "boss", name: "Boss v2", role: "orchestrator", workspace: "shared", updatedAt: 2 },
    ]);
  });
});

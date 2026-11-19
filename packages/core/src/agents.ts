import type { Db } from "./db/database.ts";

export interface AgentRecord {
  id: string;
  name: string;
  role: string;
  workspace: string;
  updatedAt: number;
}

/** Mirrors an agent manifest into the DB (tasks reference agents by id). */
export function upsertAgent(
  db: Db,
  a: { id: string; name: string; role: string; workspace: string },
  now = Date.now(),
): void {
  db.prepare(
    `INSERT INTO agents (id, name, role, workspace, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, role = excluded.role,
       workspace = excluded.workspace, updated_at = excluded.updated_at`,
  ).run(a.id, a.name, a.role, a.workspace, now, now);
}

export function listAgents(db: Db): AgentRecord[] {
  return db
    .prepare("SELECT id, name, role, workspace, updated_at FROM agents ORDER BY id")
    .all()
    .map((r) => ({
      id: r.id as string,
      name: r.name as string,
      role: r.role as string,
      workspace: r.workspace as string,
      updatedAt: Number(r.updated_at),
    }));
}

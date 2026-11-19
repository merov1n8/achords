-- Inter-agent delegation (ADR-0029). The status CHECK is left as is: rebuilding a table that
-- runs reference by foreign key is risky; "waiting for children" is a counter instead.
ALTER TABLE tasks ADD COLUMN root_id TEXT;
ALTER TABLE tasks ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
-- JSON array of the agents that delegated down to this task, root first (cycle detection).
ALTER TABLE tasks ADD COLUMN agent_chain TEXT NOT NULL DEFAULT '[]';
-- Only on root tasks: one budget for the whole chain.
ALTER TABLE tasks ADD COLUMN budget_usd REAL;
ALTER TABLE tasks ADD COLUMN spent_usd REAL NOT NULL DEFAULT 0;
-- Children still running; a task with waiting children is not claimable.
ALTER TABLE tasks ADD COLUMN waiting_children INTEGER NOT NULL DEFAULT 0;
CREATE INDEX tasks_parent ON tasks (parent_id);

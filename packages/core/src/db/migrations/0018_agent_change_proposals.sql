-- Changes to existing agents (ADR-0041): the file state the proposal was made against.
ALTER TABLE agent_proposals ADD COLUMN base_hash TEXT;

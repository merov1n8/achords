-- ADR-0066 part 1: the stall watcher notices a root chain once per stall. Both columns live on
-- the root. stall_reason is 'idle' or 'spend'; 'spend' stays once given, because that notice
-- fires once per root (an idle notice after it only moves stall_noticed_at).
ALTER TABLE tasks ADD COLUMN stall_noticed_at INTEGER;
ALTER TABLE tasks ADD COLUMN stall_reason TEXT;

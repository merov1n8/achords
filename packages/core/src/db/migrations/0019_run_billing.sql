-- Phase 4 spend meters: who paid for a run, and its tokens (cost needs a price list for some CLIs).
ALTER TABLE runs ADD COLUMN billing TEXT NOT NULL DEFAULT 'subscription';
ALTER TABLE runs ADD COLUMN input_tokens INTEGER;
ALTER TABLE runs ADD COLUMN output_tokens INTEGER;
ALTER TABLE runs ADD COLUMN cached_tokens INTEGER;

-- Sensitivity routing (ADR-0007): local-only threads and tasks never reach a frontier model.
ALTER TABLE threads ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal'
  CHECK (sensitivity IN ('normal', 'local-only'));
ALTER TABLE tasks ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal'
  CHECK (sensitivity IN ('normal', 'local-only'));
-- A task waiting for a resource (e.g. the local model server) is not claimed before this time.
ALTER TABLE tasks ADD COLUMN not_before INTEGER;

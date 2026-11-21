-- A card the owner made by hand and has not started yet: no worker may claim it until the
-- owner starts it (it is un-parked and moved to the workflow's start column).
ALTER TABLE tasks ADD COLUMN parked INTEGER NOT NULL DEFAULT 0;

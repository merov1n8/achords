-- ADR-0066 part 4: a room closes with a recorded outcome {decision, decided_by, open_points}
-- (JSON), posted as a comment on the card of the opener's root. Comments by the owner keep a
-- NULL author; an outcome comment names the opener agent and its room.
ALTER TABLE rooms ADD COLUMN outcome TEXT;
ALTER TABLE task_comments ADD COLUMN author TEXT;
ALTER TABLE task_comments ADD COLUMN room_id TEXT;

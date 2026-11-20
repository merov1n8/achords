-- Integration monitors (ADR-0039, 5b): the last result, to tell what is new.
ALTER TABLE monitors ADD COLUMN last_result TEXT;

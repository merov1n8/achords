-- The owner's own name for a Kanban card (one card per chat, ADR-0059). NULL: the card shows its
-- chat's title. Carried to the task that takes the card over, so a rename sticks.
ALTER TABLE tasks ADD COLUMN card_title TEXT;

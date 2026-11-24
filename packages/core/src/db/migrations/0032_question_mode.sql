-- Question mode: the owner only asked something. The run only reads, whatever the agent's level,
-- and a successful answer moves its card straight to done, without checks or review.
ALTER TABLE tasks ADD COLUMN question_mode INTEGER NOT NULL DEFAULT 0;

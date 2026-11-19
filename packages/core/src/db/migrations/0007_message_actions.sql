-- Messages can offer actions (e.g. Approve / Reject); channels render them as buttons.
-- JSON array of {"label": "...", "data": "<kind>:<verb>:<id>"} (data fits Telegram's 64 bytes).
ALTER TABLE messages ADD COLUMN actions TEXT;

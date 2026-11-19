# ADR-0027: Telegram is bound to one owner user id; everyone else is ignored

Status: Accepted (2026-11-19)

- Context: The Telegram bot is reachable by anyone who finds it. It can start agent work and trigger an emergency stop.
- Decision: The bot token lives in the vault (`telegram.bot-token`); the channel only starts when it is set. `achords pair telegram` prints a one-time code (same mechanism and lockout as ADR-0026); `/pair <code>` in a private chat binds the owner by Telegram user id (`from.id`), not just chat id. Only private chats are accepted. Messages from anyone else, wrong codes and group chats get no reply at all, only a log line (the bot does not reveal that pairing exists). The owner's `/stop` writes the STOP marker, pauses the queue and kills active runs (same core code as `achords kill`); `/new` starts a new thread. Only agent messages are sent back (quiet output); the update offset advances before handling, so a bad message cannot be replayed forever. The token is never part of a logged error.
- Consequences: Re-pairing needs host access (a new code). Voice notes come in Phase 2.

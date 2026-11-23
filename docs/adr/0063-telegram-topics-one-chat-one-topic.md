# ADR-0063: Telegram topics: one chat, one topic

Status: Accepted (2026-11-23). Extends ADR-0013.

- Context: Web and Telegram are meant to be two views of the same chats (ADR-0013), but Telegram had one "current" chat: it delivered only that chat's replies, `/new` replaced it, and nothing started on the web could be seen or continued there. Since Bot API 9.3 and 9.4 a bot's private chat can have forum topics ("Threaded mode" in @BotFather): the bot can create, rename and delete them and gets `message_thread_id` on what the owner writes in one.

- Decision:
  - With the bot's forum topic mode on (`getMe.has_topics_enabled`, asked again every ten minutes), each chat has its own topic. Off, everything works as before; the owner turns the mode on in @BotFather, Achords does not.
  - Outward: one cursor over all chats. A chat's agent messages go into its topic; the bot creates the topic, named after the chat, the first time the chat has anything new, and says there that the chat continues from the web when it does. When the mode is first seen, nothing old is replayed and the chats active within the keep period (at most 20) get their topic at once, so they can be continued from the phone.
  - Inward: a message in a topic goes to that topic's chat. A topic the bot does not know was opened by the owner: it starts a new chat with the topic's name, and renaming the topic renames the chat. Messages outside any topic stay the one chat Telegram had before. `/project` and `/local` apply to the chat of the topic they are sent in; replies and button answers go back into the same topic.
  - Local-only and archived chats get no topic, and rooms never do. A local-only chat's messages are not sent to Telegram unless the chat already has a topic (the owner made it local-only from there).
  - Idle topics are deleted after `telegram.topic_days` days (default 7; empty keeps them), checked hourly; a topic whose chat still offers the owner a decision stays. The chat itself is untouched: when it moves again it gets a new topic. A private-chat topic cannot be closed through the Bot API, only deleted, so the earlier Telegram messages go with it and the web keeps the history.
  - A topic deleted by hand in Telegram is made again on the next message instead of the message being lost. If Telegram refuses to create a topic, the message is sent outside topics under the chat's name, and the refusal is logged.
  - The mapping is a table, `telegram_topics` (chat, topic, last activity), with a row only while the topic exists.

- Consequences: The phone shows every chat in use, each in its own lane with Telegram's own unread marks, and a new topic there is a new chat everywhere. The owner's own messages written on the web are not echoed into the topic (quiet output, ADR-0013), so a topic reads as the agents' side plus what was typed in Telegram. Many active chats mean many topics; the keep period bounds them. The feature depends on a recent Bot API and on Telegram offering topics for the owner's account; without them nothing changes.

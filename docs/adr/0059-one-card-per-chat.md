# ADR-0059: One card per chat

Status: Accepted (2026-11-23)

- Context: Every piece of work the boss gave out became a card of its own (ADR-0030), so a chat about one feature filled the board with a card per follow-up message ("fix it", "commit it", "move the block"). The owner thinks in chats: one chat is one ticket, and a separate ticket only when asked for.

- Decision:
  - When the boss gives out work in a chat that already has a card (its newest top-level task on the board), the new task takes the card over: the card moves to the workflow's start column on the new task, with its checklist, comments and move history; the earlier task leaves the board and stays in the database and the chat (`takeOverCard`).
  - The boss's decision has `new_card`: true only when the owner explicitly asks for a separate card; then the work gets a card of its own, which from then on is the chat's card.
  - A handoff successor (ADR-0055) carries the caller's card on the same way, instead of the caller's card going to review and a second card appearing.
  - Delegated sub-tasks never had cards; cards made by hand on the board are unchanged.

- Consequences: The board shows one card per chat, titled after the newest step; earlier steps are read in the chat. A card that was done goes back to the start column when the chat asks for more work, so the review step (ADR-0030) sees the newest work. Earlier tasks keep `board_column` NULL; deleting the card deletes only the newest task's tree.

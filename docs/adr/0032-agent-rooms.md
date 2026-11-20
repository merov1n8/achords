# ADR-0032: Agent rooms (bounded discussions between agents, hidden by default)

Status: Accepted (2026-11-20)

- Context: Delegation (ADR-0029) is one-way: one agent asks, another answers. Some questions need several agents to think together (e.g. developer, QA and marketing agreeing on a landing page). The owner does not want to follow these discussions, but they cost quota and can carry injected instructions from one agent to another.
- Decision:
  - A hub tool `open_room` lets an agent open a discussion: topic, question, 1–3 participants, 1–3 rounds. Each participant must be one the opener may delegate to (both sides of ADR-0029: `can_delegate_to` / `accepts_from`; the boss implicitly).
  - The discussion runs as sequential child tasks ("turns") of the opener's task: in each round every participant speaks once, in order, seeing the transcript so far. Turns are read-only: the participant's own read tools only (`Read`, `Glob`, `Grep`), no shell, no writes, no hub tools (no delegation, no nested rooms, no questions to the owner). The chain's shared budget, depth limit and sensitivity (local-only stays local-only) apply as for any child task.
  - When the last turn is done the opener resumes with the transcript and writes the decision; its result is appended to the room as the closing message.
  - Hidden by default (maintainer decision): a room is a separate thread of kind `room`, never listed among the owner's chats, never relayed to Telegram, no notifications. The owner can open every room in a read-only audit view (web: Settings › Agent rooms) for cost control and forensics.
- Consequences: Agents can agree on things without the owner relaying messages; the cost is bounded (≤ 9 short read-only turns, shared budget). A turn that finally fails ends the room early; the opener resumes with what was said.

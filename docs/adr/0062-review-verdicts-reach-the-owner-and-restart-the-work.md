# ADR-0062: A review's verdict reaches the owner, and a card sent back restarts its work

Status: Accepted (2026-11-23). Amends ADR-0030.

- Context: A finished card goes to review and the workflow gives it to an agent with the reviewing role as a sub-task of the card (ADR-0030). A sub-task's result goes to its parent, but the parent has already finished, so the verdict was stored and shown nowhere. When the reviewer moved the card back to the start column, only the column changed: the card's agent was not started and never saw the findings. The owner saw the developer's "done", then silence, with the card in "in progress" and nobody working on it.

- Decision:
  - When a workflow review ends, its result is posted in the card's chat under the reviewer's name ("Review (qa): …"), whatever the verdict.
  - If the card is then in the workflow's start column (the reviewer sent it back), the card's agent continues: a successor task (as in a handoff, ADR-0055) with the original instructions and the review, on the same card (ADR-0059) and the same task chain, so the budget and the commands approved for the task carry over. The agent also gets its own earlier report. Finished again, the card returns to review as before.
  - After three reworks a further send-back starts nothing: the chat says the card waits for the owner. Two agents that never agree must not pass a card back and forth unattended.
  - A reviewer that moves the card nowhere changes nothing but the chat: the card stays in review for the owner.

- Consequences: The develop, review, fix loop runs without the owner, who reads each verdict in the chat and steps in only when it stalls. Every rework is a full agent run, so a strict reviewer costs up to three more runs per card.

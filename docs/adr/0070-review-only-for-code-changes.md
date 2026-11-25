# ADR-0070: Review only for code changes

Status: Accepted (2026-11-25). Amends ADR-0030 and ADR-0065.

- Context:
  - Every successful run lands its card in `finish` (review), and the workflow hands it to a QA
    agent. Work that changes no code still went there: asking web-dev to summarise the chat into
    a Markdown file started the code reviewer.
  - Question mode (read-only answers) already skips review, but the summary is work: it writes a
    file.

- Decision:
  - **What changed.** When a card's run starts, the gateway notes the time (once per card until
    the card finishes) and adds the run's write folders (its work folder when it has none);
    delegated runs add theirs to the same card. When the card's root task finishes, the gateway
    lists the files under those folders modified since then (`apps/gateway/src/changed-files.ts`).
    It skips `.git`, `node_modules` and generated folders (`Library`, `Temp`, `Logs`, `obj`,
    `UserSettings`, `__pycache__`, `.venv`).
  - **What is code.** Every file except documents and media (`.md`, `.txt`, `.rst`, `.adoc`,
    `.pdf`, `.docx`, images, audio, video, `.DS_Store`). A file without an extension is code.
  - **No code changed** (only such files, or nothing): the card goes straight to the column after
    `finish` as a system move, like a question-mode answer, with no checks or review. The chat
    says so.
  - **When it cannot tell, it reviews**: a folder with more than 50,000 files, or a card whose
    start the gateway did not see (a restart in between).

- Consequences:
  - Summaries, notes and reports no longer wake the reviewer.
  - Change is found by modification time, so files outside git count too. Deleting or moving a
    file keeps no new time: a run that only deletes code skips review.
  - Anything else writing in the same folders during the run (an open Unity editor regenerating
    `.csproj` files, the owner's own edits) counts as the run's change and starts a review.
  - A manual per-chat switch for the reviewer was considered and parked until this rule proves
    not enough.

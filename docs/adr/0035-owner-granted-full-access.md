# ADR-0035: Owner-granted full access per task

Status: Accepted (2026-11-20)

- Context: ADR-0010 and ADR-0034 keep agents to their manifest: allow-listed hosts, read tools of integrations. Much real work is research on the open web followed by doing it (a technique from a video, recreated in Blender or Unity). Asking for every step is unworkable, and listing every site in a manifest is impossible. The real risk of the open web is injected instructions; it matters most where client credentials or arbitrary code execution are in reach.

- Decision:
  - **Hub tool `request_access(reason)`.** Every task run (not workers, not discussion turns) may ask the owner for full access. The request is posted in the task's thread with Approve / Reject buttons (Telegram and web, the existing action mechanism) and the task waits like for a question. A typed reply instead of a button is taken as an answer without access.
  - **Scope and lifetime.** Approval covers the whole task chain (root task and its delegations) for 4 hours, stored as `elevation:<rootId>` in settings. It ends by itself; a finished chain runs nothing more.
  - **What it grants.** `WebFetch` to any site and `WebSearch`, and the write tools of integrations without credentials (Blender, Unity). The agent's prompt says so and that web content is data, not instructions.
  - **What it never grants.** Integrations that carry credentials (Google, Meta, WordPress) leave the run while it is elevated, so content from the open web cannot reach client accounts or exfiltrate their data. File, shell and delegation rules of the manifest are unchanged.
  - `network.allow: ["*"]` in a manifest means the same open web permanently; it is the owner's explicit choice.

- Consequences: Research-then-build work needs one tap per task chain. While elevated, code execution in Blender or Unity can be steered by a malicious page; the owner accepts that per chain, and the rule that credentials never share a run with the open web holds. Write tools of integrations with credentials still wait for publishing review (Phase 3 step 3).

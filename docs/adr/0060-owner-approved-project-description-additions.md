# ADR-0060: Owner-approved additions to a project description

Status: Accepted (2026-11-23)

- Context: The owner told the boss a lasting fact about a project ("this is a Unity mobile game") and asked for it to be noted in the project description. The boss has no tools, so it handed the edit to a sub-agent, which has no write access to `projects/<slug>/PROJECT.md` either and would have spent a full run on one line. PROJECT.md is part of every prompt for the project's work, so what goes into it must stay the owner's decision.

- Decision:
  - The boss gets a fifth action, `update_project`: the text to append to the description of the chat's project. It cannot name another project, replace or remove text, or touch `project.yaml`. The same `project_update` field may accompany any other action, because one message often both states a fact and asks for work.
  - The gateway posts the exact text with Approve / Reject and writes nothing until approval. The pending request lives in settings, like a pending command (ADR-0056).
  - The request stores the hash of the description it was made against; approval appends the text atomically only if the description is still the same, otherwise it asks for a new proposal. Approve works once.

- Consequences: Noting a fact costs no extra model run and gives no agent write access to project folders. Larger edits stay in Settings, by hand.

# ADR-0041: Owner-approved changes to existing agents

Status: Accepted (2026-11-20)

- Context: The owner wants to say "give social access to Meta" instead of editing agent.yaml by hand. Agents could already propose new agents (`propose_agent`, owner approval). Changing an existing agent widens or narrows its rights, so it must stay the owner's decision.

- Decision:
  - The boss gets a fourth action, `change_agent`: an agent id, entries to add or remove per list field (`mcp`, `tools`, `fs_read`, `fs_write`, `network`, `shell`, `delegate_to`, `accept_from`, `models`), an optional default model, and the reason. Its prompt lists each agent's current settings and the catalog's integration ids.
  - The gateway applies the patch to the YAML text (comments and layout kept), validates the result as a manifest, and posts the diff in plain words ("integrations: + meta", "shell commands: − npm test") with Approve / Reject. Fields outside the lists (budget, sensitivity, publish mode, workspace) cannot be changed this way.
  - The proposal stores the hash of the file it was made against; approval writes the new file atomically only if the file is still the same, otherwise it asks for a new proposal. Approve works once.

- Consequences: Rights change only through an explicit owner approval of a visible diff; a stale proposal can never overwrite a newer manual edit. Agents other than the boss still cannot change agents.

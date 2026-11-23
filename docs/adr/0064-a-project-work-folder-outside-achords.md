# ADR-0064: A project's work folder may be outside Achords

Status: Accepted (2026-11-23). Amends ADR-0031.

- Context: A project's runs start in `$ACHORDS_HOME/projects/<slug>/files/` (ADR-0031), which fits client code cloned there. A game's Unity project, or any repository the owner also works in with other tools, lives elsewhere and cannot be expected to move under Achords. Its agent then started in an almost empty `files/`: the repository was only a second folder (ADR-0061), and the apps Achords opens for a run (ADR-0054) looked for the Unity project in `files/`, found none and did not open Unity, so the agent could neither compile nor test what it wrote.

- Decision:
  - `project.yaml` may name `workdir`: a full path, or one starting with `~/`. Runs of the project's workspace agents then start there, with it as their first write folder; `files/` stays a folder of the run, for the owner's briefs and hand-overs. Apps are opened for that folder.
  - Agents of other workspaces get the project's text and no folder, as before.
  - `workdir` is written by hand in `project.yaml`, like the folder lists of an agent: it opens a folder of this Mac to agents, which no agent and no web form should do. Saving the project from the web form keeps it.

- Consequences: A project can be a repository anywhere on the Mac, and its agent works in it the way a person at a terminal would. Nothing checks that the folder exists or holds what the project says; a wrong path shows at the first run.

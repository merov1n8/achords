# ADR-0061: Shell commands in any of an agent's work folders

Status: Accepted (2026-11-23). Amends ADR-0031.

- Context: An agent's folders are its `fs.write` list (edited in the agent form or by an approved agent change, ADR-0041), plus the project's `files/` for a project task (ADR-0031), which is also where the run starts. Files in every folder were reachable, shell commands were not: a game developer agent started in its project's `files/`, the game's Unity repository was a second folder, and its allow-listed `git add` and `git commit` could not run there. The CLI refuses `cd <repo> && git …` (a directory change joined to a git command) and `git -C <repo> …` does not match the allow-list entry, so the owner approved commands that then still "required approval". A Unity or WordPress repository cannot be expected to live under `$ACHORDS_HOME`.

- Decision:
  - Every folder in `fs.write` is a work folder of equal standing: readable, writable, and a place to run the agent's allowed shell commands. Attaching a second or third folder is adding it to that list; no new setting.
  - The run still starts where ADR-0031 says (the project's `files/`, otherwise the agent's first folder). A Claude run of an agent with a shell and more than one folder is told in its prompt where the shell starts, which other folders it has, and how to move: `cd "<folder>"` as a command of its own, then the command exactly as allowed. The CLI lets a run change into its own folders and keeps the shell there, so allow-list entries and commands approved in the chat (ADR-0056) match unchanged.
  - Nothing is added to the permission rules. The allow-list stays a list of commands, not of command-and-folder pairs, and it applies in each of the agent's folders.

- Consequences: An agent can commit in a repository outside `$ACHORDS_HOME` once the folder and the commands are on its lists. An allowed command is allowed in all of the agent's folders, so a folder should be attached only to agents meant to run their commands there. Codex and Gemini runs keep their own shell rules and get no note.

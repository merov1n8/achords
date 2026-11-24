# ADR-0067: Permission levels, remit and project class instead of per-agent lists

Status: Accepted (2026-11-24). Amends ADR-0010, ADR-0011, ADR-0034, ADR-0035, ADR-0036, ADR-0042, ADR-0047, ADR-0051, ADR-0056 and ADR-0061.

- Context:
  - **What exists today.** Every agent's rights are hand-written lists in `agent.yaml`, a strict zod manifest (ADR-0010):
    - `tools`;
    - `shell.allow`: command prefixes; no key means no shell;
    - `network.allow`: hosts, host/path or `"*"`;
    - `fs.read` and `fs.write`;
    - `mcp`: catalog ids;
    - `container`: defaults to on with `"*"`;
    - `models`;
    - `publish_mode`;
    - `budget`: only `per_run_usd` is enforced;
    - `sensitivity`;
    - `delegation`.
  - **How a run is compiled.** `runTask` loads the manifest. It adds the project's folders (ADR-0031, ADR-0064), project sites (ADR-0057) and chat images. It then trims for discussion turns, workers, codex/gemini, elevation (ADR-0035) and keyed integrations (ADR-0034, ADR-0055). `allowRules` turns the result into CLI permission rules.
  - **Exceptions to the lists:**
    - Shell commands approved in the chat (ADR-0056): "this task" allows the exact command for the chain for 4 h; "always" adds a prefix to `shell.allow`. There is no "always" for `git push` or `gh`.
    - Full access (ADR-0035) is granted per chain for 4 h.
  - **Projects** have a name, a workspace, `integrations` (account and site lists per channel), `publish` and `workdir`. Work without a project uses the owner's accounts as the pseudo-project `own` (ADR-0042). Sites are plain URLs.
  - **What does not exist:**
    - a project class;
    - an environment tag;
    - overrides per agent and project;
    - a "for this card" approval;
    - per-tool classes beyond read and write.
  - **What drifts:**
    - Shell lists grow through "always" approvals, including one-off literal commands.
    - `network.allow: ["*"]` keeps keyed integrations in the same run. Two agents hold the open web and client credentials together today.
    - WebSearch is allowed whenever it is listed, whatever `network.allow` says.
    - Claude runs on the host have no sandbox.
    - `git push` from a host shell uses whatever git login the machine has. On the maintainer's development machine that is the owner's own login. Real installs, including the Mac mini, have no git login on the host, so push needs its own path.
  - **Fields the levels replace or keep:**

    | Manifest field | Under levels |
    |---|---|
    | `tools`, `shell`, `network`, `container` | **Replaced.** Compiled from the level and removed from manifests. |
    | `fs.read`, `fs.write` | **Kept** as remit: folders. |
    | `mcp` | **Kept** as remit: accounts and integrations. The level decides which tool classes. |
    | `models` | **Kept** as remit: model. |
    | `publish_mode` | **Kept**: ADR-0037 is unchanged. |
    | `delegation`, `sensitivity`, `effort`, `budget`, `roles`, `workspace` | **Kept**, unrelated to levels. |

- Decision, core 1: levels. Each level includes everything below it. A level says what the agent may do without asking, inside its own remit.

  | Level | Name | Adds | Compiles to |
  |---|---|---|---|
  | 0 | Off | Receives no work | Not dispatchable. Delegation and card assignment refused. |
  | 1 | Reader | Reads its folders, writes comments and reports | `Read, Glob, Grep` on its folders; hub report and comment tools; project sites (ADR-0057, not the open web) |
  | 2 | Author | Writes files in its folders, reads the web | `Edit, Write` on `fs.write`; `WebFetch, WebSearch`, network `"*"`, under the open-web rule |
  | 3 | Operator | Uses its assigned accounts: read tools, drafts, reversible writes | Remit `mcp` with tools of class `read`, `draft`, `reversible` |
  | 4 | Builder | Free shell in a sandbox, local git, build, test, packages from known registries, local apps | `Bash` with no command list, only inside a sandbox; registry hosts for the shell; local apps (ADR-0054) |
  | 5 | Full | `git push` (never force), writes and deploys to live targets, spending inside the account's own limit | Tools of class `live` and `spend`; push through the gateway's credential helper |

  - The boss has no level. It has no tools, and `change_agent` and `update_project` stay owner-approved (ADR-0041).
  - **Tool classes.** Every catalog tool gets one class: `read`, `draft`, `reversible`, `live` or `spend`. All entries in the catalog are classified when this ships. A tool without a class counts as `live`.
  - **Spending limit.** Achords keeps no spending cap of its own. "Inside the account's limit" means the limit set at the third-party service, such as a Google Ads monthly budget or a fal.ai credit balance. ADR-0046 meters stay as they are.

- Decision, core 2: project class

  | | `secured` | `experimental` |
  |---|---|---|
  | Meant for | Work where a mistake costs someone else: clients, production systems | The owner's own trials, where speed matters more than safety |
  | Ceiling (default) | 4 | 5 |
  | Targets tagged `live` | Read-only at every level. No level, override or approval in a run can lift it. | Writes follow the level. |
  | Writes go to | `staging` targets only | Per level |
  | Work meant for live | A prepared package (diff or export, plus a checklist) for the owner to deploy | Done by a level 5 agent |
  | Spending | Always asks | Asks, unless the project's "spend without asking" switch is on |

  - **Choosing a class.** The owner sets the class per project. There is no automatic migration of existing projects. Until a class is chosen, a project counts as `secured`. The project form shows it as "not chosen yet". New projects must choose.
  - **Work without a project** (the `own` pseudo-project of ADR-0042) is `experimental`.
  - **Environment tags.** Every account and site carries `env: live | staging`. Existing and new entries start as `live`, and the owner switches a row to `staging` in the project form.
  - **Explanations in the UI.** The project form explains both classes in one or two plain sentences each. The level picker in the agent form shows a one-line meaning per level. These texts are part of the feature, written for owners who did not read this ADR.

- Decision, core 3: effective level
  - **Rule.** `effective = min(override(agent, project) ?? base(agent), ceiling(project))`.
  - **Overrides** are set per agent and project. They may raise the level only on `experimental` projects; they may lower it anywhere.
  - **Required skills.** An override may name skills (ADR-0049). If any of them is not enabled, the base level applies.
  - **Compilation.**
    - `effective` is computed once per run, right after the project folders are added, and compiles into the existing fields (tools, shell, network, container, mcp tool lists).
    - Everything after that point reads the result, as do the four paths that read the raw manifest today: the shell request check, delegation refusal, the boss's agent listing and `GET /api/agents/:id`.
    - The policy engine stays one mechanism.

- Decision, remit. Set per agent, independent of the level:
  - folders: `fs.read`, `fs.write`;
  - accounts and integrations: `mcp`;
  - model: `models`.

  Nothing else is per agent. A capability with nothing assigned opens nothing.

- Decision, guards that hold at every level
  - **Open web and accounts never share a run.**
    - A run with the open web (WebFetch to any host, WebSearch, elevation) gets no account tools of class `draft` and above.
    - Work that needs both is split into two runs with a handoff (ADR-0055).
    - Project sites read under ADR-0057 are not the open web.
  - **A shell exists only in a sandbox:**
    - in the Apple container (ADR-0051);
    - or, on the host, in the Claude CLI's own sandbox: writes are limited to the run's folders and network to the registry hosts and the run's allowed hosts.
    - Without either, level 4 compiles to 3, and the chat says why.
    - Host tools that do not work inside the CLI sandbox (Unity batch mode, Xcode) are found during implementation and reported. They are not exempted silently.
  - **Keys stay behind the gateway** (ADR-0055).
    - `git push` at level 5 goes through a git credential helper answered by the gateway, the use-without-read mechanism ADR-0055 left open. Its credentials are per project, in the vault.
    - No push credential is ever placed in the run. A host git login on a development machine is not a supported path.
    - Force push and history rewrite are refused at every level.
  - **Local models** are capped at level 3, with no open web. Today the local provider takes no tools, so the cap takes effect once local tool use exists.
  - **Unchanged:**
    - publishing review or auto per channel (ADR-0037);
    - ADR-0029 delegation guards;
    - ADR-0055 limits;
    - sensitivity routing (ADR-0007).

- Decision, when an agent asks
  - **Asking is triggered by:**
    - something outside its remit: another folder, account or project;
    - a capability above its effective level;
    - the always-ask list: force push or history rewrite, deleting outside its folders, spending on a `secured` project, a new paid service, reading keys, changing permissions.
  - **Scopes.** These replace ADR-0056's task/always and ADR-0035's 4 h chain grant.

    | Scope | Lasts | Stored as |
    |---|---|---|
    | once | One action | Nothing kept |
    | for this card | The card's tasks, until the card is done | `approval:<card>` |
    | always | Permanently | Extends the remit (a folder or account) or sets an override, through an ADR-0041 patch. The same question is not asked twice. |

  - **Limits on approvals:**
    - No approval lifts the `secured` live rule.
    - "always" is not offered for always-ask items.
    - "always" cannot raise a `secured` project above its ceiling.

- Decision, starting assignment (approved by the owner on 2026-11-24, including where it widens rights)

  | Agent(s) | Level | Change against today |
  |---|---|---|
  | code-reviewer, game-reviewer | 1 | None. |
  | marketing | 2 | Loses its shell and its keyed account. Account work goes to a level 3 agent by handoff. |
  | seo, social, advertiser | 3 | Lose their utility shells. seo no longer mixes the open web with accounts. Spending asks. |
  | web-dev | 4 | Gains build and packages. Its host shell moves into the CLI sandbox. |
  | wp-maintainer | 4 | Gains a free shell, commit, build and packages. |
  | game-dev | 4 | Its host shell moves into the CLI sandbox. Local apps stay. |
  | 3d-designer | 4 | Gains a shell. |
  | video-producer | 4 | None. Spending asks. |
  | boss | — | No level. |

  - Agents named in the original assignment that are no longer installed (audio, image) are left out.
  - New agents start at level 1.

- Decision, migration
  - Each agent gets its starting level, and its lists (`tools`, `shell`, `network`, `container`) are removed.
  - A migration report lists for each agent the rights it gains and loses, and the owner confirms it before the files are written.
  - Literal one-off commands collected in `shell.allow` are dropped.
  - An agent not in the table gets the highest level whose rights are a subset of its current ones. It is never widened without the owner's approval.

- Schema changes:
  - **Manifest:**
    - adds `level: 0–5`;
    - removes `tools`, `shell`, `network`, `container`.
  - **project.yaml:**
    - adds `class: secured | experimental`, unset meaning `secured` until chosen;
    - adds `spend_without_asking: bool`, for `experimental` only;
    - account and site entries become `{url|id, env: live|staging}`; a plain string is read as `env: live`.
  - **accounts.yaml:** the same entry shape.
  - **`~/.achords/overrides.yaml`:** `{agent, project, level, requires_skills[]}`.
  - **Catalog:** every tool gets `class`.
  - **Approvals:** `approval:<card>` settings keys.
  - **Vault:** per-project git credentials for the gateway's credential helper.

- UI changes:
  - **Agent edit dialog:**
    - a level picker with a one-line meaning per level;
    - the remit (folders, accounts and integrations, models);
    - overrides per project;
    - an "Effective level" section listing each project with its effective level and why (base, override, ceiling, or a missing skill or sandbox).
    - Tool checkboxes and the shell, network and container fields are gone.
  - **Project form:**
    - the class, with its explanation;
    - the ceiling (read-only);
    - the "spend without asking" switch (`experimental` only);
    - a `live`/`staging` toggle on each account and site row.
  - **Approval buttons:** once, this card and always, with "always" hidden where it is not allowed.

- Tests:
  - **Ceiling:** a level 5 agent on a `secured` project runs as 4. An unset class counts as `secured`. `experimental` allows 5.
  - **Overrides:**
    - On `secured`, an override can only lower; raising is refused at save.
    - On `experimental`, it can raise.
    - With a required skill disabled, the base level applies.
  - **Live rule:** a `live` or untagged target on a `secured` project is read-only at levels 0–5, under every approval scope and with an override. A `staging` target is writable from level 3.
  - **Open-web split:** a run with WebSearch or `"*"` gets no draft-or-above account tools at any level. The handoff to an account run works.
  - **Sandbox:**
    - Level 4 without a container or CLI sandbox compiles to 3, with a message.
    - With either, the run gets a free shell.
    - Host-sandbox writes outside the run's folders are refused.
  - **Push:** level 5 push goes through the credential helper. Force push is refused at every level. Level 4 has no push.
  - **Local models:** capped at 3, with no web.
  - **Approval scopes:**
    - "once" covers one call.
    - "this card" covers the card's later tasks and ends when the card is done.
    - "always" writes the remit or override, and the question is not asked again.
    - None of them lifts the live rule.
    - "always" is not offered for force push.
  - **Migration:**
    - Every fixture manifest maps to its level, and the report lists gains and losses.
    - An agent outside the table is never widened.
    - One-off literals are dropped.
  - **Compilation:** the `effective` output feeds the existing `allowRules`, and Codex and Gemini profiles are unchanged for equal inputs.

- Consequences:
  - One number and a short remit replace five hand-kept lists, and rights stop growing by accident.
  - Live systems of `secured` projects cannot be written by construction; deployment to them is an owner step with a prepared package.
  - The open web and credentials are separated for manifest-granted web too.
  - Shells move into sandboxes. Host tools that do not run in the CLI sandbox surface as reported gaps instead of silent exceptions.
  - Several agents gain rights by the owner's decision (wp-maintainer, 3d-designer, web-dev), and the utility shells of the marketing group go away.
  - Push no longer depends on the machine's git login.

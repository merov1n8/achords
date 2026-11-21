# Operations

## First-time setup

```sh
pnpm install && pnpm build
pnpm achords init      # checks, optional Telegram token, starts the service, prints pairing codes
pnpm achords doctor    # re-check anytime; every problem comes with a fix
```

`init` changes nothing if a prerequisite fails, and is safe to re-run (existing secrets are kept unless you choose to replace them).

## Control commands

Run from the repo root during development (`pnpm achords <command>`), or as `achords <command>` once installed.

| Command  | What it does                                                                                                                                                                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`  | Installs/refreshes the service (macOS: launchd job `~/Library/LaunchAgents/dev.achords.gateway.plist`; Linux: systemd user unit `achords-gateway.service`) and starts the gateway. Waits up to 5 s for it to come up; if it does not, unloads the job again and points to the log. Refused while an emergency stop is active. |
| `stop`   | Graceful stop: unloads the service (SIGTERM). Queue state is kept.                                                                                                                                                                                                                                                            |
| `kill`   | **Emergency stop.** Writes the STOP marker, unloads the service, SIGKILLs the gateway and every running agent's process group, pauses the queue, marks runs cancelled. Works with a hung or dead gateway.                                                                                                                     |
| `resume` | Clears the STOP marker and unpauses the queue. Does not start the gateway.                                                                                                                                                                                                                                                    |
| `status` | Service, gateway PID, heartbeat age, queue, emergency stop, active runs.                                                                                                                                                                                                                                                      |

All state lives under `$ACHORDS_HOME` (default `~/.achords`): `core.db`, `run/gateway.pid`, `run/STOP`, `logs/gateway.log`.

## Web UI

Build it once (and after updates): `pnpm build`. Then open http://127.0.0.1:7420, run `pnpm achords pair web` and enter the code. For UI development: `pnpm --filter @achords/web dev` (Vite on :5173, proxying `/api` to the running gateway).

## Pairing a browser and storing secrets

```sh
pnpm achords pair web                       # prints a one-time code (10 min); enter it in the web UI
pnpm achords secret set telegram.bot-token  # value is typed hidden (or piped), never an argument
pnpm achords secret list                    # ids, last 4 chars (12+ char values only), dates
pnpm achords secret rm telegram.bot-token
```

The API listens on `http://127.0.0.1:7420` (`ACHORDS_PORT` to change). Five wrong pairing codes within 15 minutes lock pairing and invalidate all open codes; create a new one afterwards. Safari may refuse the `Secure` session cookie on plain `http://localhost`; use Chrome/Firefox locally or the Tailscale HTTPS URL. Paired devices can be listed and revoked (`GET/DELETE /api/devices`, web UI in step 7).

On macOS the vault's master key is in the login Keychain (item `achords` / `master-key`). `ACHORDS_KEYSTORE=file` uses `$ACHORDS_HOME/master.key` (0600) instead, e.g. on headless hosts.

## Connecting Google (Analytics, Search Console)

Once per owner, not per client: clients add your Google account to their GA4 property (Viewer)
and Search Console site, and the one sign-in reaches all of them.

1. Google Cloud Console, your project: enable the Google Analytics Data API, Google Analytics
   Admin API and Google Search Console API.
2. OAuth consent screen: set the publishing status to "In production" (in "Testing" Google
   revokes the refresh token after 7 days). Verification is not needed for own use; the sign-in
   shows "Google hasn't verified this app": Advanced → Go to ….
3. Create an OAuth client of type "Desktop app" and download its JSON.
4. Web: Settings → Integrations → Shared sign-ins → **Add sign-in** → Google. Choose (or paste)
   the JSON, then **Sign in with Google**; sign in in the new tab and tick every box. Google sends
   the browser back to `http://127.0.0.1:<port>/api/oauth/google/callback` on the gateway (ADR-0048).
   On a phone or another computer that page shows an error: copy its whole address into the box
   in the dialog and press **Finish sign-in**. A started sign-in is valid for 10 minutes.
   Terminal alternative: `pnpm achords connect google ~/Downloads/client_secret_….json`.
   Either way the client and refresh token land in the vault (`google-client-id`,
   `google-client-secret`, `google-refresh-token`, `google-project-id`); delete the JSON
   afterwards. **Revoke** on the GA4 or Search Console row deletes these four (both stop working).
5. Per client project, name its own property and site in `~/.achords/projects/<slug>/project.yaml`
   (agents see nothing else, ADR-0036):

   ```yaml
   integrations:
     ga4: ["324490876"]                      # GA4 property id (Admin → Property details)
     search-console: ["sc-domain:example.com"] # exactly as Search Console lists it
   ```

## Meta and other token sign-ins

Web: Settings → Integrations → **Add sign-in** → Meta, paste the long-lived Page/User token
(stored as `meta-access-token`, never shown again). Terminal: `pnpm achords secret set
meta-access-token`. **Revoke** on the row deletes the token.

## Media services (ElevenLabs, Meshy, fal.ai)

Web: Settings → Integrations → **Add sign-in** → the service, paste its API key (never shown
again). Terminal: `pnpm achords secret set <id>`. Where to get the key:

- ElevenLabs (`elevenlabs-api-key`): elevenlabs.io/app/settings/api-keys → Create API key.
  Needs `uvx` (uv). Generated audio is saved in the agent's working folder.
- Meshy (`meshy-api-key`): meshy.ai/settings/api → create an API key. Needs `npx` (Node.js).
  Downloads go to `meshy_output/` in the agent's working folder.
- fal.ai (`fal-api-key`): fal.ai/dashboard/keys → Add key; paste the whole `key_id:key_secret`.
  Nothing to install (hosted server, reached over HTTPS).

Every call that costs credits is a write tool: in review mode (default) it is sent to you in the
chat with Approve / Reject and runs exactly as shown; with `publish_mode.channels.<id>: auto` in
the agent's `agent.yaml` it runs right away and is reported in the chat. Use **Test** on the row
to check the key (a free balance or catalog call). Agents with a shell never get these keys.

## Apps on this computer (Blender, Unity)

Web: Settings → Integrations → Apps on this Mac → **Add app**: pick the app, check that its
program is found (the dialog shows how to install it otherwise) and tick the agents that may use
it. This writes their `agent.yaml` `mcp` list (validated first, comments kept); **Edit** changes
the agents, **Remove** takes the app from every agent. Terminal alternative: add the id to `mcp:`
in `~/.achords/agents/<id>/agent.yaml`.

## WordPress

A project can have several sites (ADR-0047); each has its own WordPress user and application
password (Users → Profile → Application Passwords).

1. List the sites in `~/.achords/projects/<slug>/project.yaml` (or through the web / API,
   `POST /api/projects/<slug>/sites/wordpress` with `{"url": "https://…"}`; own accounts: `own`):

   ```yaml
   integrations:
     wordpress: ["https://acme.example", "https://shop.acme.example"]
   ```

2. Per site, `<site>` being the address without `https://`, lowercased, other characters as dashes
   (`GET /api/projects/<slug>/sites/wordpress` shows the exact ids and which are missing):

   ```sh
   pnpm achords secret set wordpress-user-acme-shop-acme-example
   pnpm achords secret set wordpress-password-acme-shop-acme-example
   ```

   The older `wordpress-user-<slug>` / `wordpress-password-<slug>` still work for the first site.
   A site without credentials is left out of runs; the others work.

## Telegram

1. Create a bot with @BotFather and copy its token.
2. `pnpm achords secret set telegram.bot-token` (paste the token; it is not shown).
3. Restart the gateway (`pnpm achords stop && pnpm achords start`); the log says `telegram: polling`.
4. `pnpm achords pair telegram`, then send `/pair <code>` to your bot in a private chat.

From then on the bot only accepts your Telegram user id, in private chats. Others get no reply (see `logs/gateway.log`). Commands: `/stop` (emergency stop), `/new` (new thread), `/local` (make the current thread local-only: local models only, never the cloud; one way, use `/new` for normal work), `/approve <id>` / `/reject <id>` (an agent's proposal for a new agent; nothing is created before you approve). Anything else goes to the boss agent; replies and `Done:` reports come back in the chat and are also visible in the web UI thread.

## Moving to another machine (or backup)

On the old machine:

```sh
pnpm achords stop
pnpm achords export ~/achords-backup.achords   # asks for a passphrase twice (12+ characters)
```

Copy the file over, then on the new machine (after `pnpm install && pnpm build`):

```sh
pnpm achords import ~/achords-backup.achords   # into an empty data folder
claude                                          # log in: CLI logins never travel
pnpm achords doctor
pnpm achords resume && pnpm achords start       # the queue starts paused
pnpm achords pair web                           # browser sessions do not travel
```

Everything under `$ACHORDS_HOME` travels (agents, workspaces, threads, kanban, settings, Telegram pairing, vault secrets). The old machine's queue is paused after export; do not run both at once (Telegram allows only one poller per bot). Without the passphrase the export cannot be opened.

## Voice notes

Telegram voice notes are transcribed on this machine (nothing goes to a cloud model for speech):

```sh
brew install whisper-cpp
mkdir -p ~/.achords/models
curl -L -o ~/.achords/models/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

Restart the gateway afterwards; `achords doctor` shows `speech: local Whisper ready`. Voice notes up to 10 minutes; the language is detected automatically. `ACHORDS_WHISPER_MODEL` points to another model file.

## How the emergency stop holds

- The launchd job respawns the gateway only after a crash (`KeepAlive.SuccessfulExit = false`). The gateway exits 0 when stopped on purpose, and exits 0 at once while `run/STOP` exists, so neither launchd nor a reboot brings it back.
- Agent runs are killed by process group, so their subprocesses die too.
- PIDs are only signalled if the process started before its record was written; a reused PID (e.g. after a reboot) is skipped.

## Manual fallback

If the CLI itself does not work:

```sh
mkdir -p ~/.achords/run && touch ~/.achords/run/STOP       # block restarts
launchctl bootout gui/$(id -u)/dev.achords.gateway        # unload the service
pkill -KILL -f 'apps/gateway/src/main.ts'                 # kill the gateway
# agent runs: see `ps -o pid,pgid,command` and `kill -KILL -<pgid>`
```

Remove `~/.achords/run/STOP` (or run `achords resume`) to allow starting again.

## macOS: privacy-protected folders

launchd jobs cannot read `~/Documents`, `~/Desktop`, `~/Downloads` or iCloud Drive without an explicit privacy grant, so a dev checkout there fails to start as a service (`EPERM` in `logs/gateway.log`). If `achords start` fails for this reason it says so. Fix: keep the checkout elsewhere (e.g. `~/Code/achords`), or grant `node` access under System Settings > Privacy & Security > Files and Folders. Running the gateway in the foreground (`node apps/gateway/src/main.ts`) is not affected.

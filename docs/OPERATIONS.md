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

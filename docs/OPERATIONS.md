# Operations

## Control commands

Run from the repo root during development (`pnpm achords <command>`), or as `achords <command>` once installed.

| Command  | What it does                                                                                                                                                                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`  | Installs/refreshes the launchd job (`~/Library/LaunchAgents/dev.achords.gateway.plist`) and starts the gateway. Waits up to 5 s for it to come up; if it does not, unloads the job again and points to the log. Refused while an emergency stop is active. |
| `stop`   | Graceful stop: unloads the service (SIGTERM). Queue state is kept.                                                                                                                                                                                         |
| `kill`   | **Emergency stop.** Writes the STOP marker, unloads the service, SIGKILLs the gateway and every running agent's process group, pauses the queue, marks runs cancelled. Works with a hung or dead gateway.                                                  |
| `resume` | Clears the STOP marker and unpauses the queue. Does not start the gateway.                                                                                                                                                                                 |
| `status` | Service, gateway PID, heartbeat age, queue, emergency stop, active runs.                                                                                                                                                                                   |

All state lives under `$ACHORDS_HOME` (default `~/.achords`): `core.db`, `run/gateway.pid`, `run/STOP`, `logs/gateway.log`.

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

launchd jobs cannot read `~/Documents`, `~/Desktop`, `~/Downloads` or iCloud Drive without an explicit privacy grant, so a dev checkout there fails to start as a service (`EPERM` in `logs/gateway.log`). `achords start` warns about this. Fix: keep the checkout elsewhere (e.g. `~/Code/achords`), or grant `node` access under System Settings > Privacy & Security > Files and Folders. Running the gateway in the foreground (`node apps/gateway/src/main.ts`) is not affected.

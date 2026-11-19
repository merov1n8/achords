import { mkdirSync } from "node:fs";
import { createPairingCode, type HomePaths, openCoreDatabase, setSetting } from "@achords/core";
import type { Vault } from "@achords/secrets";
import type { Check } from "./doctor.ts";

const TELEGRAM_TOKEN = "telegram.bot-token";

export interface InitDeps {
  paths: HomePaths;
  io: {
    ask: (question: string, opts?: { secret?: boolean }) => Promise<string>;
    print: (line: string) => void;
  };
  doctor: () => Promise<Check[]>;
  openVault: () => Vault;
  start: () => string;
}

const yes = (a: string) => /^y(es)?$/i.test(a.trim());

/** Interactive first-time setup. Safe to re-run: existing settings and secrets are kept. */
export async function runInit(d: InitDeps): Promise<number> {
  const { io, paths } = d;

  io.print("Checking prerequisites…");
  const failed = (await d.doctor()).filter((c) => c.level === "fail");
  if (failed.length) {
    for (const c of failed) io.print(`  ✗ ${c.name}: ${c.detail}${c.fix ? ` — ${c.fix}` : ""}`);
    io.print("Fix the above and run `achords init` again. Nothing was changed.");
    return 1;
  }

  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const db = openCoreDatabase(paths.db);
  try {
    // API-key mode is part of a later phase (ADR-0004); the CLI mode needs no keys here.
    setSetting(db, "providers.mode", "cli");
    io.print("Provider: the official `claude` CLI with your own login (API-key mode comes later).");

    const vault = d.openVault();
    let telegram = false;
    try {
      if (vault.status(TELEGRAM_TOKEN).set) {
        telegram = true;
        const replace = await io.ask("A Telegram bot token is already set. Replace it? [y/N]");
        if (yes(replace)) await askToken(d, vault);
        else io.print("Keeping the existing Telegram token.");
      } else if (
        yes(await io.ask("Set up Telegram now? You need a bot token from @BotFather. [y/N]"))
      ) {
        telegram = await askToken(d, vault);
      }
    } finally {
      vault.close();
    }

    io.print("Starting the gateway service…");
    try {
      io.print(d.start());
    } catch (err) {
      io.print(`Could not start the gateway: ${(err as Error).message}`);
      io.print("Run `achords doctor` for details, then `achords start`.");
      return 1;
    }

    if (telegram) {
      const code = createPairingCode(db, "telegram");
      io.print(`Telegram: send this to your bot in a private chat:  /pair ${code}`);
    }
    io.print(`Web UI: open http://127.0.0.1:7420 and enter:  ${createPairingCode(db, "web")}`);
    io.print(
      "Codes are single use and expire in 10 minutes (`achords pair web|telegram` for new ones).",
    );
    return 0;
  } finally {
    db.close();
  }
}

async function askToken(d: InitDeps, vault: Vault): Promise<boolean> {
  const token = (await d.io.ask("Telegram bot token (hidden):", { secret: true })).trim();
  if (!token) {
    d.io.print("No token entered; skipping Telegram.");
    return false;
  }
  vault.set(TELEGRAM_TOKEN, token, "cli:init");
  d.io.print("Telegram token stored in the vault.");
  return true;
}

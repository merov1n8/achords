import { mkdirSync } from "node:fs";
import { createPairingCode, type HomePaths, openCoreDatabase, setSetting } from "@achords/core";
import { t } from "@achords/i18n";
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

  io.print(t("cli.init.checking"));
  const failed = (await d.doctor()).filter((c) => c.level === "fail");
  if (failed.length) {
    for (const c of failed) io.print(`  ✗ ${c.name}: ${c.detail}${c.fix ? ` — ${c.fix}` : ""}`);
    io.print(t("cli.init.fixFirst"));
    return 1;
  }

  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const db = openCoreDatabase(paths.db);
  try {
    // API-key mode is part of a later phase (ADR-0004); the CLI mode needs no keys here.
    setSetting(db, "providers.mode", "cli");
    io.print(t("cli.init.provider"));

    const vault = d.openVault();
    let telegram = false;
    try {
      if (vault.status(TELEGRAM_TOKEN).set) {
        telegram = true;
        const replace = await io.ask(t("cli.init.replaceToken"));
        if (yes(replace)) await askToken(d, vault);
        else io.print(t("cli.init.keepToken"));
      } else if (yes(await io.ask(t("cli.init.setupTelegram")))) {
        telegram = await askToken(d, vault);
      }
    } finally {
      vault.close();
    }

    io.print(t("cli.init.starting"));
    try {
      io.print(d.start());
    } catch (err) {
      io.print(t("cli.init.startFailed", { error: (err as Error).message }));
      io.print(t("cli.init.startHint"));
      return 1;
    }

    if (telegram) {
      const code = createPairingCode(db, "telegram");
      io.print(t("cli.init.telegramCode", { code }));
    }
    io.print(t("cli.init.webCode", { code: createPairingCode(db, "web") }));
    io.print(t("cli.init.codesExpire"));
    return 0;
  } finally {
    db.close();
  }
}

async function askToken(d: InitDeps, vault: Vault): Promise<boolean> {
  const token = (await d.io.ask(t("cli.init.tokenPrompt"), { secret: true })).trim();
  if (!token) {
    d.io.print(t("cli.init.noToken"));
    return false;
  }
  vault.set(TELEGRAM_TOKEN, token, "cli:init");
  d.io.print(t("cli.init.tokenStored"));
  return true;
}

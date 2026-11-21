import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { catalog as en } from "@achords/i18n";
import { describe, expect, it } from "vitest";
import { t } from "./i18n.ts";

const SRC = new URL(".", import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(f) && !f.endsWith(".test.ts") ? [p] : [];
  });
}

describe("i18n", () => {
  it("looks up keys and fills in {placeholders}", () => {
    expect(t("nav.chat")).toBe("Chat");
    expect(t("time.minutes", { n: 5 })).toBe("5m");
  });

  it("falls back to the key itself for unknown keys (visible, never blank)", () => {
    expect(t("does.not.exist")).toBe("does.not.exist");
  });

  it("every t('...') key used in the UI exists in the English catalog", () => {
    const used = new Set<string>();
    for (const file of sources(SRC)) {
      for (const m of readFileSync(file, "utf8").matchAll(/\bt\(\s*"([\w.]+)"/g))
        used.add(m[1] as string);
    }
    // Keys built at runtime (status.<status>, appearance.theme.<id>, …) are listed explicitly.
    for (const k of [
      "status.queued",
      "status.claimed",
      "status.done",
      "status.failed",
      "status.cancelled",
      ...["running", "queued", "waiting", "idle"].map((k) => `chat.status.${k}`),
      "appearance.theme.system",
      "appearance.theme.light",
      "appearance.theme.dark",
      "appearance.accent.violet",
      "appearance.accent.teal",
      ...["hourly", "daily", "weekdays", "weekly", "monthly", "custom"].map(
        (k) => `repeat.kind.${k}`,
      ),
      ...[0, 1, 2, 3, 4, 5, 6].map((d) => `repeat.day.${d}`),
    ])
      used.add(k);
    const missing = [...used].filter((k) => !(k in en));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(30);
  });
});

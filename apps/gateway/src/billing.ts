// Who pays for a run (ADR-0044), API budgets (ADR-0046), billing per agent and the
// subscription fallback (ADR-0068).
import { apiSpendSince, type Db, getSetting, setSetting } from "@achords/core";
import { t } from "@achords/i18n";
import { CODEX_API_KEY_ENV } from "@achords/providers";

export type BillingMode = "subscription" | "api";

// Phase 4 providers: vault key and the variable each official CLI reads in API mode.
export const BILLING: Record<string, { label: string; key: string; env: string }> = {
  "cli-claude": { label: "Claude", key: "anthropic-api-key", env: "ANTHROPIC_API_KEY" },
  "cli-codex": { label: "OpenAI", key: "openai-api-key", env: CODEX_API_KEY_ENV },
  "cli-gemini": { label: "Google Gemini", key: "gemini-api-key", env: "GEMINI_API_KEY" },
};

/** ADR-0068: "subscription" when the subscription takes over at a used-up budget. */
export const fallbackKey = (provider: string) => `budget.${provider}.fallback`;

export function periodStart(period: "day" | "month", now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (period === "month") d.setDate(1);
  return d.getTime();
}

export function createBilling(deps: {
  db: Db;
  notify: (text: string) => void;
  keySet: (keyId: string) => boolean;
  resolveKey: (keyId: string, audit: string) => string;
}) {
  const { db } = deps;
  const fallsBack = (provider: string) => getSetting(db, fallbackKey(provider)) === "subscription";

  /** Why API work on this provider must not run now (budget used up), or undefined. */
  const budget = (provider: string): string | undefined => {
    const label = BILLING[provider]?.label ?? provider;
    for (const period of ["day", "month"] as const) {
      const limit = Number(getSetting(db, `budget.${provider}.${period}`) ?? 0);
      if (!limit) continue;
      const since = periodStart(period);
      const spent = apiSpendSince(db, provider, since);
      const once = (what: string, text: string) => {
        const key = `budget.told.${provider}.${period}.${what}.${since}`;
        if (getSetting(db, key)) return;
        setSetting(db, key, "1");
        deps.notify(text);
      };
      const vars = {
        provider: label,
        period: t(`budget.${period}`),
        spent: spent.toFixed(2),
        limit: limit.toFixed(2),
      };
      if (spent >= limit) {
        const reason = t("budget.reached", vars);
        once("stop", `⛔ ${fallsBack(provider) ? t("budget.reachedFallback", vars) : reason}`);
        return reason;
      }
      if (spent >= limit * 0.8) once("warn", `⚠️ ${t("budget.warning", vars)}`);
    }
    return undefined;
  };

  /**
   * The billing of one run: the agent's own choice, else the provider's setting. Throws when
   * API mode has no key. ADR-0068: with the budget used up and the fallback on, the subscription.
   */
  const billing = (
    provider: string,
    prefer?: BillingMode,
  ): { mode: BillingMode; env?: Record<string, string> } => {
    const p = BILLING[provider];
    const mode =
      prefer ?? (getSetting(db, `billing.${provider}`) === "api" ? "api" : "subscription");
    if (!p || mode !== "api") return { mode: "subscription" };
    if (!deps.keySet(p.key)) {
      throw new Error(`API mode for ${p.label} needs its API key (Settings → Model access)`);
    }
    if (fallsBack(provider) && budget(provider)) return { mode: "subscription" };
    return { mode: "api", env: { [p.env]: deps.resolveKey(p.key, `provider:${provider}`) } };
  };

  return { billing, budget, fallsBack };
}

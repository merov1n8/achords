import type { UsageWindow } from "./types.ts";

/** CLI mode shows subscription windows; API mode shows spend and balance (ADR-0004). */
export type UsageSnapshot =
  | { provider: string; mode: "subscription"; windows: UsageWindow[]; updatedAt: number | null }
  | {
      provider: string;
      mode: "api";
      spentUsd: number;
      balanceUsd: number | null;
      updatedAt: number | null;
    };

export interface UsageMeter {
  snapshot(): UsageSnapshot;
}

/** Fed from the windows each CLI run reports; there is no separate quota endpoint to poll. */
export function subscriptionMeter(provider: string) {
  const windows = new Map<string, UsageWindow>();
  let updatedAt: number | null = null;
  return {
    record(latest: UsageWindow[], now = Date.now()) {
      if (latest.length === 0) return;
      for (const w of latest) windows.set(w.kind, w);
      updatedAt = now;
    },
    snapshot: (): UsageSnapshot => ({
      provider,
      mode: "subscription",
      windows: [...windows.values()],
      updatedAt,
    }),
  };
}

/** Placeholder until the API adapters and billing endpoints land (Phase 4). */
export function stubApiMeter(
  provider: string,
  data: { spentUsd: number; balanceUsd: number | null },
): UsageMeter {
  return { snapshot: () => ({ provider, mode: "api", ...data, updatedAt: null }) };
}

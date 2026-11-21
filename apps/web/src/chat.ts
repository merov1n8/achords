// The chat page's run details (GET /api/threads/:id/summary) and small helpers around them.

export interface ThreadSummary {
  agentsWorking: number;
  agentsTotal: number;
  tasksDone: number;
  tasksTotal: number;
  waitingOwner: boolean;
  tokensIn: number;
  tokensCached: number;
  tokensOut: number;
  costUsd: number;
  budgetDayUsd?: number;
  participants: {
    agent: string;
    name: string;
    status: "running" | "queued" | "idle" | "waiting";
  }[];
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export const formatUsd = (usd: number) => `$${usd.toFixed(2)}`;

/** "@agent" in front of the draft: the gateway routes a message by its leading mention only. */
export function mention(text: string, agent: string): string {
  return `@${agent} ${text.replace(/^@[\w-]+\s*/, "")}`;
}

export const hasOpenWork = (s: Pick<ThreadSummary, "participants">) =>
  s.participants.some((p) => p.status !== "idle");

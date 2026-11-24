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
  /** ADR-0066: input of runs that resumed a card's session, and how much came from cache. */
  resumedIn: number;
  resumedCached: number;
  costUsd: number;
  budgetDayUsd?: number;
  participants: {
    agent: string;
    name: string;
    status: "running" | "queued" | "idle" | "waiting";
  }[];
  /** ADR-0066: a delegated task's question to its parent and the answer (null while open). */
  parentQuestions?: {
    task: string;
    title: string;
    agent: string;
    name: string;
    question: string;
    answer: string | null;
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

const IMAGE_LINE = /^\[image: (\/\S+)\]$/;

/**
 * A message's text and the images of this chat it carries ("[image: <path>]" lines, see
 * packages/core attachments.ts), as file names the chat's image route serves.
 */
export function imageParts(content: string, threadId: string): { text: string; images: string[] } {
  const images: string[] = [];
  const text = content
    .split("\n")
    .filter((line) => {
      const m = IMAGE_LINE.exec(line.trim());
      const dir = `/attachments/${threadId}/`;
      const path = m?.[1];
      if (!path?.includes(dir)) return true;
      images.push(path.slice(path.lastIndexOf("/") + 1));
      return false;
    })
    .join("\n")
    .trim();
  return { text, images };
}

/** The owner's text with image lines after it (same form as the gateway's withImages). */
export const withImages = (text: string, paths: string[]) =>
  [text.trim(), paths.map((p) => `[image: ${p}]`).join("\n")].filter(Boolean).join("\n\n");

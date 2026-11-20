// Publish requests and results as people read them (ADR-0037): the post itself instead of its
// JSON, and a link instead of an API response. Every argument stays visible: the owner approves
// exactly what is shown.
import { t } from "@achords/i18n";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Readable text from post HTML: paragraphs and list items on their own lines, no tags. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\/\s*li\s*>/gi, "")
    .replace(/<\/\s*(p|div|h[1-6]|ul|ol|blockquote)\s*>/gi, "\n\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code =
          e[1]?.toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const TITLE = ["title", "name", "subject"];
const TEXT = ["content", "message", "caption", "text", "body", "description", "excerpt"];
const label = (key: string) => key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const MAX_TEXT = 3500;

/** The call's arguments as a readable post: title, text blocks, then the remaining fields. */
export function describeCall(args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return String(args ?? "");
  const entries = Object.entries(args as Record<string, unknown>);
  const out: string[] = [];
  for (const [k, v] of entries) {
    if (TITLE.includes(k) && typeof v === "string") out.push(`**${v}**`);
  }
  for (const [k, v] of entries) {
    if (!TEXT.includes(k) || typeof v !== "string") continue;
    const text = /<[a-z][^>]*>/i.test(v) ? htmlToText(v) : v.trim();
    const shown =
      text.length > MAX_TEXT
        ? `${text.slice(0, MAX_TEXT)}\n${t("publish.more", { n: text.length - MAX_TEXT })}`
        : text;
    out.push(k === "content" || k === "message" ? shown : `${label(k)}:\n${shown}`);
  }
  const rest = entries
    .filter(([k, v]) => !(TITLE.includes(k) && typeof v === "string"))
    .filter(([k, v]) => !(TEXT.includes(k) && typeof v === "string"))
    .map(([k, v]) => `${label(k)}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  if (rest.length) out.push(rest.join("\n"));
  return out.join("\n\n");
}

/** One sentence and a link from a tool result, or the start of its text. */
export function describeResult(text: string): string {
  let r: unknown;
  try {
    r = JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
  if (!r || typeof r !== "object" || Array.isArray(r)) return text.slice(0, 500);
  const o = r as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  const link = str("edit") ?? str("permalink") ?? str("link") ?? str("url");
  const status = str("status");
  const head =
    status === "draft"
      ? t("publish.savedDraft")
      : status === "publish" || status === "published"
        ? t("publish.published")
        : t("publish.done");
  return link ? `${head} ${t("publish.openLink", { link })}` : head;
}

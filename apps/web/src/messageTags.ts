import type { Message } from "./types.ts";

/** What a chat message's header shows: who speaks and, for report-like lines, what kind it is. */
export type MessageKind = "done" | "review" | "question" | "command" | "skillNew" | "skillChange";

export interface MessageTags {
  /** The speaking agent shown as a tag; null for the owner's own messages. */
  agent: string | null;
  kind: MessageKind | null;
  /** The text without the "Done (agent):"-style lead-in the tags now show. */
  content: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The gateway's lines (packages/i18n thread.*) begin with the agent's name; with the name shown
 * as a tag that lead-in is dropped. Only a lead-in naming the message's own author is touched.
 */
const LEADS: {
  kind: MessageKind;
  re: (a: string) => RegExp;
  keep: (m: RegExpMatchArray) => string;
}[] = [
  { kind: "done", re: (a) => new RegExp(`^Done \\(${a}\\): `), keep: () => "" },
  { kind: "review", re: (a) => new RegExp(`^Review \\(${a}\\): `), keep: () => "" },
  {
    kind: "question",
    re: (a) => new RegExp(`^Question from ${a} \\((.*?)\\): `),
    keep: (m) => `${m[1]}: `,
  },
  {
    kind: "command",
    re: (a) => new RegExp(`^${a} asks to run a command \\((.*?)\\):\\n`),
    keep: (m) => `${m[1]}:\n`,
  },
  { kind: "skillNew", re: (a) => new RegExp(`^${a} proposes a new skill `), keep: () => "" },
  {
    kind: "skillChange",
    re: (a) => new RegExp(`^${a} proposes a change to the skill `),
    keep: () => "",
  },
];

export function messageTags(m: Pick<Message, "role" | "author" | "content">): MessageTags {
  if (m.role === "user") return { agent: null, kind: null, content: m.content };
  const agent = m.author ?? m.role;
  const a = escapeRe(agent);
  for (const lead of LEADS) {
    const found = m.content.match(lead.re(a));
    if (found) {
      return {
        agent,
        kind: lead.kind,
        content: lead.keep(found) + m.content.slice(found[0].length),
      };
    }
  }
  return { agent, kind: null, content: m.content };
}

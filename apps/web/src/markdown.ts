// A small Markdown reader for agent replies in the chat. It builds a tree that the view renders
// as Preact elements, never as HTML, so a reply cannot inject markup (the CSP stays strict).
// Covered: headings, paragraphs, lists (nested by indentation), code blocks, block quotes,
// tables, rules; inline code, bold, italic, strikethrough and links.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong" | "em" | "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type ListItem = { c: Inline[]; sub?: Block };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

/** Only web and mail links are links; anything else (javascript: and the like) stays text. */
export const safeHref = (href: string): string | undefined =>
  /^(https?:\/\/|mailto:|\/(?!\/))/i.test(href.trim()) ? href.trim() : undefined;

export function inline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    // Inline code first: nothing inside it is formatting.
    const code = /^(`+)([\s\S]+?)\1/.exec(rest);
    if (code) {
      flush();
      out.push({ t: "code", v: (code[2] as string).trim() || (code[2] as string) });
      i += code[0].length;
      continue;
    }
    const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      const href = safeHref(link[2] as string);
      flush();
      if (href) out.push({ t: "link", href, c: inline(link[1] as string) });
      else out.push(...inline(link[1] as string));
      i += link[0].length;
      continue;
    }
    const auto = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(rest);
    if (auto && !/[\w/]$/.test(text)) {
      flush();
      out.push({ t: "link", href: auto[0], c: [{ t: "text", v: auto[0] }] });
      i += auto[0].length;
      continue;
    }
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong) {
      flush();
      out.push({ t: "strong", c: inline(strong[2] as string) });
      i += strong[0].length;
      continue;
    }
    const del = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
    if (del) {
      flush();
      out.push({ t: "del", c: inline(del[1] as string) });
      i += del[0].length;
      continue;
    }
    // Underscores inside words (snake_case) are not emphasis.
    const em = /^(\*|_)(?=\S)([\s\S]*?\S)\1(?!\w)/.exec(rest);
    if (em && !(em[1] === "_" && /\w$/.test(text))) {
      flush();
      out.push({ t: "em", c: inline(em[2] as string) });
      i += em[0].length;
      continue;
    }
    if (rest[0] === "\n") {
      flush();
      out.push({ t: "br" });
      i++;
      continue;
    }
    text += rest[0];
    i++;
  }
  flush();
  return out;
}

const indentOf = (line: string) => /^ */.exec(line)?.[0].length ?? 0;
const LIST = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
const isRule = (line: string) => /^ {0,3}([-*_])( *\1){2,} *$/.test(line);
const startsBlock = (line: string) =>
  /^ {0,3}(#{1,6}\s|```|~~~|>)/.test(line) || LIST.test(line) || isRule(line);

function list(lines: string[], start: number): { block: Block; next: number } {
  const first = LIST.exec(lines[start] as string) as RegExpExecArray;
  const base = (first[1] as string).length;
  const ordered = /\d/.test(first[2] as string);
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST.exec(lines[i] as string);
    if (!m || (m[1] as string).length !== base || /\d/.test(m[2] as string) !== ordered) break;
    let text = m[3] as string;
    i++;
    // Continuation lines and a nested list belong to this item.
    const inner: string[] = [];
    while (i < lines.length) {
      const line = lines[i] as string;
      if (!line.trim()) {
        const next = lines[i + 1];
        if (next !== undefined && indentOf(next) > base && next.trim()) {
          inner.push("");
          i++;
          continue;
        }
        break;
      }
      if (indentOf(line) > base) {
        if (!inner.length && !LIST.test(line)) text += `\n${line.trim()}`;
        else inner.push(line);
        i++;
        continue;
      }
      if (LIST.test(line) || startsBlock(line)) break;
      if (inner.length) break;
      text += `\n${line.trim()}`;
      i++;
    }
    const sub = inner.length ? blocks(dedent(inner)) : [];
    items.push({ c: inline(text), ...(sub[0] ? { sub: sub[0] } : {}) });
  }
  return {
    block: {
      t: "list",
      ordered,
      start: ordered ? Number.parseInt(first[2] as string, 10) : 1,
      items,
    },
    next: i,
  };
}

const dedent = (lines: string[]) => {
  const min = Math.min(...lines.filter((l) => l.trim()).map(indentOf));
  return lines.map((l) => l.slice(min));
};

export function blocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^ {0,3}(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).trim().startsWith(fence[1] as string)) {
        body.push(lines[i] as string);
        i++;
      }
      i++; // the closing fence (or the end)
      out.push({ t: "code", lang: fence[2] ?? "", v: body.join("\n") });
      continue;
    }
    const h = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push({ t: "h", level: (h[1] as string).length, c: inline(h[2] as string) });
      i++;
      continue;
    }
    if (isRule(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i] as string)) {
        body.push((lines[i] as string).replace(/^ {0,3}> ?/, ""));
        i++;
      }
      out.push({ t: "quote", c: blocks(body) });
      continue;
    }
    if (LIST.test(line)) {
      const { block, next } = list(lines, i);
      out.push(block);
      i = next;
      continue;
    }
    const sep = lines[i + 1];
    if (
      line.includes("|") &&
      sep &&
      /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(sep)
    ) {
      const head = cells(line).map(inline);
      const rows: Inline[][][] = [];
      i += 2;
      while (
        i < lines.length &&
        (lines[i] as string).includes("|") &&
        (lines[i] as string).trim()
      ) {
        rows.push(cells(lines[i] as string).map(inline));
        i++;
      }
      out.push({ t: "table", head, rows });
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && (lines[i] as string).trim() && !startsBlock(lines[i] as string)) {
      para.push((lines[i] as string).trim());
      i++;
    }
    out.push({ t: "p", c: inline(para.join("\n")) });
  }
  return out;
}

export const parseMarkdown = (src: string): Block[] =>
  blocks(src.replace(/\r\n?/g, "\n").split("\n"));

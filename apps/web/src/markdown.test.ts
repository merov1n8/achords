import { describe, expect, it } from "vitest";
import { inline, parseMarkdown, safeHref } from "./markdown.ts";

describe("chat markdown", () => {
  it("inline: code, bold, italic, strikethrough, links; snake_case stays text", () => {
    expect(inline("**Kész:** a `f832ab2` commit, *dőlt*, ~~régi~~")).toEqual([
      { t: "strong", c: [{ t: "text", v: "Kész:" }] },
      { t: "text", v: " a " },
      { t: "code", v: "f832ab2" },
      { t: "text", v: " commit, " },
      { t: "em", c: [{ t: "text", v: "dőlt" }] },
      { t: "text", v: ", " },
      { t: "del", c: [{ t: "text", v: "régi" }] },
    ]);
    expect(inline("ACME_API_SECRET and my_var")).toEqual([
      { t: "text", v: "ACME_API_SECRET and my_var" },
    ]);
    expect(inline("`**not bold**`")).toEqual([{ t: "code", v: "**not bold**" }]);
    expect(inline("[GitHub](https://github.com/x) or https://example.com/a.")).toEqual([
      { t: "link", href: "https://github.com/x", c: [{ t: "text", v: "GitHub" }] },
      { t: "text", v: " or " },
      { t: "link", href: "https://example.com/a", c: [{ t: "text", v: "https://example.com/a" }] },
      { t: "text", v: "." },
    ]);
  });

  it("never makes a link of javascript: or other schemes", () => {
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("//evil.example")).toBeUndefined();
    expect(safeHref("/chat/x")).toBe("/chat/x");
    expect(inline("[click](javascript:void0)")).toEqual([{ t: "text", v: "click" }]);
  });

  it("blocks: headings, paragraphs with line breaks, rules, quotes, code", () => {
    const md =
      "## Állapot\nElső sor\nmásodik\n\n---\n> idézet\n\n```sh\ngit push origin audit\n```";
    expect(parseMarkdown(md)).toEqual([
      { t: "h", level: 2, c: [{ t: "text", v: "Állapot" }] },
      {
        t: "p",
        c: [{ t: "text", v: "Első sor" }, { t: "br" }, { t: "text", v: "második" }],
      },
      { t: "hr" },
      { t: "quote", c: [{ t: "p", c: [{ t: "text", v: "idézet" }] }] },
      { t: "code", lang: "sh", v: "git push origin audit" },
    ]);
  });

  it("lists: bullets, numbers, nested by indentation", () => {
    const md = "- egy\n- kettő\n  - al\n  - al2\n- három\n\n1. első\n2. második";
    expect(parseMarkdown(md)).toEqual([
      {
        t: "list",
        ordered: false,
        start: 1,
        items: [
          { c: [{ t: "text", v: "egy" }] },
          {
            c: [{ t: "text", v: "kettő" }],
            sub: {
              t: "list",
              ordered: false,
              start: 1,
              items: [{ c: [{ t: "text", v: "al" }] }, { c: [{ t: "text", v: "al2" }] }],
            },
          },
          { c: [{ t: "text", v: "három" }] },
        ],
      },
      {
        t: "list",
        ordered: true,
        start: 1,
        items: [{ c: [{ t: "text", v: "első" }] }, { c: [{ t: "text", v: "második" }] }],
      },
    ]);
  });

  it("tables", () => {
    expect(parseMarkdown("| Plugin | Verzió |\n|---|---:|\n| `acme-pricing` | 1.18.0 |")).toEqual([
      {
        t: "table",
        head: [[{ t: "text", v: "Plugin" }], [{ t: "text", v: "Verzió" }]],
        rows: [[[{ t: "code", v: "acme-pricing" }], [{ t: "text", v: "1.18.0" }]]],
      },
    ]);
  });

  it("plain text stays one paragraph; an unclosed fence still shows as code", () => {
    expect(parseMarkdown("Just text")).toEqual([{ t: "p", c: [{ t: "text", v: "Just text" }] }]);
    expect(parseMarkdown("```\nopen")).toEqual([{ t: "code", lang: "", v: "open" }]);
  });
});

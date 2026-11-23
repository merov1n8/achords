import type { ComponentChildren } from "preact";
import { type Block, type Inline, parseMarkdown } from "../markdown.ts";

// Renders the parsed tree as elements; text is always text, never HTML.
function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text":
            return n.v;
          case "code":
            return <code key={i}>{n.v}</code>;
          case "strong":
            return (
              <strong key={i}>
                <Inlines nodes={n.c} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <Inlines nodes={n.c} />
              </em>
            );
          case "del":
            return (
              <del key={i}>
                <Inlines nodes={n.c} />
              </del>
            );
          case "link":
            return (
              <a key={i} href={n.href} target="_blank" rel="noreferrer noopener">
                <Inlines nodes={n.c} />
              </a>
            );
          default:
            return <br key={i} />;
        }
      })}
    </>
  );
}

function BlockView({ b }: { b: Block }): ComponentChildren {
  switch (b.t) {
    case "p":
      return (
        <p>
          <Inlines nodes={b.c} />
        </p>
      );
    case "h": {
      // Chat headings stay small: h4-h6 at most, whatever level the reply used.
      const H = b.level <= 2 ? "h4" : b.level === 3 ? "h5" : "h6";
      return (
        <H>
          <Inlines nodes={b.c} />
        </H>
      );
    }
    case "code":
      return (
        <pre>
          <code>{b.v}</code>
        </pre>
      );
    case "quote":
      return (
        <blockquote>
          {b.c.map((c, i) => (
            <BlockView key={i} b={c} />
          ))}
        </blockquote>
      );
    case "list": {
      const items = b.items.map((it, i) => (
        <li key={i}>
          <Inlines nodes={it.c} />
          {it.sub && <BlockView b={it.sub} />}
        </li>
      ));
      return b.ordered ? <ol start={b.start}>{items}</ol> : <ul>{items}</ul>;
    }
    case "table":
      return (
        <div class="md-table">
          <table>
            <thead>
              <tr>
                {b.head.map((c, i) => (
                  <th key={i}>
                    <Inlines nodes={c} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j}>
                      <Inlines nodes={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr />;
  }
}

export function Markdown({ text }: { text: string }) {
  return (
    <div class="content md">
      {parseMarkdown(text).map((b, i) => (
        <BlockView key={i} b={b} />
      ))}
    </div>
  );
}

import { describe, expect, it } from "vitest";
import { describeCall, describeResult, htmlToText } from "./publish-text.ts";

describe("publish text (ADR-0037)", () => {
  it("turns post HTML into readable text", () => {
    expect(
      htmlToText(
        "<p><strong>Media</strong> tracker &amp; more</p><ul><li>One</li><li>Two</li></ul><p>A&#39;s</p>",
      ),
    ).toBe("Media tracker & more\n\n- One\n- Two\n\nA's");
  });

  it("shows the post instead of JSON, and every other field", () => {
    const text = describeCall({
      type: "posts",
      title: "Spring sale",
      content: "<p>Hello <em>world</em></p>",
      excerpt: "Short",
    });
    expect(text).toBe("**Spring sale**\n\nHello world\n\nExcerpt:\nShort\n\nType: posts");
    expect(text).not.toContain("{");
  });

  it("reports a draft with its edit link, and falls back to text", () => {
    expect(
      describeResult(
        JSON.stringify({
          id: 7,
          status: "draft",
          link: "https://x/?p=7",
          edit: "https://x/wp-admin/post.php?post=7&action=edit",
        }),
      ),
    ).toBe(
      "Saved as a draft. Open it (log in first if needed): https://x/wp-admin/post.php?post=7&action=edit",
    );
    expect(describeResult("Post created")).toBe("Post created");
  });
});

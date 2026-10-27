/**
 * @jest-environment jsdom
 */

import {
  buildPublicKBLLMText,
  buildPublicKBMarkdown,
  convertPublicKBContentToMarkdown,
} from "./public-kb-copy-format";

describe("public KB copy format", () => {
  it("converts persisted article HTML into deterministic Markdown", () => {
    const markdown = convertPublicKBContentToMarkdown(`
      <h2>Setup</h2>
      <p>Use <strong>templates</strong> and <a href="https://airi.chat/flows">flows</a>.</p>
      <ul><li>Connect WhatsApp</li><li>Publish a flow</li></ul>
      <pre><code class="language-ts">const ok = true;</code></pre>
      <blockquote><p>Keep support replies short.</p></blockquote>
    `);

    expect(markdown).toBe(
      [
        "## Setup",
        "",
        "Use **templates** and [flows](https://airi.chat/flows).",
        "",
        "- Connect WhatsApp",
        "- Publish a flow",
        "",
        "```ts",
        "const ok = true;",
        "```",
        "",
        "> Keep support replies short.",
      ].join("\n")
    );
  });

  it("includes the article title in Markdown exports", () => {
    const markdown = buildPublicKBMarkdown({
      title: "Q/A",
      content: "<p>Answers for common billing questions.</p>",
    });

    expect(markdown).toBe("# Q/A\n\nAnswers for common billing questions.");
  });

  it("exports YouTube embeds as markdown links", () => {
    expect(
      convertPublicKBContentToMarkdown(
        `<div data-youtube-video=""><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe></div>`
      )
    ).toBe(
      "[YouTube](https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ)"
    );
  });

  it("builds an LLM-oriented copy with source metadata and article body", () => {
    const payload = buildPublicKBLLMText({
      title: "Refund policy",
      content: "<h2>Window</h2><p>Refunds are available for 14 days.</p>",
      articleUrl: "https://airi.chat/acme/kb/refunds",
      companyName: "Acme",
      locale: "en",
      publishedAt: "2026-06-21T00:00:00.000Z",
      updatedAt: "2026-06-22T00:00:00.000Z",
    });

    expect(payload).toBe(
      [
        "# Refund policy",
        "",
        "Source: https://airi.chat/acme/kb/refunds",
        "Company: Acme",
        "Locale: en",
        "Published: 2026-06-21T00:00:00.000Z",
        "Updated: 2026-06-22T00:00:00.000Z",
        "",
        "## Window",
        "",
        "Refunds are available for 14 days.",
      ].join("\n")
    );
  });
});

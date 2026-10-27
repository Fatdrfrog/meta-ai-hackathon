jest.mock("marked", () => ({
  marked: {
    parse: jest.fn((markdown: string) => {
      const lines = markdown.split(/\r?\n/);
      const html: string[] = [];
      let inList = false;

      for (const line of lines) {
        const h1 = /^#\s+(.+)$/.exec(line);
        const bullet = /^-\s+(.+)$/.exec(line);

        if (h1) {
          if (inList) {
            html.push("</ul>");
            inList = false;
          }
          html.push(`<h1>${h1[1]}</h1>`);
          continue;
        }

        if (bullet) {
          if (!inList) {
            html.push("<ul>");
            inList = true;
          }
          html.push(`<li>${bullet[1]}</li>`);
          continue;
        }

        if (line.trim()) {
          if (inList) {
            html.push("</ul>");
            inList = false;
          }
          html.push(`<p>${line}</p>`);
        }
      }

      if (inList) {
        html.push("</ul>");
      }

      return html.join("\n");
    }),
  },
}));

import {
  buildMarkdownImport,
  extractMarkdownImportTitle,
  isMarkdownImportFile,
} from "./markdown-import";

function markdownFile(params: {
  name: string;
  type?: string;
  content: string;
}) {
  return {
    name: params.name,
    type: params.type ?? "",
    text: jest.fn().mockResolvedValue(params.content),
  };
}

describe("markdown-import", () => {
  test("recognizes markdown files by extension even when browsers report text/plain", () => {
    expect(
      isMarkdownImportFile(
        markdownFile({
          name: "Refund Policy.md",
          type: "text/plain",
          content: "# Refund Policy",
        })
      )
    ).toBe(true);
  });

  test("recognizes markdown files by markdown mime type", () => {
    expect(
      isMarkdownImportFile(
        markdownFile({
          name: "download",
          type: "text/markdown",
          content: "# Downloaded doc",
        })
      )
    ).toBe(true);
  });

  test("does not treat arbitrary text files as markdown imports", () => {
    expect(
      isMarkdownImportFile(
        markdownFile({
          name: "notes.txt",
          type: "text/plain",
          content: "plain notes",
        })
      )
    ).toBe(false);
  });

  test("extracts the first top-level markdown heading for empty article titles", () => {
    expect(
      extractMarkdownImportTitle({
        markdown: "intro\n\n## Not this\n\n# Shipping Rules\n\nBody",
        fileName: "fallback.md",
      })
    ).toBe("Shipping Rules");
  });

  test("falls back to filename without markdown extension when no H1 exists", () => {
    expect(
      extractMarkdownImportTitle({
        markdown: "## Details\n\nNo H1 here",
        fileName: "support-playbook.markdown",
      })
    ).toBe("support-playbook");
  });

  test("converts markdown into html ready for TipTap insertion", async () => {
    const result = await buildMarkdownImport(
      markdownFile({
        name: "returns.md",
        type: "text/plain",
        content: "# Returns\n\n- Keep receipt\n- Contact support",
      })
    );

    expect(result.title).toBe("Returns");
    expect(result.html).toContain("<h1>Returns</h1>");
    expect(result.html).toContain("<li>Keep receipt</li>");
    expect(result.sourceName).toBe("returns.md");
  });

  test("rejects empty markdown files", async () => {
    await expect(
      buildMarkdownImport(
        markdownFile({
          name: "empty.md",
          type: "text/plain",
          content: "  \n\t ",
        })
      )
    ).rejects.toThrow("Markdown file is empty");
  });
});

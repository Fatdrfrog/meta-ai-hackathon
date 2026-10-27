import { normalizeMessageMarkdown } from "@/lib/conversation/message-markdown";

describe("normalizeMessageMarkdown", () => {
  it("escapes leading invoice-style numbers so they are not ordered-list markers", () => {
    const input = "140560. Один человек. AP TREID";
    const normalized = normalizeMessageMarkdown(input);

    expect(normalized).toBe("140560\\. Один человек. AP TREID");
    expect(/^\s*\d+\.\s/.test(normalized)).toBe(false);
  });

  it("escapes leading numbers after promoted newlines", () => {
    const normalized = normalizeMessageMarkdown("Steps: 1. first");
    expect(normalized).toBe("Steps:\n1\\. first");
  });

  it("leaves mid-sentence decimals alone", () => {
    expect(normalizeMessageMarkdown("Price is 12.5 tenge")).toBe(
      "Price is 12.5 tenge"
    );
  });
});

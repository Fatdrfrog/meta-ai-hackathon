import {
  appendKbArticleLinksToReply,
  stripKbArticleLinksFooter,
} from "@/lib/airi/reply/runtime/dispatch";

const articleLinks = [
  { url: "https://help.example.com/pricing", title: "Pricing" },
];

describe("appendKbArticleLinksToReply", () => {
  it.each([
    ["en", "Learn more"],
    ["ru", "Подробнее"],
    ["kz", "Толығырақ"],
    ["uz", "Batafsil"],
  ])("labels the %s link list as %s", (language, label) => {
    expect(
      appendKbArticleLinksToReply({
        reply: "Here is the answer.",
        articleLinks,
        language,
      })
    ).toBe(
      `Here is the answer.\n\n${label}:\n1. Pricing: https://help.example.com/pricing`
    );
  });

  it("falls back to English for an unknown language", () => {
    expect(
      appendKbArticleLinksToReply({
        reply: "Answer",
        articleLinks,
        language: "de",
      })
    ).toContain("Learn more:");
  });

  it("does not repeat a link the reply already contains", () => {
    const reply = "See https://help.example.com/pricing for details.";
    expect(
      appendKbArticleLinksToReply({ reply, articleLinks, language: "ru" })
    ).toBe(reply);
  });
});

describe("stripKbArticleLinksFooter", () => {
  it.each(["en", "ru", "kz", "uz"])(
    "removes the %s link list appended to a reply",
    language => {
      const withLinks = appendKbArticleLinksToReply({
        reply: "Here is the answer.",
        articleLinks: [
          ...articleLinks,
          { url: "https://help.example.com/refunds", title: "Refunds" },
        ],
        language,
      });
      expect(stripKbArticleLinksFooter(withLinks)).toBe("Here is the answer.");
    }
  );

  it("keeps text that only looks like a list", () => {
    const reply = "Steps:\n1. Open settings\n2. Save";
    expect(stripKbArticleLinksFooter(reply)).toBe(reply);
  });
});

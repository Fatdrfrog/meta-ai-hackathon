import { buildGroundedReplyOptionsFromKbArticles } from "@/lib/airi/rag/response/rag-response-routing";

describe("grounded reply options", () => {
  it("filters generic headings and keeps labels within WhatsApp button limits", () => {
    const options = buildGroundedReplyOptionsFromKbArticles(
      [
        {
          id: "kb-q-and-a",
          sourceRecordId: "source-q-and-a",
          documentId: "doc-q-and-a",
          title: "Q/A",
          fullContent: "A generic FAQ heading should not be a reply option.",
          similarity: 0.8,
          locale: "en",
        },
        {
          id: "kb-foundation",
          sourceRecordId: "source-foundation",
          documentId: "doc-foundation",
          title: "Foundation program application requirements and scholarships",
          fullContent:
            "The foundation program includes application requirements and scholarships.",
          similarity: 0.9,
          locale: "en",
        },
        {
          id: "kb-format",
          sourceRecordId: "source-format",
          documentId: "doc-format",
          citationLabel: "Курс форматы туралы толық ақпарат",
          title: "Курс форматы туралы толық ақпарат",
          fullContent: "Курс форматы туралы толық ақпарат берілген.",
          similarity: 0.9,
          locale: "kz",
        },
      ],
      4
    );

    expect(options.map(option => option.label)).toEqual([
      "Foundation program",
      "Курс форматы туралы",
    ]);
    expect(options.every(option => option.label.length <= 20)).toBe(true);
  });
});

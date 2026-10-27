import {
  normalizeReplyText,
  stripLlmJsonGlueDuplicateSuffix,
} from "@/lib/airi/reply/generation/reply-text-sanitize";

describe("stripLlmJsonGlueDuplicateSuffix", () => {
  it("removes duplicate opening after spurious quote following a period", () => {
    const main =
      "Understood.\n\nTo help you with what's needed for participation, are you looking for the specific list of documents for the first round?\n\nI can help you find that information.";
    const junk = `${main.slice(0, -1)}."Understood.\n\nTo help you with`;
    expect(stripLlmJsonGlueDuplicateSuffix(junk)).toBe(main);
  });

  it("removes duplicate when quote is curly", () => {
    const main =
      "Hello there. This is the full reply ending with a closing thought.";
    const junk = `${main}\u201cHello there. This is the full`;
    expect(stripLlmJsonGlueDuplicateSuffix(junk)).toBe(main);
  });

  it("leaves legitimate text unchanged when tail does not repeat the opening", () => {
    const text =
      'The policy is clear. "Exceptions apply only for enterprise accounts." Contact sales for details.';
    expect(stripLlmJsonGlueDuplicateSuffix(text)).toBe(text);
  });

  it("returns short strings unchanged", () => {
    expect(stripLlmJsonGlueDuplicateSuffix("Hi.")).toBe("Hi.");
  });
});

describe("reply text sanitization", () => {
  it("removes internal numeric citation markers from customer-facing replies", () => {
    expect(
      normalizeReplyText(
        "The grant covers 70% to 90% of tuition [1]. Steps: documents [20, 21], interview.",
        500
      )
    ).toBe(
      "The grant covers 70% to 90% of tuition. Steps: documents, interview."
    );
  });

  it("keeps normal markdown links intact", () => {
    expect(
      normalizeReplyText("Fill [the form](https://example.com/apply).", 500)
    ).toBe("Fill [the form](https://example.com/apply).");
  });
});

import { postCheckClaims } from "@/lib/airi/grounding/grounded-claims";

describe("postCheckClaims", () => {
  it("flags factual sentences with no overlap to citation corpus", () => {
    const { unsupportedClaims, confidence } = postCheckClaims({
      answer:
        "Refunds are processed within 5 business days. Thanks for reaching out!",
      citationTexts: ["We offer free shipping on orders over $50."],
    });

    expect(unsupportedClaims.some(s => s.includes("Refunds"))).toBe(true);
    expect(confidence).toBeLessThan(1);
  });

  it("passes when factual sentences overlap citation text", () => {
    const { unsupportedClaims } = postCheckClaims({
      answer: "Refunds are processed within 5 business days.",
      citationTexts: [
        "Refunds are processed within 5 business days for eligible orders.",
      ],
    });

    expect(unsupportedClaims.length).toBe(0);
  });
});

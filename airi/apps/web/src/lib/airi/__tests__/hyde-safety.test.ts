import {
  extractCustomerOnlyConversationContextForHyDE,
  findHyDELeakageMatch,
} from "@/lib/airi/rag/pipeline/hyde-safety";

describe("hyde safety", () => {
  it("keeps only customer messages when building HyDE context", () => {
    const context = `
      2026-04-20 [CUSTOMER] I need pricing details.
      2026-04-20 [AGENT] We have a few options.
      2026-04-20 [CUSTOMER] Please include onboarding fees.
      2026-04-20 [SYSTEM] Internal note
    `;

    expect(extractCustomerOnlyConversationContextForHyDE(context)).toBe(
      "I need pricing details.\nPlease include onboarding fees."
    );
  });

  it("detects near-copy leakage from a hypothetical answer", () => {
    const match = findHyDELeakageMatch(
      "The standard plan starts at 12,000 KZT per month and onboarding is billed separately during setup.",
      [
        {
          source: "kb",
          query: "pricing",
          hypotheticalAnswer:
            "The standard plan starts at 12,000 KZT per month, and onboarding is billed separately during setup.",
        },
      ]
    );

    expect(match).toEqual(
      expect.objectContaining({
        source: "kb",
        reason: expect.any(String),
      })
    );
    expect(match?.tokenOverlap).toBeGreaterThanOrEqual(0.78);
  });

  it("ignores unrelated grounded content", () => {
    const match = findHyDELeakageMatch(
      "We help founders prepare grant applications and supporting documents.",
      [
        {
          source: "snippet",
          query: "pricing",
          hypotheticalAnswer:
            "The standard plan starts at 12,000 KZT per month with onboarding billed separately.",
        },
      ]
    );

    expect(match).toBeNull();
  });
});

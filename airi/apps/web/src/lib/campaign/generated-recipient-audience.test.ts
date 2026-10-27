import {
  advanceGeneratedRecipientAudience,
  createGeneratedRecipientAudience,
  generatedRecipientAudiencesEqual,
} from "./generated-recipient-audience";

describe("generated recipient audience evidence", () => {
  it("builds the same bounded aggregate regardless of page boundaries", () => {
    const allAtOnce = advanceGeneratedRecipientAudience(
      createGeneratedRecipientAudience(),
      ["message-1", "message-2", "message-3"]
    );
    const paged = advanceGeneratedRecipientAudience(
      advanceGeneratedRecipientAudience(createGeneratedRecipientAudience(), [
        "message-1",
      ]),
      ["message-2", "message-3"]
    );

    expect(paged).toEqual(allAtOnce);
    expect(paged.count).toBe(3);
    expect(generatedRecipientAudiencesEqual(paged, allAtOnce)).toBe(true);
  });

  it("is order-sensitive and rejects an oversized append page", () => {
    const forward = advanceGeneratedRecipientAudience(
      createGeneratedRecipientAudience(),
      ["message-1", "message-2"]
    );
    const reverse = advanceGeneratedRecipientAudience(
      createGeneratedRecipientAudience(),
      ["message-2", "message-1"]
    );

    expect(generatedRecipientAudiencesEqual(forward, reverse)).toBe(false);
    expect(() =>
      advanceGeneratedRecipientAudience(
        createGeneratedRecipientAudience(),
        Array.from({ length: 1001 }, (_, index) => `message-${index}`)
      )
    ).toThrow("at most 1000");
  });
});

import {
  getPaymentEvidenceCandidateIndices,
  mapClassificationPaymentSuggestions,
  parseClassificationPaymentEvidence,
} from "./conversation-payment-evidence";

const message = {
  _id: "68a000000000000000000002",
  direction: "inbound",
  author: { isBot: false },
  text: "Оплатила 45 000 тенге, вот чек",
  date: new Date("2026-09-10T09:00:00Z"),
};
const evidence = {
  message_index: 0,
  kind: "payment_claim" as const,
  amount: 45000,
  currency: "KZT",
};

describe("classification payment evidence", () => {
  it.each(["Оплатил", "Төледім", "To‘lov qildim", "I paid", "Payment receipt"])(
    "admits payment language in %s without a model call",
    text => {
      expect(
        getPaymentEvidenceCandidateIndices([{ ...message, text }])
      ).toEqual([0]);
    }
  );

  it("never admits an outbound/bot confirmation, or ordinary conversation", () => {
    expect(
      getPaymentEvidenceCandidateIndices([
        { ...message, direction: "outbound" },
        { ...message, author: { isBot: true } },
        { ...message, text: "Hello, what are your opening hours?" },
        { ...message, direction: undefined },
      ])
    ).toEqual([]);
  });

  it("reuses stored receipt analysis and admits at most three recent candidates", () => {
    expect(
      getPaymentEvidenceCandidateIndices(
        Array.from({ length: 20 }, () => ({
          ...message,
          text: "",
          imageAnalysis: "Receipt: 45000 KZT. Status: successful.",
        }))
      )
    ).toEqual([17, 18, 19]);
  });

  it("maps an incoming payment evidenced only by stored video analysis", () => {
    const videoMessage = {
      ...message,
      text: "",
      videoAnalysis: "Payment receipt: 45000 KZT, successful transfer.",
    };
    expect(getPaymentEvidenceCandidateIndices([videoMessage])).toEqual([0]);
    expect(
      mapClassificationPaymentSuggestions([evidence], [videoMessage])
    ).toEqual([
      expect.objectContaining({ messageId: message._id, amount: 45000 }),
    ]);
  });

  it("maps only evidence grounded in incoming messages to stable IDs and timestamps", () => {
    expect(mapClassificationPaymentSuggestions([evidence], [message])).toEqual([
      {
        messageId: message._id,
        kind: "payment_claim",
        amount: 45000,
        currency: "KZT",
        occurredAt: "2026-09-10T09:00:00.000Z",
      },
    ]);
    expect(
      mapClassificationPaymentSuggestions(
        [evidence],
        [{ ...message, direction: "outbound" }]
      )
    ).toEqual([]);
    expect(
      mapClassificationPaymentSuggestions(
        [evidence],
        [{ ...message, text: "Hello" }]
      )
    ).toEqual([]);
    expect(
      mapClassificationPaymentSuggestions(
        [evidence],
        [{ ...message, date: "bad date" as unknown as Date }]
      )
    ).toEqual([]);
  });

  it("keeps unknown amounts/currency unknown and suppresses duplicates", () => {
    const item = { ...evidence, amount: null, currency: null };
    expect(parseClassificationPaymentEvidence([item, item], 1)).toEqual([item]);
    expect(parseClassificationPaymentEvidence(Array(4).fill(item), 1)).toEqual(
      []
    );
  });
});

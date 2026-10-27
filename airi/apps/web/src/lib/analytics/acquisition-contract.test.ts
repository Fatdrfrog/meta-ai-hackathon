import { acquisitionEntry, comparableEfficiency } from "./acquisition-contract";

describe("acquisition cohort identity and observation", () => {
  const input = {
    workspaceId: "w",
    conversationId: "c",
    sourceId: "s",
    capturedAt: new Date("2026-09-01T00:00:00Z"),
    channel: "whatsapp",
  };
  it("deduplicates repeated receipts for one click but retains repeat-entry clicks", () => {
    const first = acquisitionEntry({
      ...input,
      messageId: "m1",
      referral: { sourceType: "ad", sourceId: "a", ctwaClid: "click1" },
    });
    expect(
      acquisitionEntry({
        ...input,
        messageId: "m2",
        referral: { sourceType: "ad", sourceId: "a", ctwaClid: "click1" },
      }).entryKey
    ).toBe(first.entryKey);
    expect(
      acquisitionEntry({
        ...input,
        messageId: "m3",
        referral: { sourceType: "ad", sourceId: "a", ctwaClid: "click2" },
      }).entryKey
    ).not.toBe(first.entryKey);
    expect(first.adId).toBe("a");
  });
  it("keeps organic first entry separate and never guesses a click identity", () => {
    expect(acquisitionEntry(input).kind).toBe("organic");
    expect(
      acquisitionEntry({
        ...input,
        messageId: "m1",
        referral: { sourceType: "ad", sourceId: "a" },
      }).identityCoverage
    ).toBe("message");
    expect(acquisitionEntry(input).entryOrder).toBe("c");
    expect(acquisitionEntry({ ...input, messageId: "m1" }).entryOrder).toBe(
      "m1"
    );
  });
  it("keeps a known ad referral as ad even when its ad ID is unavailable", () => {
    const referral = { sourceType: "ad", ctwaClid: "known-click" };
    const fact = acquisitionEntry({
      ...input,
      sourceId: null,
      messageId: "m1",
      referral,
    });
    expect(fact.kind).toBe("ad");
    expect(fact.adId).toBeNull();
    expect(
      acquisitionEntry({
        ...input,
        messageId: "m1",
        referral: { ...referral, sourceId: "known-ad" },
      }).entryKey
    ).toBe(fact.entryKey);
  });
  it("withholds efficiency for partial, mismatched currency, timezone or scope", () => {
    const base = {
      spend: 100,
      spendCurrency: "USD",
      revenue: 300,
      revenueCurrency: "USD",
      qualified: 5,
      paid: 2,
      comparable: true,
    };
    expect(comparableEfficiency(base)).toEqual({
      costPerQualified: 20,
      costPerPaid: 50,
      netRoas: 3,
    });
    expect(
      comparableEfficiency({ ...base, comparable: false }).netRoas
    ).toBeNull();
    expect(
      comparableEfficiency({ ...base, revenueCurrency: "KZT" }).netRoas
    ).toBeNull();
    expect(
      comparableEfficiency({ ...base, spend: 0, paid: 0 }).costPerPaid
    ).toBeNull();
  });
  it.each([null, Infinity, NaN])(
    "never presents unknown or invalid revenue as verified ROAS: %s",
    revenue => {
      expect(
        comparableEfficiency({
          spend: 100,
          spendCurrency: "USD",
          revenue,
          revenueCurrency: "USD",
          qualified: 5,
          paid: 2,
          comparable: true,
        }).netRoas
      ).toBeNull();
    }
  );
});

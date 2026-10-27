import {
  buildWhatsAppAnalyticsPipeline,
  normalizeWhatsAppLocalAnalytics,
  normalizeProviderPricing,
  normalizeTemplateAnalytics,
} from "./whatsapp-analytics";
import {
  resolveWhatsAppTariffEstimate,
  classifyWhatsAppPricing,
} from "@icecore/shared/constants/whatsapp-message-rates";
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn() },
}));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));

describe("WhatsApp analytics truth boundaries", () => {
  it.each<[unknown, number | null, number | null, number | null]>([
    [undefined, null, null, null],
    [null, null, null, null],
    [[], null, null, null],
    [[{ type: "url_button", count: 2 }], 2, null, null],
    [[{ type: "future_button", count: 3 }], null, null, null],
    [
      [
        { type: "url_button", count: 0 },
        { type: "unique_url_button", count: 0 },
        { type: "quick_reply_button", count: 0 },
      ],
      0,
      0,
      0,
    ],
  ])(
    "requires an explicit reported count for each click type: %j",
    (clicked, expectedUrl, expectedUnique, expectedQuick) => {
      const [result] = normalizeTemplateAnalytics(
        {
          template_analytics: {
            data: [
              {
                data_points: [{ template_id: "1", delivered: 2, clicked }],
              },
            ],
          },
        },
        "USD"
      );
      expect(result).toMatchObject({
        clicked: expectedUrl,
        uniqueClicked: expectedUnique,
        quickReplyClicked: expectedQuick,
        clickRate: expectedUnique === null ? null : expectedUnique / 2,
      });
    }
  );
  it("does not total partially reported click types across daily points", () => {
    const [result] = normalizeTemplateAnalytics(
      {
        template_analytics: {
          data: [
            {
              data_points: [
                {
                  template_id: "1",
                  delivered: 2,
                  clicked: [
                    { type: "url_button", count: 3 },
                    { type: "unique_url_button", count: 1 },
                  ],
                },
                {
                  template_id: "1",
                  delivered: 2,
                  clicked: [{ type: "url_button", count: 2 }],
                },
              ],
            },
          ],
        },
      },
      "USD"
    );
    expect(result).toMatchObject({
      clicked: 5,
      uniqueClicked: null,
      quickReplyClicked: null,
      clickRate: null,
    });
  });
  it("restores independently unavailable click types without turning them into zero", () => {
    const [result] = normalizeTemplateAnalytics(
      {
        template_analytics: {
          data: [
            {
              data_points: [
                {
                  template_id: "1",
                  sent: 2,
                  delivered: 2,
                  clicked: [
                    { type: "url_button", count: null },
                    { type: "unique_url_button", count: 1 },
                    { type: "quick_reply_button", count: null },
                  ],
                },
              ],
            },
          ],
        },
      },
      "USD"
    );
    expect(result).toMatchObject({
      clicked: null,
      uniqueClicked: 1,
      quickReplyClicked: null,
      clickRate: 0.5,
    });
  });
  it("preserves absent read/click coverage and partially withheld daily costs", () => {
    const [result] = normalizeTemplateAnalytics(
      {
        template_analytics: {
          data: [
            {
              data_points: [
                {
                  template_id: "1",
                  sent: 2,
                  delivered: 2,
                  read: 1,
                  clicked: [],
                  cost: [{ type: "amount_spent", value: 0.1 }],
                },
                { template_id: "1", sent: 2, delivered: 1 },
              ],
            },
          ],
        },
      },
      "USD"
    );
    expect(result).toMatchObject({
      sent: 4,
      delivered: 3,
      read: null,
      uniqueClicked: null,
      readRate: null,
      clickRate: null,
      cost: null,
      costPerDelivered: null,
    });
  });
  it("keeps absent and conflicting receipts unknown rather than free", () => {
    expect(classifyWhatsAppPricing({})).toBe("unknown");
    expect(
      classifyWhatsAppPricing({
        pricingType: "regular",
        pricingBillable: false,
      })
    ).toBe("unknown");
    expect(
      classifyWhatsAppPricing({
        pricingType: "free_entry_point",
        pricingBillable: false,
      })
    ).toBe("free");
  });
  it("prices service only with explicit market, date, currency and tier coverage", () => {
    const tariff = {
      market: "KZ",
      currency: "USD",
      category: "service",
      tier: "list",
      effectiveFrom: "2026-10-01",
      effectiveUntil: "2027-01-01",
      rate: 0.018,
      version: "verified-card",
    };
    expect(
      resolveWhatsAppTariffEstimate({
        category: "service",
        market: "KZ",
        currency: "USD",
        tier: "list",
        at: "2026-10-02",
        tariffs: [tariff],
      })
    ).toEqual({ amount: 0.018, currency: "USD", version: "verified-card" });
    expect(
      resolveWhatsAppTariffEstimate({
        category: "service",
        market: "RU",
        currency: "USD",
        tier: "list",
        at: "2026-10-02",
        tariffs: [tariff],
      })
    ).toBeNull();
    expect(
      resolveWhatsAppTariffEstimate({
        category: "service",
        market: "KZ",
        currency: "USD",
        tier: "list",
        at: "2027-01-01",
        tariffs: [tariff],
      })
    ).toBeNull();
  });
  it("deduplicates before attributing replies, scopes every provider join and bounds execution", () => {
    const start = new Date("2026-10-01T00:00:00Z");
    const stages = buildWhatsAppAnalyticsPipeline({
      workspaceId: "w",
      start,
      end: new Date("2026-10-02T00:00:00Z"),
      sourceId: "s",
      timeZone: "Asia/Almaty",
    });
    // One indexed pass over both directions feeds the reply and next-send windows.
    expect(stages[0]).toMatchObject({
      $match: {
        workspaceId: "w",
        channel: "whatsapp",
        direction: { $in: ["outbound", "inbound"] },
        date: { $gte: start },
      },
    });
    expect(stages).toContainEqual(
      expect.objectContaining({
        $match: expect.objectContaining({
          direction: "outbound",
          $or: [
            { "origin.sourceId": { $in: ["s"] } },
            { "origin.sourceId": null },
          ],
        }),
      })
    );
    const json = JSON.stringify(stages);
    // Correlated per-send lookups exceeded the 25 s budget on large workspaces.
    expect(json).not.toContain('"$lookup"');
    expect(json).toContain('"$setWindowFields"');
    // Receipts are read once, from a day before the window.
    expect(stages.find(stage => "$unionWith" in stage)).toMatchObject({
      $unionWith: {
        coll: "messagedeliveryevents",
        pipeline: expect.arrayContaining([
          {
            $match: {
              workspaceId: "w",
              eventAt: {
                $gte: new Date("2026-09-30T00:00:00Z"),
                $lte: new Date("2026-10-02T00:00:00Z"),
              },
            },
          },
        ]),
      },
    });
    const stageIndex = (text: string) =>
      stages.findIndex(stage => JSON.stringify(stage).includes(text));
    expect(stageIndex("$sends.whatsappWamidFingerprint")).toBeLessThan(
      stageIndex("_nextOutboundAt")
    );
    expect(json).toContain("pricingBillable");
    expect(json).toContain('"timezone":"Asia/Almaty"');
    expect(json).not.toContain('"timezone":"UTC"');
  });
  it("returns a truthful zero denominator and missing latency", () => {
    const result = normalizeWhatsAppLocalAnalytics({});
    expect(result.delivery.accepted).toBe(0);
    expect(result.delivery.deliveredRate).toBeNull();
    expect(result.delivery.medianDeliverySeconds).toBeNull();
    expect(result.pricing.unknown).toBe(0);
  });
  it("preserves currencies and country/category/tier dimensions without inventing missing cost", () => {
    const result = normalizeProviderPricing(
      {
        pricing_analytics: {
          data: [
            {
              data_points: [
                {
                  country: "KZ",
                  phone_number: "private",
                  pricing_category: "SERVICE",
                  pricing_type: "REGULAR",
                  tier: "list",
                  volume: 4,
                },
              ],
            },
          ],
        },
      },
      "KZT"
    );
    expect(result[0]).toMatchObject({
      country: "KZ",
      category: "SERVICE",
      type: "REGULAR",
      tier: "list",
      volume: 4,
      cost: null,
      currency: "KZT",
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("adds provider template days without confusing URL clicks and unique clicks", () => {
    const result = normalizeTemplateAnalytics(
      {
        template_analytics: {
          data: [
            {
              data_points: [
                {
                  template_id: "1",
                  start: 1,
                  end: 2,
                  sent: 8,
                  delivered: 7,
                  read: 4,
                  clicked: [
                    { type: "url_button", count: 3 },
                    { type: "unique_url_button", count: 2 },
                    { type: "quick_reply_button", count: 1 },
                  ],
                  cost: [{ type: "amount_spent", value: 0.4 }],
                },
              ],
            },
          ],
        },
      },
      "USD"
    );
    expect(result[0]).toMatchObject({
      id: "1",
      sent: 8,
      delivered: 7,
      read: 4,
      clicked: 3,
      uniqueClicked: 2,
      quickReplyClicked: 1,
      cost: 0.4,
      currency: "USD",
    });
  });
});

const mockGetPhoneNumberDetails = jest.fn();
const mockGetWABASendingReadiness = jest.fn();
jest.mock("@/lib/whatsapp/waba-service", () => ({
  getWABASendingReadiness: (...args: unknown[]) =>
    mockGetWABASendingReadiness(...args),
}));

jest.mock("@/lib/whatsapp/qr-code-service", () => ({
  getPhoneNumberDetails: (...args: unknown[]) =>
    mockGetPhoneNumberDetails(...args),
}));

import {
  assertCampaignPlanSendingReadiness,
  resolveCampaignBatchPlan,
  resolveCampaignBatchPlanPreview,
} from "@/lib/campaign/campaign-batch-plan";
import { MAX_BULK_CAMPAIGN_RECIPIENTS } from "@/lib/campaign/bulk-campaign-contracts";

describe("resolveCampaignBatchPlan", () => {
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWABASendingReadiness.mockResolvedValue({
      state: "ready",
      checkedAt: new Date().toISOString(),
      remainingCapacity: null,
      reasons: [],
    });
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it("uses the Meta phone throughput when the number is upgraded", async () => {
    mockGetPhoneNumberDetails.mockResolvedValue({
      display_phone_number: "+1 555 000 1111",
      verified_name: "Acme Support",
      quality_rating: "GREEN",
      throughput: { level: "HIGH" },
    });

    const plan = await resolveCampaignBatchPlan({
      channel: "whatsapp",
      phoneNumberId: "phone-1",
      accessToken: "token-1",
    });

    expect(plan).toEqual(
      expect.objectContaining({
        batchSize: 100,
        delayMs: 100,
        ratePerSecond: 1000,
        rateSource: "meta_phone_throughput",
        throughputLevel: "HIGH",
      })
    );
  });

  it("returns WhatsApp preview metadata from the Meta phone details lookup", async () => {
    mockGetPhoneNumberDetails.mockResolvedValue({
      display_phone_number: "+1 555 000 1111",
      verified_name: "Acme Support",
      quality_rating: "GREEN",
      throughput: { level: "HIGH" },
      whatsapp_business_manager_messaging_limit: "TIER_2K",
    });

    const preview = await resolveCampaignBatchPlanPreview({
      channel: "whatsapp",
      phoneNumberId: "phone-1",
      accessToken: "token-1",
    });

    expect(preview).toEqual(
      expect.objectContaining({
        channel: "whatsapp",
        batchPlan: expect.objectContaining({
          batchSize: 100,
          delayMs: 100,
          ratePerSecond: 1000,
          throughputLevel: "HIGH",
        }),
        whatsappMeta: expect.objectContaining({
          phoneNumberId: "phone-1",
          displayPhoneNumber: "+1 555 000 1111",
          verifiedName: "Acme Support",
          qualityRating: "GREEN",
          throughputLevel: "HIGH",
          detailsSource: "meta_phone_details",
        }),
        recipientLimit: expect.objectContaining({
          maxRecipients: 2000,
          rawLimit: "TIER_2K",
          source: "live_meta",
        }),
      })
    );
  });

  it("keeps a business block even when phone status, throughput, and tier are available", async () => {
    mockGetPhoneNumberDetails.mockResolvedValue({
      status: "CONNECTED",
      throughput: { level: "STANDARD" },
      whatsapp_business_manager_messaging_limit: "TIER_250",
    });
    mockGetWABASendingReadiness.mockResolvedValue({
      state: "blocked",
      checkedAt: new Date().toISOString(),
      remainingCapacity: null,
      reasons: [{ code: "meta_business_limit", providerCode: "141015" }],
    });
    const preview = await resolveCampaignBatchPlanPreview({
      channel: "whatsapp",
      wabaId: "waba-1",
      phoneNumberId: "phone-1",
      accessToken: "token-1",
    });
    expect(preview.readiness?.state).toBe("blocked");
    expect(preview.recipientLimit.maxRecipients).toBe(250);
    expect(preview.readiness?.remainingCapacity).toBeNull();
    expect(mockGetWABASendingReadiness).toHaveBeenCalledWith({
      wabaId: "waba-1",
      accessToken: "token-1",
    });
  });

  it("does not allow cached tier data to mark a failed live lookup ready", async () => {
    mockGetPhoneNumberDetails.mockRejectedValue(
      new Error("network unavailable")
    );
    const preview = await resolveCampaignBatchPlanPreview({
      channel: "whatsapp",
      wabaId: "waba-1",
      phoneNumberId: "phone-1",
      accessToken: "token-1",
      cachedMessagingLimit: "TIER_250",
    });
    expect(preview.readiness?.state).toBe("unavailable");
  });

  it.each(["blocked", "unavailable"])(
    "rejects a new WhatsApp send when readiness is %s",
    async state => {
      mockGetPhoneNumberDetails.mockResolvedValue({
        status: "CONNECTED",
        whatsapp_business_manager_messaging_limit: "TIER_250",
      });
      mockGetWABASendingReadiness.mockResolvedValue({
        state,
        checkedAt: new Date().toISOString(),
        remainingCapacity: null,
        reasons: [
          {
            code:
              state === "blocked"
                ? "meta_sender_restricted"
                : "meta_check_unavailable",
          },
        ],
      });
      const preview = await resolveCampaignBatchPlanPreview({
        channel: "whatsapp",
        wabaId: "waba-1",
        phoneNumberId: "phone-1",
        accessToken: "token",
      });
      expect(() => assertCampaignPlanSendingReadiness(preview)).toThrow(
        /WhatsApp campaign sending/
      );
    }
  );

  it("requires a valid readiness decision and permits ready or non-WhatsApp plans", async () => {
    mockGetPhoneNumberDetails.mockResolvedValue({
      status: "CONNECTED",
      whatsapp_business_manager_messaging_limit: "TIER_250",
    });
    const preview = await resolveCampaignBatchPlanPreview({
      channel: "whatsapp",
      wabaId: "waba-1",
      phoneNumberId: "phone-1",
      accessToken: "token",
    });
    expect(() => assertCampaignPlanSendingReadiness(preview)).not.toThrow();
    expect(() =>
      assertCampaignPlanSendingReadiness({ ...preview, readiness: undefined })
    ).toThrow(/unavailable/);
    expect(() =>
      assertCampaignPlanSendingReadiness({
        ...preview,
        readiness: { ...preview.readiness!, checkedAt: "invalid" },
      })
    ).toThrow(/unavailable/);
    expect(() =>
      assertCampaignPlanSendingReadiness({
        ...preview,
        channel: "email",
        readiness: undefined,
      })
    ).not.toThrow();
    expect(() =>
      assertCampaignPlanSendingReadiness({
        ...preview,
        channel: "telegram",
        readiness: undefined,
      })
    ).not.toThrow();
  });

  it("parses common Meta messaging limit tiers", async () => {
    const tiers = [
      ["TIER_250", 250],
      ["TIER_1K", 1000],
      ["TIER_2K", 2000],
      ["TIER_10K", 10000],
      ["TIER_100K", MAX_BULK_CAMPAIGN_RECIPIENTS],
      ["UNLIMITED", MAX_BULK_CAMPAIGN_RECIPIENTS],
      ["2000", 2000],
    ] as const;

    for (const [rawLimit, maxRecipients] of tiers) {
      mockGetPhoneNumberDetails.mockResolvedValueOnce({
        throughput: { level: "STANDARD" },
        whatsapp_business_manager_messaging_limit: rawLimit,
      });

      const preview = await resolveCampaignBatchPlanPreview({
        channel: "whatsapp",
        phoneNumberId: "phone-1",
        accessToken: "token-1",
      });

      expect(preview.recipientLimit).toEqual(
        expect.objectContaining({
          maxRecipients,
          rawLimit,
          source: "live_meta",
        })
      );
    }
  });

  it("falls back to the cached messaging limit when the live lookup fails", async () => {
    mockGetPhoneNumberDetails.mockRejectedValue(new Error("boom"));

    const preview = await resolveCampaignBatchPlanPreview({
      channel: "whatsapp",
      phoneNumberId: "phone-1",
      accessToken: "token-1",
      cachedMessagingLimit: "TIER_10K",
    });

    expect(preview.recipientLimit).toEqual(
      expect.objectContaining({
        maxRecipients: 10000,
        rawLimit: "TIER_10K",
        source: "cached_meta",
        warning:
          "Meta phone number details are unavailable. Using the default WhatsApp dispatch plan.",
      })
    );
  });

  it("falls back to the documented default WhatsApp throughput when lookup fails", async () => {
    mockGetPhoneNumberDetails.mockRejectedValue(new Error("boom"));

    const plan = await resolveCampaignBatchPlan({
      channel: "whatsapp",
      phoneNumberId: "phone-1",
      accessToken: "token-1",
    });

    expect(plan).toEqual(
      expect.objectContaining({
        batchSize: 20,
        delayMs: 250,
        ratePerSecond: 80,
        rateSource: "meta_default_throughput",
        throughputLevel: "STANDARD",
      })
    );
  });

  it("returns a preview warning when the Meta phone details lookup fails", async () => {
    mockGetPhoneNumberDetails.mockRejectedValue(new Error("boom"));

    const preview = await resolveCampaignBatchPlanPreview({
      channel: "whatsapp",
      phoneNumberId: "phone-1",
      accessToken: "token-1",
    });

    expect(preview).toEqual(
      expect.objectContaining({
        channel: "whatsapp",
        batchPlan: expect.objectContaining({
          batchSize: 20,
          delayMs: 250,
          ratePerSecond: 80,
          rateSource: "meta_default_throughput",
          throughputLevel: "STANDARD",
        }),
        whatsappMeta: expect.objectContaining({
          phoneNumberId: "phone-1",
          throughputLevel: "STANDARD",
          detailsSource: "meta_lookup_failed",
          warning:
            "Meta phone number details are unavailable. Using the default WhatsApp dispatch plan.",
        }),
      })
    );
  });

  it("uses the default WhatsApp recipient limit with a friendly warning when the live lookup fails without a cached limit", async () => {
    mockGetPhoneNumberDetails.mockRejectedValue(
      new Error(
        'Failed to get phone number details: {"error":{"message":"Unsupported get request.","type":"GraphMethodException","code":100,"error_subcode":33}}'
      )
    );

    const preview = await resolveCampaignBatchPlanPreview({
      channel: "whatsapp",
      phoneNumberId: "phone-1",
      accessToken: "token-1",
    });

    expect(preview.recipientLimit).toEqual(
      expect.objectContaining({
        maxRecipients: 1000,
        rawLimit: "1000",
        source: "channel_default",
        warning:
          "Meta phone number details are unavailable. Using the default WhatsApp dispatch plan.",
      })
    );
    expect(preview.recipientLimit?.error).toBeUndefined();
    expect(preview.whatsappMeta?.warning).toBe(
      "Meta phone number details are unavailable. Using the default WhatsApp dispatch plan."
    );
    expect(preview.whatsappMeta?.warning).not.toContain("GraphMethodException");
  });

  it("keeps fixed defaults for non-WhatsApp channels", async () => {
    const plan = await resolveCampaignBatchPlan({
      channel: "email",
    });

    expect(plan).toEqual(
      expect.objectContaining({
        batchSize: 20,
        delayMs: 334,
        ratePerSecond: 60,
        rateSource: "channel_default",
      })
    );
    expect(mockGetPhoneNumberDetails).not.toHaveBeenCalled();
  });

  it("keeps Telegram bulk dispatch at Telegram's free broadcast limit", async () => {
    const preview = await resolveCampaignBatchPlanPreview({
      channel: "telegram",
    });

    const effectiveRatePerSecond =
      preview.batchPlan.batchSize / (preview.batchPlan.delayMs / 1000);

    expect(preview.batchPlan).toEqual(
      expect.objectContaining({
        batchSize: 30,
        delayMs: 1000,
        ratePerSecond: 30,
        rateSource: "telegram_free_broadcast_limit",
      })
    );
    expect(effectiveRatePerSecond).toBeLessThanOrEqual(30);
    expect(mockGetPhoneNumberDetails).not.toHaveBeenCalled();
  });
});

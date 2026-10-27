const mockSource = jest.fn();
jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentialsResult: (...args: unknown[]) => mockSource(...args),
}));
jest.mock("./source-config", () => ({
  readWhatsAppConversionsConfiguration: (
    credentials: Record<string, unknown>
  ) => credentials.conversions_api,
}));
jest.mock("@/lib/meta-ads/whatsapp-conversions-api", () => ({
  validateMetaConversionSnapshot: () => null,
}));

import { prepareMetaConversionIntent } from "./meta-conversion-intent";

const now = new Date().toISOString();
const input = {
  workspaceId: "workspace-1",
  sourceId: "source-1",
  conversionType: "sale",
  value: 12000,
  currency: "KZT",
  occurredAt: now,
  metadata: {
    whatsappReferralStatus: "attributed",
    whatsappReferral: { ctwaClid: "click-123", capturedAt: now },
    paymentEvidence: { receiptText: "private receipt text" },
  },
};
const source = {
  id: "source-1",
  workspace_id: "workspace-1",
  type: "whatsapp",
  credentials: {
    waba_id: "123",
    access_token: "secret",
    conversions_api: {
      enabled: true,
      dataset_id: "456",
      waba_id: "123",
      configured_at: now,
    },
  },
};

beforeEach(() =>
  mockSource.mockReset().mockResolvedValue({ ok: true, source })
);

describe("prepareMetaConversionIntent", () => {
  it("freezes only confirmed facts and the original click destination", async () => {
    const result = await prepareMetaConversionIntent(input);
    expect(result).toEqual({
      meta_delivery_status: "pending",
      meta_delivery_reason: null,
      meta_delivery_snapshot: {
        sourceId: "source-1",
        datasetId: "456",
        wabaId: "123",
        ctwaClid: "click-123",
        eventName: "Purchase",
        eventTime: Math.floor(Date.parse(now) / 1000),
        value: 12000,
        currency: "KZT",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|private receipt/);
  });

  it("keeps unmatched sales locally without inventing an ad click", async () => {
    expect(
      await prepareMetaConversionIntent({ ...input, metadata: {} })
    ).toMatchObject({
      meta_delivery_status: "not_eligible",
      meta_delivery_snapshot: null,
    });
    expect(mockSource).not.toHaveBeenCalled();
  });

  it("never attributes a later referral to an earlier sale", async () => {
    expect(
      await prepareMetaConversionIntent({
        ...input,
        metadata: {
          whatsappReferralStatus: "attributed",
          whatsappReferral: {
            ctwaClid: "later",
            capturedAt: new Date(Date.parse(now) + 1000).toISOString(),
          },
        },
      })
    ).toMatchObject({ meta_delivery_status: "not_eligible" });
  });

  it.each([
    { ...source, workspace_id: "another-workspace" },
    {
      ...source,
      credentials: {
        ...source.credentials,
        conversions_api: {
          ...source.credentials.conversions_api,
          enabled: false,
        },
      },
    },
    { ...source, credentials: { ...source.credentials, waba_id: "different" } },
  ])(
    "does not publish with mismatched or disabled source configuration",
    async nextSource => {
      mockSource.mockResolvedValue({ ok: true, source: nextSource });
      expect(await prepareMetaConversionIntent(input)).toMatchObject({
        meta_delivery_status: "not_eligible",
      });
    }
  );

  it("does not silently discard delivery intent on a source query failure", async () => {
    mockSource.mockResolvedValue({
      ok: false,
      error: new Error("database offline"),
    });
    await expect(prepareMetaConversionIntent(input)).rejects.toThrow(
      "configuration"
    );
  });

  it("keeps an old-account click local after rebind and re-enable", async () => {
    mockSource.mockResolvedValue({
      ok: true,
      source: {
        ...source,
        credentials: {
          ...source.credentials,
          waba_id: "789",
          conversions_api: {
            ...source.credentials.conversions_api,
            waba_id: "789",
            dataset_id: "987",
            attribution_boundary_at: new Date(
              Date.parse(now) - 500
            ).toISOString(),
          },
        },
      },
    });
    const oldClick = {
      ...input,
      metadata: {
        whatsappReferralStatus: "attributed",
        whatsappReferral: {
          ctwaClid: "old-account-click",
          capturedAt: new Date(Date.parse(now) - 1000).toISOString(),
        },
      },
    };
    expect(await prepareMetaConversionIntent(oldClick)).toMatchObject({
      meta_delivery_status: "not_eligible",
      meta_delivery_reason: "whatsapp_account_changed",
      meta_delivery_snapshot: null,
    });
    expect(await prepareMetaConversionIntent(input)).toMatchObject({
      meta_delivery_status: "pending",
      meta_delivery_snapshot: { wabaId: "789", datasetId: "987" },
    });
  });
});

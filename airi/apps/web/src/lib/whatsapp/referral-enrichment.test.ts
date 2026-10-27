jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: (value: unknown) => value,
}));

import {
  buildWhatsAppReferralRagContext,
  buildWhatsAppReferralPromptContext,
  enrichWhatsAppReferralWithMetaAdMetadata,
  normalizeWhatsAppWebhookReferral,
} from "@/lib/whatsapp/referral-enrichment";

test("deferred ingestion preserves raw referral without making a metadata request", async () => {
  const referral = normalizeWhatsAppWebhookReferral({source_type: "ad", source_id: "ad-1"});
  const resolve = jest.fn(async () => null);
  expect(await enrichWhatsAppReferralWithMetaAdMetadata({workspaceId: "workspace-1", referral,
    defer: true, resolveMetaAdMetadata: resolve})).toBe(referral);
  expect(resolve).not.toHaveBeenCalled();
});

describe("WhatsApp referral enrichment", () => {
  it("keeps confirmed campaign labels when a later partial metadata lookup fails", async () => {
    const referral = {
      ...normalizeWhatsAppWebhookReferral({
        source_type: "ad",
        source_id: "ad-1",
      })!,
      adAccountId: "act-1",
      campaignLabels: [{ id: "medal" }],
      campaignLabelStatus: "present" as const,
    };
    const enriched = await enrichWhatsAppReferralWithMetaAdMetadata({
      workspaceId: "workspace-1",
      referral,
      resolveMetaAdMetadata: async () => ({
        campaignId: "campaign-1",
        campaignLabels: [],
        campaignLabelStatus: "unavailable",
      }),
    });
    expect(enriched?.campaignLabelStatus).toBe("present");
    expect(enriched?.campaignLabels).toEqual([{ id: "medal" }]);
    expect(enriched?.adAccountId).toBe("act-1");
  });
  it("normalizes a CTWA referral and enriches it with resolved Meta campaign metadata", async () => {
    const referral = normalizeWhatsAppWebhookReferral({
      source_type: "ad",
      source_id: "120249144478770472",
      source_url: "https://www.instagram.com/p/example",
      headline: "Airi.chat",
      body: "Automate sales with WhatsApp",
      media_type: "image",
      image_url: "https://example.com/ad.jpg",
      ctwa_clid: "clid-1",
      ref: "sequence-ref-1",
      welcome_message: { text: "Здравствуйте" },
    });

    const enriched = await enrichWhatsAppReferralWithMetaAdMetadata({
      workspaceId: "workspace-1",
      referral,
      resolveMetaAdMetadata: async () => ({
        campaignId: "120249144478750472",
        campaignName: '21/06/26 "Вовлеченность WA"',
        adSetId: "120249144478760472",
        adSetName: "21/06/26 Вовлеченность WA",
        adAccountId: "act_42",
        campaignLabels: [{ id: "label-1", name: "Product" }],
        campaignLabelStatus: "present" as const,
      }),
    });

    expect(enriched).toEqual({
      sourceType: "ad",
      sourceId: "120249144478770472",
      sourceUrl: "https://www.instagram.com/p/example",
      campaignId: "120249144478750472",
      campaignName: '21/06/26 "Вовлеченность WA"',
      adSetId: "120249144478760472",
      adSetName: "21/06/26 Вовлеченность WA",
      headline: "Airi.chat",
      body: "Automate sales with WhatsApp",
      mediaType: "image",
      imageUrl: "https://example.com/ad.jpg",
      videoUrl: null,
      thumbnailUrl: null,
      ctwaClid: "clid-1",
      ref: "sequence-ref-1",
      welcomeMessageText: "Здравствуйте",
      adAccountId: "act_42",
      campaignLabels: [{ id: "label-1", name: "Product" }],
      campaignLabelStatus: "present",
    });
  });

  it("keeps an incomplete label payload unavailable instead of treating it as untagged", async () => {
    const referral = normalizeWhatsAppWebhookReferral({
      source_type: "ad",
      source_id: "ad-1",
      campaign_name: "Product A",
    });
    const enriched = await enrichWhatsAppReferralWithMetaAdMetadata({
      workspaceId: "workspace-1",
      referral,
      resolveMetaAdMetadata: async () => ({
        campaignId: "campaign-1",
        campaignLabels: [],
        campaignLabelStatus: "unavailable",
      }),
    });

    expect(enriched?.campaignLabelStatus).toBe("unavailable");
    expect(enriched?.campaignLabels).toEqual([]);
    expect(enriched?.campaignName).toBe("Product A");
  });

  it("builds a factual RAG context without inventing missing campaign fields", () => {
    const referral = normalizeWhatsAppWebhookReferral({
      source_type: "ad",
      source_id: "ad-1",
      source_url: "https://www.instagram.com/p/example",
      headline: "Airi.chat",
    });

    const context = buildWhatsAppReferralRagContext(referral);

    expect(context).toContain("WhatsApp referral context:");
    expect(context).toContain("source_platform=instagram");
    expect(context).toContain("ad_id=ad-1");
    expect(context).toContain("headline=Airi.chat");
    expect(context).not.toContain("campaign=");
    expect(context).not.toContain("adset=");
  });

  it("builds prompt context with an explicit no-inference boundary", () => {
    const promptContext = buildWhatsAppReferralPromptContext({
      sourceType: "ad",
      sourceId: "ad-1",
      sourceUrl: "https://www.instagram.com/p/example",
      campaignId: "campaign-1",
      campaignName: "Launch",
      ref: "sequence-ref-1",
    });

    expect(promptContext).toContain("trusted Meta/WhatsApp metadata");
    expect(promptContext).toContain("campaign=Launch");
    expect(promptContext).toContain("ref=sequence-ref-1");
    expect(promptContext).toContain("Do not infer campaign goals");
  });
});

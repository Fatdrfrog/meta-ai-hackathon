jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn() },
}));

import { projectActiveClientMessageFilters } from "./client-message-trigger-criteria";
import {
  matchesIncomingMessageTrigger,
  projectScenarioIngressContext,
} from "./incoming-message-trigger-matcher";
import {
  campaignLabelLookupRequired,
  enrichIngressReferralPair,
  enrichIngressReferralPairWhenRequired,
} from "./ingress-campaign-metadata";

describe("ingress campaign metadata", () => {
  it("fetches each ad once even when campaign fields are already present", async () => {
    const resolveMetaAdMetadata = jest.fn(async () => ({
      campaignId: "campaign-1",
      campaignName: "Launch",
      adAccountId: "act_42",
      campaignLabels: [{ id: "label-1", name: "Product" }],
      campaignLabelStatus: "present" as const,
    }));

    const enriched = await enrichIngressReferralPair({
      workspaceId: "workspace-1",
      whatsappReferral: {
        sourceId: "ad-1",
        sourceType: "ad",
        campaignId: "campaign-1",
        campaignName: "Launch",
        adSetId: "adset-1",
      },
      metaReferral: {
        sourceId: "ad-1",
        sourceType: "ad",
      },
      resolveMetaAdMetadata,
    });

    expect(resolveMetaAdMetadata).toHaveBeenCalledTimes(1);
    expect(enriched.whatsappReferral?.campaignLabelStatus).toBe("present");
    expect(enriched.metaReferral?.campaignLabels).toEqual([
      { id: "label-1", name: "Product" },
    ]);
    expect(enriched.metaReferral?.productCampaignName).toBe("Launch");
  });

  it("does not replace a confirmed label list", async () => {
    const resolveMetaAdMetadata = jest.fn();
    const enriched = await enrichIngressReferralPair({
      workspaceId: "workspace-1",
      whatsappReferral: {
        sourceId: "ad-1",
        sourceType: "ad",
        campaignId: "campaign-1",
        campaignName: "Launch",
        adSetId: "adset-1",
        adAccountId: "act_42",
        campaignLabels: [],
        campaignLabelStatus: "absent",
      },
      resolveMetaAdMetadata,
    });

    expect(resolveMetaAdMetadata).not.toHaveBeenCalled();
    expect(enriched.whatsappReferral?.campaignLabelStatus).toBe("absent");
  });

  it("keeps a fetched Instagram campaign name out of keyword matching", async () => {
    const keyword = projectActiveClientMessageFilters({
      messageMatchMode: "contains",
      keywordMatchMode: "contains",
      keywordPattern: "Product A",
    });
    const olderInstagramReferral = {
      sourceType: "ad",
      sourceId: "ad-1",
      headline: "Welcome",
    };
    const before = projectScenarioIngressContext({
      eventKind: "inbound_message",
      channel: "instagram",
      messageText: "hello",
      metaReferral: olderInstagramReferral,
    });
    expect(matchesIncomingMessageTrigger(keyword, before)).toBe(false);

    const enriched = await enrichIngressReferralPair({
      workspaceId: "workspace-1",
      metaReferral: olderInstagramReferral,
      whatsappReferral: {
        sourceId: "ad-1",
        sourceType: "ad",
      },
      resolveMetaAdMetadata: async () => ({
        campaignId: "campaign-1",
        campaignName: "Product A launch",
        adAccountId: "act_42",
        campaignLabels: [],
        campaignLabelStatus: "absent" as const,
      }),
    });

    expect(enriched.metaReferral?.campaignName).toBeUndefined();
    expect(enriched.metaReferral?.productCampaignName).toBe("Product A launch");
    expect(enriched.whatsappReferral?.campaignName).toBe("Product A launch");
    const after = projectScenarioIngressContext({
      eventKind: "inbound_message",
      channel: "instagram",
      messageText: "hello",
      metaReferral: enriched.metaReferral,
    });
    expect(matchesIncomingMessageTrigger(keyword, after)).toBe(false);
    expect(
      matchesIncomingMessageTrigger(
        projectActiveClientMessageFilters({
          messageMatchMode: "any",
          metaCampaignNameFallbacks: ["Product A"],
        }),
        after
      )
    ).toBe(true);
  });

  it("does not wait on Meta for keyword routing or a locked continuation", async () => {
    const resolver = jest.fn(() => new Promise<never>(() => undefined));
    const referral = {
      sourceId: "ad-1",
      sourceType: "ad",
    };
    const keyword = await enrichIngressReferralPairWhenRequired({
      required: campaignLabelLookupRequired({
        triggers: [
          {
            messageMatchMode: "contains",
            keywordPattern: "hello",
          },
        ],
      }),
      workspaceId: "workspace-1",
      metaReferral: referral,
      resolveMetaAdMetadata: resolver,
    });
    const locked = await enrichIngressReferralPairWhenRequired({
      required: campaignLabelLookupRequired({
        skipTriggerMatch: true,
        triggers: [
          {
            metaCampaignAdAccountId: "act_42",
            metaCampaignLabels: [{ id: "label-b", name: "Product B" }],
          },
        ],
      }),
      workspaceId: "workspace-1",
      metaReferral: referral,
      resolveMetaAdMetadata: resolver,
    });

    expect(keyword.metaReferral?.sourceId).toBe("ad-1");
    expect(locked.metaReferral?.campaignLabelStatus).toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("waits for Meta only when an evaluated trigger needs campaign labels", async () => {
    let release: (value: null) => void = () => undefined;
    const resolver = jest.fn(
      () =>
        new Promise<null>(resolve => {
          release = resolve;
        })
    );
    let settled = false;
    const pending = enrichIngressReferralPairWhenRequired({
      required: campaignLabelLookupRequired({
        triggers: [{ metaCampaignNameFallbacks: ["Product A"] }],
      }),
      workspaceId: "workspace-1",
      whatsappReferral: {
        sourceId: "ad-1",
        sourceType: "ad",
      },
      resolveMetaAdMetadata: resolver,
    }).then(result => {
      settled = true;
      return result;
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(resolver).toHaveBeenCalledTimes(1);
    release(null);
    await pending;
    expect(settled).toBe(true);
  });
});

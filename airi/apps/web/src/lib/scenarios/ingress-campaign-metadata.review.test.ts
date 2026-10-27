/** @jest-environment node */
import assert from "node:assert/strict";
import type { MetaAdMetadata } from "@/lib/meta-ads/meta-ad-metadata";
import {
  enrichIngressReferralPair,
  type IngressCampaignLabelCarrier,
} from "./ingress-campaign-metadata";

const unknownReferral = { sourceId: "ad-1", sourceType: "ad" };

describe("confirmed campaign metadata in paired referrals", () => {
  for (const channel of ["whatsapp", "meta"] as const) {
    for (const status of ["present", "absent"] as const) {
      for (const response of ["failure", "incomplete", "different"] as const) {
        it(`preserves ${channel} ${status} when its counterpart returns ${response}`, async () => {
          const labels = status === "present" ? [{ id: "product-a", name: "Alpha" }] : [];
          const confirmed: IngressCampaignLabelCarrier = Object.freeze({
            ...unknownReferral, campaignId: "campaign-1", campaignName: "Alpha",
            adAccountId: "act_42", campaignLabelStatus: status,
            campaignLabels: Object.freeze(labels),
          });
          let calls = 0;
          const resolveMetaAdMetadata = async (): Promise<MetaAdMetadata | null> => {
            calls += 1;
            if (response === "failure") throw new Error("Graph temporarily unavailable");
            return {
              campaignId: "campaign-1", campaignName: "Other name", adAccountId: "act_42",
              campaignLabels: [],
              campaignLabelStatus: response === "incomplete" ? "unavailable" : "absent",
            };
          };
          const result = await enrichIngressReferralPair({
            workspaceId: "workspace-1",
            whatsappReferral: channel === "whatsapp" ? confirmed : unknownReferral,
            metaReferral: channel === "meta" ? confirmed : unknownReferral,
            resolveMetaAdMetadata,
          });
          const preserved = channel === "whatsapp" ? result.whatsappReferral : result.metaReferral;
          const enriched = channel === "whatsapp" ? result.metaReferral : result.whatsappReferral;
          assert.equal(calls, 1);
          assert.equal(preserved, confirmed);
          assert.equal(preserved?.campaignLabelStatus, status);
          assert.deepEqual(preserved?.campaignLabels, labels);
          assert.equal(enriched?.campaignLabelStatus, response === "different" ? "absent" : "unavailable");
          assert.equal("campaignLabelStatus" in unknownReferral, false);
        });
      }
    }
  }

  it("still resolves two unconfirmed carriers for the same ad once", async () => {
    let calls = 0;
    const result = await enrichIngressReferralPair({
      workspaceId: "workspace-1", whatsappReferral: unknownReferral, metaReferral: unknownReferral,
      resolveMetaAdMetadata: async () => {
        calls += 1;
        return { campaignId: "campaign-1", campaignName: "Alpha", adAccountId: "act_42", campaignLabels: [], campaignLabelStatus: "absent" };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.whatsappReferral?.campaignLabelStatus, "absent");
    assert.equal(result.metaReferral?.campaignLabelStatus, "absent");
    assert.equal(result.whatsappReferral?.campaignName, "Alpha");
    assert.equal(result.metaReferral?.campaignName, undefined);
    assert.equal(result.metaReferral?.productCampaignName, "Alpha");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeClientMessageTriggerConfig } from "./client-message-trigger.ts";

const labels = [{ id: "product-a", name: "Alpha" }];

describe("incomplete campaign label drafts", () => {
  for (const account of [undefined, "", "   "]) {
    it(`preserves the label filter with account ${JSON.stringify(account)}`, () => {
      const raw = { metaCampaignLabels: labels, metaCampaignAdAccountId: account };
      const result = normalizeClientMessageTriggerConfig(raw);
      assert.deepEqual(result.metaCampaignLabels, labels);
      assert.equal(result.metaCampaignAdAccountId, undefined);
      assert.deepEqual(normalizeClientMessageTriggerConfig(result), result);
      assert.notEqual(result.metaCampaignLabels, labels);
      assert.deepEqual(raw.metaCampaignLabels, labels);
    });
  }

  it("preserves incomplete labels alongside names instead of silently broadening", () => {
    const result = normalizeClientMessageTriggerConfig({
      metaCampaignLabels: labels, metaCampaignNameFallbacks: [" Alpha "],
    });
    assert.deepEqual(result.metaCampaignLabels, labels);
    assert.deepEqual(result.metaCampaignNameFallbacks, ["Alpha"]);
  });

  it("does not add product filters to saved exact filters", () => {
    const result = normalizeClientMessageTriggerConfig({
      metaReferralCampaignIds: ["campaign-1"],
      metaReferralAdSetIds: ["set-1"], metaReferralSourceIds: ["ad-1"],
    });
    assert.deepEqual(result.metaReferralCampaignIds, ["campaign-1"]);
    assert.deepEqual(result.metaReferralAdSetIds, ["set-1"]);
    assert.deepEqual(result.metaReferralSourceIds, ["ad-1"]);
    assert.equal(result.metaCampaignLabels, undefined);
    assert.equal(result.metaCampaignNameFallbacks, undefined);
  });
});

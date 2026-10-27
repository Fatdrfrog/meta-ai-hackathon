/** @jest-environment node */
import assert from "node:assert/strict";
import { normalizeClientMessageTriggerConfig } from "@icecore/scenario-contracts";
import {
  resolveCampaignProductDecisions,
  type CampaignProductCandidate,
  type CampaignProductFacts,
  type CampaignProductRoute,
} from "./campaign-product-routing";

const facts: CampaignProductFacts = {
  adAccountId: "act_42",
  campaignId: "campaign-1",
  campaignName: "Alpha Beta launch",
  labelIds: [],
  labelStatus: "absent",
};
function candidate(
  key: string,
  route: Partial<CampaignProductRoute> = {},
  overrides: Partial<CampaignProductFacts> = {}
): CampaignProductCandidate {
  return {
    key,
    route: { adAccountId: "act_42", labels: [], nameFallbacks: ["Alpha"], ...route },
    facts: { ...facts, ...overrides },
  };
}

// Cross-account candidates must be excluded before ambiguity/precedence analysis,
// not just rejected afterward: otherwise they can also suppress the correct route.
describe("campaign product account isolation", () => {
  it("does not let a scoped name fallback match another account", () => {
    const result = resolveCampaignProductDecisions([
      candidate("wrong", { adAccountId: "act_99" }),
    ]);
    assert.equal(result.get("wrong")?.allow, false);
    assert.equal(result.get("wrong")?.outcome, "product_no_match");
  });

  it("does not let another account create a false name ambiguity", () => {
    const result = resolveCampaignProductDecisions([
      candidate("right"),
      candidate("wrong", { adAccountId: "act_99", nameFallbacks: ["Beta"] }),
    ]);
    assert.equal(result.get("right")?.outcome, "matched_name_fallback");
    assert.equal(result.get("wrong")?.outcome, "product_no_match");
  });

  it("does not leak a label route into its name fallback on another account", () => {
    const result = resolveCampaignProductDecisions([
      candidate("wrong", {
        adAccountId: "act_99",
        labels: [{ id: "product-a", name: "Alpha" }],
      }),
    ]);
    assert.equal(result.get("wrong")?.allow, false);
  });

  it("keeps a matching account eligible and accepts the bare numeric form", () => {
    const result = resolveCampaignProductDecisions([
      candidate("right", { adAccountId: " 42 " }),
    ]);
    assert.equal(result.get("right")?.outcome, "matched_name_fallback");
  });

  it("keeps deliberately unscoped name-only routes working", () => {
    const result = resolveCampaignProductDecisions([
      candidate("unscoped", { adAccountId: "" }),
    ]);
    assert.equal(result.get("unscoped")?.outcome, "matched_name_fallback");
  });

  for (const account of ["invalid", "act_", "act_abc"]) {
    it(`fails closed for an explicitly invalid account ${account}`, () => {
      assert.equal(
        resolveCampaignProductDecisions([
          candidate("invalid", { adAccountId: account }),
        ]).get("invalid")?.allow,
        false
      );
    });
  }

  it("requires account evidence for an account-scoped fallback", () => {
    assert.equal(
      resolveCampaignProductDecisions([
        candidate("unknown-account", {}, { adAccountId: "" }),
      ]).get("unknown-account")?.allow,
      false
    );
  });

  it("keeps incomplete label routing closed after shared normalization", () => {
    const config = normalizeClientMessageTriggerConfig({
      metaCampaignLabels: [{ id: "product-a", name: "Alpha" }],
      metaCampaignNameFallbacks: ["Alpha"],
    });
    const result = resolveCampaignProductDecisions([
      candidate("incomplete", {
        adAccountId: config.metaCampaignAdAccountId ?? "",
        labels: (config.metaCampaignLabels ?? []).map(label => ({
          id: label.id, name: label.name ?? label.id,
        })),
        nameFallbacks: config.metaCampaignNameFallbacks ?? [],
      }),
    ]);
    assert.equal(result.get("incomplete")?.allow, false);
  });

  it("preserves label precedence and shared-label eligibility after indexing", () => {
    const confirmed: Partial<CampaignProductFacts> = {
      labelStatus: "present", labelIds: ["product-b"],
    };
    const result = resolveCampaignProductDecisions([
      candidate("fallback", {}, confirmed),
      candidate("label-1", { labels: [{ id: "product-b", name: "Beta" }] }, confirmed),
      candidate("label-2", { labels: [{ id: "product-b", name: "Beta" }] }, confirmed),
    ]);
    assert.equal(result.get("fallback")?.outcome, "suppressed_label_precedence");
    assert.equal(result.get("label-1")?.allow, true);
    assert.equal(result.get("label-2")?.allow, true);
    assert.deepEqual(result.get("label-1")?.labelNames, ["Beta"]);
  });

  it("preserves shared name matches and suppression of unrelated candidates", () => {
    const result = resolveCampaignProductDecisions([
      candidate("first"), candidate("second", { nameFallbacks: ["ALPHA"] }),
      candidate("other", { nameFallbacks: ["Gamma"] }),
    ]);
    assert.equal(result.get("first")?.allow, true);
    assert.equal(result.get("second")?.allow, true);
    assert.equal(result.get("other")?.outcome, "product_no_match");
  });
  it("preserves distinct label and name conflict suppression", () => {
    const labels = resolveCampaignProductDecisions([
      candidate("a", { labels: [{ id: "a", name: "Alpha" }] }, { labelStatus: "present", labelIds: ["a", "b"] }),
      candidate("b", { labels: [{ id: "b", name: "Beta" }] }, { labelStatus: "present", labelIds: ["a", "b"] }),
    ]);
    assert.equal(labels.get("a")?.outcome, "suppressed_label_conflict");
    assert.equal(labels.get("b")?.allow, false);
    const names = resolveCampaignProductDecisions([
      candidate("a"), candidate("b", { nameFallbacks: ["Beta"] }),
    ]);
    assert.equal(names.get("a")?.outcome, "suppressed_name_ambiguous");
    assert.equal(names.get("b")?.allow, false);
  });

});

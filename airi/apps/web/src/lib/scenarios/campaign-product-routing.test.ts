import {
  resolveCampaignProductDecisions,
  type CampaignProductCandidate,
  type CampaignProductFacts,
  type CampaignProductRoute,
} from "./campaign-product-routing";

function facts(
  overrides: Partial<CampaignProductFacts> = {}
): CampaignProductFacts {
  return {
    adAccountId: "act_42",
    campaignId: "campaign-1",
    campaignName: "Product A copied name",
    labelIds: [],
    labelStatus: "absent",
    ...overrides,
  };
}

function route(
  overrides: Partial<CampaignProductRoute> = {}
): CampaignProductRoute {
  return {
    adAccountId: "act_42",
    labels: [],
    nameFallbacks: [],
    ...overrides,
  };
}

function candidate(
  key: string,
  candidateRoute: CampaignProductRoute,
  candidateFacts: CampaignProductFacts = facts()
): CampaignProductCandidate {
  return { key, route: candidateRoute, facts: candidateFacts };
}

describe("campaign product routing", () => {
  it("lets a recognized product label beat another product's copied campaign name", () => {
    const decisions = resolveCampaignProductDecisions([
      candidate(
        "product-a",
        route({ nameFallbacks: ["Product A"] }),
        facts({
          labelStatus: "present",
          labelIds: ["label-b"],
        })
      ),
      candidate(
        "product-b",
        route({ labels: [{ id: "label-b", name: "Product B" }] }),
        facts({
          labelStatus: "present",
          labelIds: ["label-b"],
        })
      ),
    ]);

    expect(decisions.get("product-b")).toMatchObject({
      allow: true,
      outcome: "matched_label",
      labelNames: ["Product B"],
    });
    expect(decisions.get("product-a")).toMatchObject({
      allow: false,
      outcome: "suppressed_label_precedence",
    });
  });

  it("does not let an unrelated label suppress name fallback", () => {
    const decisions = resolveCampaignProductDecisions([
      candidate(
        "product-a",
        route({ nameFallbacks: ["Product A"] }),
        facts({ labelStatus: "present", labelIds: ["billing"] })
      ),
    ]);

    expect(decisions.get("product-a")).toMatchObject({
      allow: true,
      outcome: "matched_name_fallback",
    });
  });

  it("allows name fallback only when labels are confirmed absent", () => {
    const absent = resolveCampaignProductDecisions([
      candidate("product-a", route({ nameFallbacks: ["Product A"] })),
    ]);
    const unavailable = resolveCampaignProductDecisions([
      candidate(
        "product-a",
        route({ nameFallbacks: ["Product A"] }),
        facts({ labelStatus: "unavailable" })
      ),
    ]);
    const missing = resolveCampaignProductDecisions([
      candidate(
        "product-a",
        route({ nameFallbacks: ["Product A"] }),
        facts({ labelStatus: "none" })
      ),
    ]);

    expect(absent.get("product-a")?.outcome).toBe("matched_name_fallback");
    expect(unavailable.get("product-a")).toMatchObject({
      allow: false,
      outcome: "suppressed_labels_unavailable",
    });
    expect(missing.get("product-a")?.outcome).toBe("product_no_match");
  });

  it("matches campaign names case-insensitively and ignores other text", () => {
    const decisions = resolveCampaignProductDecisions([
      candidate(
        "product-a",
        route({ nameFallbacks: ["  product   a ", "SPRING"] }),
        facts({
          campaignName: "Spring Product A launch",
          labelStatus: "absent",
        })
      ),
    ]);

    expect(decisions.get("product-a")).toMatchObject({
      allow: true,
      outcome: "matched_name_fallback",
      nameFallbacks: ["product   a", "SPRING"],
    });
  });

  it("does not start competing products when labels or names disagree", () => {
    const labels = resolveCampaignProductDecisions([
      candidate(
        "product-a",
        route({ labels: [{ id: "label-a", name: "A" }] }),
        facts({ labelStatus: "present", labelIds: ["label-a", "label-b"] })
      ),
      candidate(
        "product-b",
        route({ labels: [{ id: "label-b", name: "B" }] }),
        facts({ labelStatus: "present", labelIds: ["label-a", "label-b"] })
      ),
    ]);
    const names = resolveCampaignProductDecisions([
      candidate(
        "product-a",
        route({ nameFallbacks: ["alpha"] }),
        facts({
          campaignName: "alpha beta",
        })
      ),
      candidate(
        "product-b",
        route({ nameFallbacks: ["beta"] }),
        facts({
          campaignName: "alpha beta",
        })
      ),
    ]);

    expect(labels.get("product-a")?.outcome).toBe("suppressed_label_conflict");
    expect(labels.get("product-b")?.allow).toBe(false);
    expect(names.get("product-a")?.outcome).toBe("suppressed_name_ambiguous");
    expect(names.get("product-b")?.allow).toBe(false);
  });

  it("keeps overlapping name matches eligible for one later winner", () => {
    const decisions = resolveCampaignProductDecisions([
      candidate(
        "product-a",
        route({ nameFallbacks: ["spring"] }),
        facts({ campaignName: "Spring sale" })
      ),
      candidate(
        "product-b",
        route({ nameFallbacks: ["Spring"] }),
        facts({ campaignName: "Spring sale" })
      ),
    ]);

    expect(decisions.get("product-a")?.allow).toBe(true);
    expect(decisions.get("product-b")?.allow).toBe(true);
  });

  it("does not match a label from a different ad account", () => {
    const decisions = resolveCampaignProductDecisions([
      candidate(
        "other-account",
        route({
          adAccountId: "act_99",
          labels: [{ id: "label-b", name: "Product B" }],
        }),
        facts({ labelStatus: "present", labelIds: ["label-b"] })
      ),
    ]);

    expect(decisions.get("other-account")?.outcome).toBe("product_no_match");
  });
});

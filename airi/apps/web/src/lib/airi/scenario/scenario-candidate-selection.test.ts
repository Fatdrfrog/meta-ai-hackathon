import type {
  ScenarioEntryPolicy,
  ScenarioMatchingRole,
  ScenarioTriggerConfig,
} from "@icecore/scenario-contracts";
import type { ScenarioRecord } from "@icecore/airi-runtime/scenario-graph";
import { projectScenarioIngressContext } from "@/lib/scenarios/incoming-message-trigger-matcher";
import {
  compileScenarioCandidate,
  orderTopLevelScenarioCandidates,
  selectMatchingTrigger,
  selectTopLevelScenarioCandidates,
} from "./scenario-candidate-selection";

function createTriggerNode(params: {
  id: string;
  config?: ScenarioTriggerConfig;
  linkedConditionId?: string;
  legacyTriggerType?: string;
}) {
  return {
    id: params.id,
    data: {
      kind: "trigger" as const,
      ...(params.linkedConditionId
        ? { linkedConditionId: params.linkedConditionId }
        : {}),
      ...(params.legacyTriggerType
        ? { triggerType: params.legacyTriggerType as never }
        : {}),
      triggerConfig: params.config ?? {
        enabled: true,
        messageMatchMode: "any" as const,
      },
    },
  };
}

function createActionNode(id: string) {
  return {
    id,
    data: {
      kind: "action" as const,
      actionType: "reply" as const,
      actionReplyMode: "fixed" as const,
      actionReplyText: id,
    },
  };
}

function createScenario(params: {
  id: string;
  name?: string;
  priority?: unknown;
  matchingRole?: ScenarioMatchingRole;
  entryPolicy?: ScenarioEntryPolicy;
  nodes: unknown[];
  edges?: unknown[];
}): ScenarioRecord {
  return {
    _id: params.id,
    name: params.name ?? params.id,
    priority: params.priority ?? 0,
    matchingRole: params.matchingRole ?? "default",
    entryPolicy: params.entryPolicy ?? "once_per_conversation",
    updatedAt: `2026-07-31T00:00:${params.id.length
      .toString()
      .padStart(2, "0")}.000Z`,
    nodes: params.nodes,
    edges: params.edges ?? [],
  };
}

describe("compileScenarioCandidate", () => {
  it("orders Exact, Contains, and Any roots by specificity", () => {
    const scenario = createScenario({
      id: "root-order",
      nodes: [
        createTriggerNode({
          id: "any",
          config: {
            enabled: true,
            messageMatchMode: "any",
          },
        }),
        createTriggerNode({
          id: "contains",
          config: {
            enabled: true,
            messageMatchMode: "contains",
            keywordPattern: "refund",
          },
        }),
        createTriggerNode({
          id: "exact",
          config: {
            enabled: true,
            messageMatchMode: "exact",
            keywordPattern: "refund",
          },
        }),
      ],
    });

    const candidate = compileScenarioCandidate(scenario);

    expect(
      candidate.triggerCandidates.map(trigger => [
        trigger.node.id,
        trigger.criteria.text.mode,
        trigger.specificity,
      ])
    ).toEqual([
      ["exact", "exact", 425],
      ["contains", "contains", 325],
      ["any", "any", 100],
    ]);
    expect(candidate.topLevelSpecificity).toBe(425);
  });

  it("keeps WhatsApp QR triggers out of ordinary message matching but available for explicit anchoring", () => {
    const scenario = createScenario({
      id: "qr-isolated",
      nodes: [
        createTriggerNode({
          id: "qr-root",
          config: {
            enabled: true,
            entryPointType: "whatsapp_qr",
            messageMatchMode: "any",
          },
        }),
        createTriggerNode({
          id: "message-root",
          config: {
            enabled: true,
            entryPointType: "message",
            messageMatchMode: "any",
          },
        }),
      ],
    });

    const candidate = compileScenarioCandidate(scenario);
    expect(
      candidate.compiledTriggerCandidates.map(item => item.node.id)
    ).toEqual(["qr-root", "message-root"]);
    expect(candidate.triggerCandidates.map(item => item.node.id)).toEqual([
      "message-root",
    ]);
    expect(
      selectMatchingTrigger(
        candidate,
        projectScenarioIngressContext({
          eventKind: "inbound_message",
          channel: "whatsapp",
          messageText: "hello",
        }),
        "qr-root"
      )?.node.id
    ).toBe("qr-root");
  });

  it("preserves graph order when root specificity ties", () => {
    const scenario = createScenario({
      id: "graph-tie",
      nodes: [
        createTriggerNode({
          id: "contains-second-name",
          config: {
            enabled: true,
            messageMatchMode: "contains",
            keywordPattern: "refund",
          },
        }),
        createTriggerNode({
          id: "contains-first-name",
          config: {
            enabled: true,
            messageMatchMode: "contains",
            keywordPattern: "cancel",
          },
        }),
      ],
    });

    expect(
      compileScenarioCandidate(scenario).triggerCandidates.map(
        trigger => trigger.node.id
      )
    ).toEqual(["contains-second-name", "contains-first-name"]);
  });

  it("keeps a linked-condition child out of top-level selection without dropping its graph", () => {
    const scenario = createScenario({
      id: "linked-child",
      entryPolicy: "repeatable",
      nodes: [
        createTriggerNode({
          id: "linked-root",
          linkedConditionId: "condition-1",
        }),
        createActionNode("forced-action"),
      ],
      edges: [{ source: "linked-root", target: "forced-action" }],
    });

    const candidate = compileScenarioCandidate(scenario);

    expect(candidate.topLevelEligible).toBe(false);
    expect(candidate.entryPolicy).toBe("repeatable");
    expect(candidate.graph.nodesById.get("forced-action")).toBeDefined();
    expect(candidate.triggerCandidates.map(trigger => trigger.node.id)).toEqual(
      ["linked-root"]
    );
  });

  it("excludes disabled migrated legacy roots while preserving them in the compiled graph", () => {
    const scenario = createScenario({
      id: "disabled-legacy",
      nodes: [
        createTriggerNode({
          id: "retired-payment-root",
          legacyTriggerType: "payment_detected",
          config: {
            enabled: true,
            messageMatchMode: "any",
          },
        }),
        createTriggerNode({
          id: "canonical-root",
          config: {
            enabled: true,
            messageMatchMode: "exact",
            keywordPattern: "paid",
          },
        }),
      ],
    });

    const candidate = compileScenarioCandidate(scenario);

    expect(candidate.graph.nodesById.has("retired-payment-root")).toBe(true);
    expect(candidate.triggerCandidates.map(trigger => trigger.node.id)).toEqual(
      ["canonical-root"]
    );
    expect(candidate.topLevelSpecificity).toBe(425);
  });

  it("normalizes scenario identity, name, priority, role, and entry policy facts once", () => {
    const scenario = createScenario({
      id: "  normalized-id  ",
      name: "   ",
      priority: "17",
      matchingRole: "fallback",
      entryPolicy: "repeatable",
      nodes: [
        createTriggerNode({
          id: "root",
          config: {
            enabled: true,
            messageMatchMode: "any",
            keywordPattern: "dormant",
            keywordMatchMode: "regex",
          },
        }),
      ],
    });

    expect(compileScenarioCandidate(scenario)).toMatchObject({
      scenario,
      scenarioId: "normalized-id",
      scenarioName: "Scenario",
      priority: 17,
      matchingRole: "fallback",
      entryPolicy: "repeatable",
      topLevelSpecificity: 100,
      topLevelEligible: true,
    });
  });

  it("does not mutate frozen scenario input while compiling immutable candidate facts", () => {
    const triggerConfig = Object.freeze({
      enabled: true,
      messageMatchMode: "contains" as const,
      keywordPattern: "refund, cancel",
    });
    const triggerData = Object.freeze({
      kind: "trigger" as const,
      triggerConfig,
    });
    const triggerNode = Object.freeze({
      id: "root",
      data: triggerData,
    });
    const nodes = Object.freeze([triggerNode]);
    const edges = Object.freeze([] as unknown[]);
    const scenario = Object.freeze({
      ...createScenario({
        id: "frozen-input",
        nodes: nodes as unknown as unknown[],
        edges: edges as unknown as unknown[],
      }),
      nodes,
      edges,
    }) as unknown as ScenarioRecord;
    const before = JSON.parse(JSON.stringify(scenario));

    const candidate = compileScenarioCandidate(scenario);

    expect(scenario).toEqual(before);
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate.triggerCandidates)).toBe(true);
    expect(Object.isFrozen(candidate.triggerCandidates[0])).toBe(true);
  });
});

describe("orderTopLevelScenarioCandidates", () => {
  it("orders ordinary scenarios before fallback scenarios regardless of specificity", () => {
    const ordinary = compileScenarioCandidate(
      createScenario({
        id: "ordinary",
        priority: 0,
        nodes: [createTriggerNode({ id: "ordinary-any" })],
      })
    );
    const fallback = compileScenarioCandidate(
      createScenario({
        id: "fallback",
        priority: 999,
        matchingRole: "fallback",
        nodes: [
          createTriggerNode({
            id: "fallback-any",
            config: {
              enabled: true,
              messageMatchMode: "any",
            },
          }),
        ],
      })
    );

    expect(
      orderTopLevelScenarioCandidates([fallback, ordinary]).map(
        candidate => candidate.scenarioId
      )
    ).toEqual(["ordinary", "fallback"]);
  });

  it("orders within a role by specificity, then priority, then stable scenario ID", () => {
    const any = compileScenarioCandidate(
      createScenario({
        id: "any-high-priority",
        priority: 999,
        nodes: [createTriggerNode({ id: "any" })],
      })
    );
    const exactLowPriority = compileScenarioCandidate(
      createScenario({
        id: "z-exact",
        priority: 1,
        nodes: [
          createTriggerNode({
            id: "exact-low",
            config: {
              enabled: true,
              messageMatchMode: "exact",
              keywordPattern: "refund",
            },
          }),
        ],
      })
    );
    const exactHighPriorityB = compileScenarioCandidate(
      createScenario({
        id: "b-exact",
        priority: 20,
        nodes: [
          createTriggerNode({
            id: "exact-high-b",
            config: {
              enabled: true,
              messageMatchMode: "exact",
              keywordPattern: "cancel",
            },
          }),
        ],
      })
    );
    const exactHighPriorityA = compileScenarioCandidate(
      createScenario({
        id: "a-exact",
        priority: 20,
        nodes: [
          createTriggerNode({
            id: "exact-high-a",
            config: {
              enabled: true,
              messageMatchMode: "exact",
              keywordPattern: "exchange",
            },
          }),
        ],
      })
    );
    const input = [
      any,
      exactLowPriority,
      exactHighPriorityB,
      exactHighPriorityA,
    ];

    expect(
      orderTopLevelScenarioCandidates(input).map(
        candidate => candidate.scenarioId
      )
    ).toEqual(["a-exact", "b-exact", "z-exact", "any-high-priority"]);
    expect(input.map(candidate => candidate.scenarioId)).toEqual([
      "any-high-priority",
      "z-exact",
      "b-exact",
      "a-exact",
    ]);
  });
});

describe("event-time scenario candidate selection", () => {
  it("ranks scenarios by the root that actually matched the shared ingress", () => {
    const broadWithNonmatchingExact = compileScenarioCandidate(
      createScenario({
        id: "broad-with-nonmatching-exact",
        priority: 20,
        nodes: [
          createTriggerNode({
            id: "broad-any",
            config: {
              enabled: true,
              messageMatchMode: "any",
            },
          }),
          createTriggerNode({
            id: "nonmatching-exact",
            config: {
              enabled: true,
              messageMatchMode: "exact",
              keywordPattern: "other",
            },
          }),
        ],
      })
    );
    const matchingContains = compileScenarioCandidate(
      createScenario({
        id: "matching-contains",
        priority: 20,
        nodes: [
          createTriggerNode({
            id: "contains-refund",
            config: {
              enabled: true,
              messageMatchMode: "contains",
              keywordPattern: "refund",
              keywordMatchMode: "contains",
            },
          }),
        ],
      })
    );
    const ingress = projectScenarioIngressContext({
      eventKind: "inbound_message",
      channel: "whatsapp",
      messageText: "Please refund this order",
    });

    expect(
      selectTopLevelScenarioCandidates(
        [broadWithNonmatchingExact, matchingContains],
        ingress
      ).map(selection => [
        selection.candidate.scenarioId,
        selection.selectedTrigger?.node.id,
        selection.selectedTrigger?.specificity ?? 0,
      ])
    ).toEqual([
      ["matching-contains", "contains-refund", 325],
      ["broad-with-nonmatching-exact", "broad-any", 100],
    ]);
  });

  it("falls a stale explicit trigger ID back to the primary root", () => {
    const candidate = compileScenarioCandidate(
      createScenario({
        id: "stale-explicit-root",
        nodes: [
          createTriggerNode({
            id: "primary-any",
            config: {
              enabled: true,
              messageMatchMode: "any",
            },
          }),
          createTriggerNode({
            id: "matching-exact",
            config: {
              enabled: true,
              messageMatchMode: "exact",
              keywordPattern: "refund",
            },
          }),
        ],
      })
    );
    const ingress = projectScenarioIngressContext({
      eventKind: "inbound_message",
      channel: "whatsapp",
      messageText: "refund",
    });

    expect(selectMatchingTrigger(candidate, ingress)?.node.id).toBe(
      "matching-exact"
    );
    expect(
      selectMatchingTrigger(candidate, ingress, "deleted-trigger")?.node.id
    ).toBe("primary-any");
  });

  it("keeps linked-condition children out of top-level event selection", () => {
    const linkedChild = compileScenarioCandidate(
      createScenario({
        id: "linked-child-selection",
        nodes: [
          createTriggerNode({
            id: "linked-root",
            linkedConditionId: "condition-1",
          }),
          createActionNode("linked-action"),
        ],
        edges: [{ source: "linked-root", target: "linked-action" }],
      })
    );
    const ingress = projectScenarioIngressContext({
      eventKind: "inbound_message",
      channel: "whatsapp",
      messageText: "hello",
    });

    expect(selectMatchingTrigger(linkedChild, ingress)?.node.id).toBe(
      "linked-root"
    );
    expect(selectTopLevelScenarioCandidates([linkedChild], ingress)).toEqual(
      []
    );
  });
});

function productScenario(params: {
  id: string;
  priority?: number;
  config: ScenarioTriggerConfig;
}) {
  return compileScenarioCandidate(
    createScenario({
      id: params.id,
      priority: params.priority ?? 0,
      nodes: [
        createTriggerNode({
          id: `${params.id}-trigger`,
          config: {
            enabled: true,
            messageMatchMode: "any",
            ...params.config,
          },
        }),
        createActionNode(`${params.id}-action`),
      ],
      edges: [
        { source: `${params.id}-trigger`, target: `${params.id}-action` },
      ],
    })
  );
}

function referralIngress(referral: Record<string, unknown>) {
  return projectScenarioIngressContext({
    eventKind: "inbound_message",
    channel: "whatsapp",
    messageText: "hello from Product A headline",
    whatsappReferral: {
      sourceType: "ad",
      sourceId: "ad-1",
      campaignId: "campaign-1",
      campaignName: "Product A copied name",
      headline: "Product A headline",
      adAccountId: "act_42",
      campaignLabelStatus: "present",
      campaignLabels: [{ id: "label-b" }],
      ...referral,
    },
  });
}

describe("campaign label precedence across scenarios", () => {
  it("selects the labeled product and blocks the other product's name fallback", () => {
    const selections = selectTopLevelScenarioCandidates(
      [
        productScenario({
          id: "product-a",
          priority: 10,
          config: {
            metaCampaignAdAccountId: "act_42",
            metaCampaignNameFallbacks: ["Product A"],
          },
        }),
        productScenario({
          id: "product-b",
          config: {
            metaCampaignAdAccountId: "act_42",
            metaCampaignLabels: [{ id: "label-b", name: "Product B" }],
          },
        }),
      ],
      referralIngress({})
    );

    expect(selections.map(item => item.candidate.scenarioId)).toEqual([
      "product-b",
      "product-a",
    ]);
    expect(selections[0]?.selectedTrigger?.node.id).toBe("product-b-trigger");
    expect(selections[0]?.productRoute?.outcome).toBe("matched_label");
    expect(selections[1]?.selectedTrigger).toBeNull();
    expect(selections[1]?.productRoute?.outcome).toBe(
      "suppressed_label_precedence"
    );
  });

  it("keeps a saved exact campaign filter independent of product routing", () => {
    const exact = productScenario({
      id: "exact-campaign",
      config: { metaReferralCampaignIds: ["campaign-1"] },
    });
    const selections = selectTopLevelScenarioCandidates(
      [exact],
      referralIngress({
        campaignLabels: [],
        campaignLabelStatus: "absent",
      })
    );

    expect(selections[0]?.selectedTrigger?.node.id).toBe(
      "exact-campaign-trigger"
    );
    expect(selections[0]?.productRoute).toBeNull();
  });

  it("does not start either product when labels conflict", () => {
    const selections = selectTopLevelScenarioCandidates(
      [
        productScenario({
          id: "conflict-a",
          config: {
            metaCampaignAdAccountId: "act_42",
            metaCampaignLabels: [{ id: "label-a", name: "A" }],
          },
        }),
        productScenario({
          id: "conflict-b",
          config: {
            metaCampaignAdAccountId: "act_42",
            metaCampaignLabels: [{ id: "label-b", name: "B" }],
          },
        }),
      ],
      referralIngress({
        campaignLabels: [{ id: "label-a" }, { id: "label-b" }],
      })
    );

    expect(selections.every(item => item.selectedTrigger === null)).toBe(true);
    expect(selections.map(item => item.productRoute?.outcome)).toEqual([
      "suppressed_label_conflict",
      "suppressed_label_conflict",
    ]);
  });
});

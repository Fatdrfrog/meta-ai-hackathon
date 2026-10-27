jest.mock("@/lib/classifier/conversation-analysis-context", () => ({
  getBusinessContext: jest.fn(),
}));

jest.mock("@/lib/classifier/conversation-analysis-helpers", () => ({
  prepareTextForAnalysis: jest.fn(),
}));

jest.mock("@/lib/classifier/taxonomy-server", () => ({
  getWorkspaceTaxonomy: jest.fn(),
}));

jest.mock("@/lib/mongoose", () => jest.fn());

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {},
}));

jest.mock("@/models/chat", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {},
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {},
}));

jest.mock("@/models/user", () => ({
  __esModule: true,
  default: {},
}));

import {
  FOLLOW_UP_AUDIENCE_CONVERSATION_SELECT,
  FOLLOW_UP_AUDIENCE_WORKSPACE_STATE_CACHE_VERSION,
  buildFollowUpConversationPrefilterMatch,
  buildOutboundMessageCorpus,
  buildOutboundMessageSignature,
  buildScenarioFamilies,
  chooseBucketMappings,
  clampFollowUpAudienceFilterInput,
  filterFollowUpAudienceRows,
  resolveFollowUpStoredClassification,
  resolveConversationPurchaseEvidence,
  resolveConversationStatus,
  summarizeFollowUpAudienceRows,
} from "@/lib/analytics/follow-up-audience";
import {
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS,
  buildCurrentConversationClassificationFilter,
} from "@icecore/shared/lib/conversation-classification-freshness";
import type { ScenarioNodeData } from "@icecore/scenario-contracts";

function makeScenario(
  overrides: Partial<Parameters<typeof buildScenarioFamilies>[0][number]> & {
    _id: string;
    name: string;
    linkedScenarioId?: string;
    inactivityDays?: number;
    classificationCategory?: string;
    actionReplyText?: string;
  }
): Parameters<typeof buildScenarioFamilies>[0][number] {
  const inactivityDays = overrides.inactivityDays ?? 1;

  return {
    _id: overrides._id,
    name: overrides.name,
    description: overrides.description || null,
    priority: overrides.priority ?? null,
    segmentKey: overrides.segmentKey || null,
    nodes: [
      {
        id: `${overrides._id}-trigger`,
        data: {
          kind: "trigger",
          triggerConfig: {
            messageMatchMode: "any",
          },
        },
      },
      {
        id: `${overrides._id}-audience`,
        data: {
          kind: "logic",
          logicType: "audience_filter",
          audienceMode: "last_seen_greater_than_x_days",
          audienceLastSeenDays: inactivityDays,
        },
      },
      ...(overrides.classificationCategory
        ? [
            {
              id: `${overrides._id}-classification-audience`,
              data: {
                kind: "logic",
                logicType: "audience_filter",
                audienceMode: "classification",
                classificationCategory: overrides.classificationCategory,
              },
            },
          ]
        : []),
      ...(overrides.actionReplyText
        ? [
            {
              id: `${overrides._id}-action`,
              data: {
                kind: "action",
                actionType: "reply",
                actionReplyText: overrides.actionReplyText,
              },
            },
          ]
        : []),
      ...(overrides.linkedScenarioId
        ? [
            {
              id: `${overrides._id}-link`,
              data: {
                kind: "scenario_link",
                linkedScenarioId: overrides.linkedScenarioId,
                linkedScenarioName: overrides.linkedScenarioId,
              },
            },
          ]
        : []),
    ],
    edges: [],
  };
}

function makeRow(
  overrides: Partial<
    Parameters<typeof resolveConversationStatus>[0]["row"]
  > = {}
): Parameters<typeof resolveConversationStatus>[0]["row"] {
  return {
    conversationId: overrides.conversationId || "conv-1",
    channel: overrides.channel || "whatsapp",
    chatLabel: overrides.chatLabel || "Customer 1",
    lastMessageAt: overrides.lastMessageAt || "2026-04-01T10:00:00.000Z",
    effectiveCategory: overrides.effectiveCategory || "Sales",
    categorySource: overrides.categorySource || "stored",
    categoryConfidence: overrides.categoryConfidence ?? 0.9,
    categoryEvidence: overrides.categoryEvidence || null,
    purchaseAt: overrides.purchaseAt || null,
    purchaseEvidenceType: overrides.purchaseEvidenceType || null,
    warnings: overrides.warnings || [],
    startedScenarioIds: overrides.startedScenarioIds || [],
    currentFollowUpScenarioName: overrides.currentFollowUpScenarioName || null,
    createdAt: overrides.createdAt || "2026-04-01T09:00:00.000Z",
    updatedAt: overrides.updatedAt || "2026-04-01T10:00:00.000Z",
    internalLabels: overrides.internalLabels ?? [],
  };
}

describe("follow-up audience helpers", () => {
  it("uses canonical service-message semantics for payment evidence signatures", () => {
    const message = {
      _id: "message-1",
      text: "[outbound]",
      whatsappServiceMessage: {
        version: 1 as const,
        kind: "reply_buttons",
        command: {
          kind: "reply_buttons",
          body: "Your payment was received",
          options: [{ id: "receipt", label: "View receipt" }],
        },
      },
      whatsappTemplate: {
        name: "stale_payment_template",
        bodyText: "Stale payment copy",
      },
    };

    expect(buildOutboundMessageCorpus(message)).toContain(
      "Your payment was received"
    );
    expect(buildOutboundMessageCorpus(message)).toContain("View receipt");
    expect(buildOutboundMessageCorpus(message)).not.toContain(
      "Stale payment copy"
    );
    expect(buildOutboundMessageSignature(message)).toBe(
      "service:reply buttons:your payment was received view receipt"
    );
  });

  it("discovers a family root and linked descendants from scenario links", () => {
    const scenarios = [
      makeScenario({
        _id: "root-1",
        name: "Sales follow-up",
        linkedScenarioId: "child-1",
        actionReplyText: "Checking back on your pricing questions.",
      }),
      makeScenario({
        _id: "child-1",
        name: "Sales branch",
        actionReplyText: "Want me to hold the offer for you?",
      }),
    ];

    const families = buildScenarioFamilies(scenarios, ["Sales", "Other"]);

    expect(families).toHaveLength(1);
    expect(families[0]).toMatchObject({
      rootScenarioId: "root-1",
      familyScenarioIds: expect.arrayContaining(["root-1", "child-1"]),
      timeoutMinutes: null,
      inactivityDays: 1,
      isCandidate: true,
    });
    expect(families[0]?.corpus).toContain(
      "Checking back on your pricing questions."
    );
    expect(families[0]?.corpus).toContain("Want me to hold the offer for you?");
  });

  it("ignores retired audience fields stored on the trigger node", () => {
    const scenario = makeScenario({
      _id: "root-legacy-trigger-audience",
      name: "Legacy trigger audience",
      actionReplyText: "Checking back with you.",
    });
    const nodes = scenario.nodes as Array<{
      id: string;
      data: ScenarioNodeData;
    }>;
    scenario.nodes = nodes
      .filter(node => node.data.kind !== "logic")
      .map(node =>
        node.data.kind === "trigger"
          ? {
              ...node,
              data: {
                ...node.data,
                audienceMode: "last_seen_greater_than_x_days" as const,
                audienceLastSeenDays: 14,
                classificationCategory: "Sales",
              },
            }
          : node
      );

    const [family] = buildScenarioFamilies([scenario], ["Sales"]);

    expect(family).toMatchObject({
      inactivityDays: null,
      explicitLabels: [],
      isCandidate: false,
      exclusionReason: "Root is not inactivity-oriented.",
    });
  });

  it("includes canonical service-message authoring copy in the family corpus", () => {
    const scenario = makeScenario({
      _id: "root-canonical",
      name: "Course follow-up",
    });
    const nodes = scenario.nodes as Array<{
      id: string;
      data: ScenarioNodeData;
    }>;
    nodes.push({
      id: "root-canonical-action",
      data: {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "whatsapp",
        classificationCategory: "Shared course leads",
        actionInstruction: "Shared analytics instruction",
        actionReplyText: "Stale legacy reply",
        actionReplyInstruction: "Stale legacy AI instruction",
        actionSnippetQuestion: "Stale legacy snippet question",
        actionSnippetAnswer: "Stale legacy snippet answer",
        actionReplyCtaLabel: "Stale legacy CTA",
        actionFlowConfig: {
          templateId: "stale-flow",
          screens: [],
          ctaText: "Stale flow CTA",
          headerText: "Stale flow header",
          bodyText: "Stale flow body",
        },
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "media_carousel",
            body: {
              mode: "ai",
              instruction: "Recommend a suitable course",
            },
            cards: [
              {
                id: "starter",
                media: {
                  url: "https://cdn.test/starter.jpg",
                  mediaType: "image",
                },
                bodyText: "Starter course",
                interaction: {
                  kind: "quick_replies",
                  options: [{ id: "details", label: "See details" }],
                },
              },
              {
                id: "advanced",
                media: {
                  url: "https://cdn.test/advanced.jpg",
                  mediaType: "image",
                },
                bodyText: "Advanced course",
                interaction: {
                  kind: "quick_replies",
                  options: [{ id: "details-2", label: "See details" }],
                },
              },
            ],
          },
        },
      },
    });

    const [family] = buildScenarioFamilies([scenario], ["Sales"]);

    expect(family?.corpus).toContain("Recommend a suitable course");
    expect(family?.corpus).toContain("Starter course");
    expect(family?.corpus).toContain("Advanced course");
    expect(family?.corpus).toContain("See details");
    expect(family?.corpus).toContain("Shared course leads");
    expect(family?.corpus).toContain("Shared analytics instruction");
    expect(family?.corpus).not.toContain("Stale legacy reply");
    expect(family?.corpus).not.toContain("Stale legacy AI instruction");
    expect(family?.corpus).not.toContain("Stale legacy snippet question");
    expect(family?.corpus).not.toContain("Stale legacy snippet answer");
    expect(family?.corpus).not.toContain("Stale legacy CTA");
    expect(family?.corpus).not.toContain("Stale flow CTA");
    expect(family?.corpus).not.toContain("Stale flow header");
    expect(family?.corpus).not.toContain("Stale flow body");
  });

  it("includes canonical Flow authoring copy in the family corpus", () => {
    const scenario = makeScenario({
      _id: "root-service-flow",
      name: "Flow follow-up",
    });
    const nodes = scenario.nodes as Array<{
      id: string;
      data: ScenarioNodeData;
    }>;
    nodes.push({
      id: "root-service-flow-action",
      data: {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "flow",
            body: { mode: "fixed", text: "Tell us what you need" },
            flowConfig: {
              templateId: "lead-flow",
              metaFlowId: "lead-flow",
              metaFlowName: "Lead qualification",
              ctaText: "Start",
              screens: [],
            },
          },
        },
      },
    });

    const [family] = buildScenarioFamilies([scenario], ["Sales"]);

    expect(family?.corpus).toContain("Tell us what you need");
    expect(family?.corpus).toContain("Lead qualification");
    expect(family?.corpus).toContain("Start");
  });

  it("prefers explicit scenario category configuration over inferred text overlap", () => {
    const mappings = chooseBucketMappings({
      taxonomyLabels: ["VIP Leads"],
      families: [
        {
          rootScenarioId: "root-explicit",
          rootScenarioName: "Generic retention",
          rootTriggerNodeId: "trigger-explicit",
          familyScenarioIds: ["root-explicit"],
          familyScenarioNames: ["Generic retention"],
          timeoutMinutes: null,
          inactivityDays: 1,
          explicitLabels: ["VIP Leads"],
          corpus: "Retention check-in after inactivity",
          isCandidate: true,
          exclusionReason: null,
        },
        {
          rootScenarioId: "root-inferred",
          rootScenarioName: "VIP leads re-engagement",
          rootTriggerNodeId: "trigger-inferred",
          familyScenarioIds: ["root-inferred"],
          familyScenarioNames: ["VIP leads re-engagement"],
          timeoutMinutes: null,
          inactivityDays: 1,
          explicitLabels: [],
          corpus: "VIP leads follow-up offer premium upgrade",
          isCandidate: true,
          exclusionReason: null,
        },
      ],
      historyCounts: new Map(),
    });

    expect(mappings[0]).toMatchObject({
      label: "VIP Leads",
      recommendedRootScenarioId: "root-explicit",
      recommendedRootScenarioName: "Generic retention",
      mappingConfidence: 1,
      warning: null,
    });
  });

  it("returns an unmapped warning when the best mapping is not decisive", () => {
    const mappings = chooseBucketMappings({
      taxonomyLabels: ["Sales Follow Up"],
      families: [
        {
          rootScenarioId: "root-a",
          rootScenarioName: "Sales Follow Up A",
          rootTriggerNodeId: "trigger-a",
          familyScenarioIds: ["root-a"],
          familyScenarioNames: ["Sales Follow Up A"],
          timeoutMinutes: null,
          inactivityDays: 1,
          explicitLabels: [],
          corpus: "sales follow up conversation reminder",
          isCandidate: true,
          exclusionReason: null,
        },
        {
          rootScenarioId: "root-b",
          rootScenarioName: "Sales Follow Up B",
          rootTriggerNodeId: "trigger-b",
          familyScenarioIds: ["root-b"],
          familyScenarioNames: ["Sales Follow Up B"],
          timeoutMinutes: null,
          inactivityDays: 1,
          explicitLabels: [],
          corpus: "sales follow up conversation reminder",
          isCandidate: true,
          exclusionReason: null,
        },
      ],
      historyCounts: new Map(),
    });

    expect(mappings[0].recommendedRootScenarioId).toBeNull();
    expect(mappings[0].warning).toContain("Bucket remains unmapped");
  });

  it("ignores diagnostic payment logs unless there is manual or message evidence", () => {
    expect(
      resolveConversationPurchaseEvidence({
        manualConversionAt: "2026-04-02T12:00:00.000Z",
        paymentConfirmationMessageAt: "2026-04-02T11:00:00.000Z",
        diagnosticPaymentLogAt: "2026-04-02T10:00:00.000Z",
      })
    ).toEqual({
      purchaseAt: "2026-04-02T12:00:00.000Z",
      purchaseEvidenceType: "manual_conversion",
    });

    expect(
      resolveConversationPurchaseEvidence({
        diagnosticPaymentLogAt: "2026-04-02T10:00:00.000Z",
      })
    ).toEqual({
      purchaseAt: null,
      purchaseEvidenceType: null,
    });
  });

  it("uses the mapped root timeout to distinguish ready_now from waiting_timeout", () => {
    const family = {
      rootScenarioId: "root-1",
      rootScenarioName: "Sales follow-up",
      rootTriggerNodeId: "trigger-1",
      familyScenarioIds: ["root-1"],
      familyScenarioNames: ["Sales follow-up"],
      timeoutMinutes: 60,
      inactivityDays: null,
      explicitLabels: ["Sales"],
      corpus: "Sales follow-up",
      isCandidate: true,
      exclusionReason: null,
    };

    const mapping = {
      rootScenarioId: "root-1",
      rootScenarioName: "Sales follow-up",
      familyScenarioIds: ["root-1"],
      mappingConfidence: 0.95,
      mappingReason: "Matched strongly",
      warning: null,
    };

    const familyByRootId = new Map([[family.rootScenarioId, family]]);
    const now = new Date("2026-04-01T11:30:00.000Z");

    const readyNow = resolveConversationStatus({
      row: makeRow({
        lastMessageAt: "2026-04-01T10:00:00.000Z",
      }),
      mapping,
      familyByRootId,
      now,
    });

    const waiting = resolveConversationStatus({
      row: makeRow({
        conversationId: "conv-2",
        lastMessageAt: "2026-04-01T11:00:00.000Z",
      }),
      mapping,
      familyByRootId,
      now,
    });

    expect(readyNow.status).toBe("ready_now");
    expect(readyNow.readyAt).toBe("2026-04-01T11:00:00.000Z");
    expect(waiting.status).toBe("waiting_timeout");
    expect(waiting.readyAt).toBe("2026-04-01T12:00:00.000Z");
  });

  it("filters follow-up rows by channel and status for prediction audiences", () => {
    const rows = [
      {
        ...makeRow({ conversationId: "conv-wa-ready", channel: "whatsapp" }),
        internalLabels: [],
        status: "ready_now" as const,
        recommendedRootScenarioId: "root-1",
        recommendedRootScenarioName: "Sales follow-up",
        readyAt: "2026-04-01T11:00:00.000Z",
      },
      {
        ...makeRow({ conversationId: "conv-wa-waiting", channel: "whatsapp" }),
        internalLabels: [],
        status: "waiting_timeout" as const,
        recommendedRootScenarioId: "root-1",
        recommendedRootScenarioName: "Sales follow-up",
        readyAt: "2026-04-01T12:00:00.000Z",
      },
      {
        ...makeRow({ conversationId: "conv-tg-ready", channel: "telegram" }),
        internalLabels: [],
        status: "ready_now" as const,
        recommendedRootScenarioId: "root-1",
        recommendedRootScenarioName: "Sales follow-up",
        readyAt: "2026-04-01T11:00:00.000Z",
      },
    ];

    const filtered = filterFollowUpAudienceRows({
      rows,
      filters: {
        channel: "whatsapp",
        status: "ready_now",
      },
    });

    expect(filtered.map(row => row.conversationId)).toEqual(["conv-wa-ready"]);
  });

  it("filters follow-up rows by internal label", () => {
    const rows = [
      {
        ...makeRow({ conversationId: "conv-a" }),
        internalLabels: ["vip", "priority"],
        status: "ready_now" as const,
        recommendedRootScenarioId: "root-1",
        recommendedRootScenarioName: "Sales follow-up",
        readyAt: "2026-04-01T11:00:00.000Z",
      },
      {
        ...makeRow({ conversationId: "conv-b" }),
        internalLabels: ["standard"],
        status: "ready_now" as const,
        recommendedRootScenarioId: "root-1",
        recommendedRootScenarioName: "Sales follow-up",
        readyAt: "2026-04-01T11:00:00.000Z",
      },
    ];

    const filtered = filterFollowUpAudienceRows({
      rows,
      filters: { internalLabel: "vip" },
    });

    expect(filtered.map(row => row.conversationId)).toEqual(["conv-a"]);
  });

  it("summarizes channel-scoped rows without losing taxonomy buckets", () => {
    const summary = summarizeFollowUpAudienceRows({
      taxonomyLabels: ["Sales", "Other"],
      rows: [
        {
          ...makeRow({ conversationId: "conv-1", channel: "whatsapp" }),
          internalLabels: [],
          status: "ready_now" as const,
          recommendedRootScenarioId: "root-1",
          recommendedRootScenarioName: "Sales follow-up",
          readyAt: "2026-04-01T11:00:00.000Z",
        },
        {
          ...makeRow({ conversationId: "conv-2", channel: "whatsapp" }),
          internalLabels: [],
          status: "excluded_purchased" as const,
          purchaseAt: "2026-04-01T10:30:00.000Z",
          recommendedRootScenarioId: "root-1",
          recommendedRootScenarioName: "Sales follow-up",
          readyAt: null,
        },
      ],
    });

    expect(summary).toEqual({
      totalConversations: 2,
      purchasedExcluded: 1,
      readyNow: 1,
      alreadyInFollowUp: 0,
      waitingTimeout: 0,
      unmappedBucket: 0,
      byCategory: {
        Sales: 2,
        Other: 0,
      },
    });
  });

  it("uses only a current committed classification and its projected confidence", () => {
    const currentConversation = {
      classification: {
        category: "Sales",
        confidence: { category: 0.88 },
      },
      is_classified: true,
      classification_revision: 9,
      classification_state: {
        contractVersion: 2,
        status: "ready",
        requestedRevision: 9,
        appliedRevision: 9,
      },
      classification_meta: {
        source_revision: 9,
        provenance_kind: "v2",
        analysis_revision_id: "analysis-9",
      },
      effectInputs: {
        predictedCategoryConfidence: 0.11,
      },
    };

    expect(resolveFollowUpStoredClassification(currentConversation)).toEqual({
      storedCategory: "Sales",
      storedConfidence: 0.88,
    });
    expect(
      resolveFollowUpStoredClassification({
        ...currentConversation,
        classification_state: {
          ...currentConversation.classification_state,
          requestedRevision: 10,
        },
      })
    ).toEqual({ storedCategory: null, storedConfidence: null });
    expect(
      resolveFollowUpStoredClassification({
        classification: currentConversation.classification,
        is_classified: true,
      })
    ).toEqual({ storedCategory: null, storedConfidence: null });
  });

  it("selects every canonical freshness path and advances the cache contract", () => {
    const selectedPaths = new Set(
      FOLLOW_UP_AUDIENCE_CONVERSATION_SELECT.split(/\s+/u)
    );
    for (const path of CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS) {
      expect(selectedPaths).toContain(path);
    }
    expect(selectedPaths).not.toContain("followUpAudience");
    expect(FOLLOW_UP_AUDIENCE_WORKSPACE_STATE_CACHE_VERSION).toBe(4);
  });
});

describe("follow-up conversation prefilter builder", () => {
  it("clamps overly long filter inputs", () => {
    const long = "x".repeat(500);
    expect(clampFollowUpAudienceFilterInput(long, 200)?.length).toBe(200);
  });

  it("keeps an unfiltered refresh scoped to the workspace only", () => {
    expect(buildFollowUpConversationPrefilterMatch("ws-1")).toEqual({
      workspaceId: "ws-1",
    });
  });

  it("pushes cheap channel, label, and search filters into Mongo before LLM work", () => {
    const match = buildFollowUpConversationPrefilterMatch("ws-1", {
      category: "Sales Leads",
      channel: "WhatsApp",
      internalLabel: "VIP",
      q: "pricing",
      status: "ready_now",
    });
    const clauses = (match.$and as unknown[]) || [];

    const channelClause = clauses.find(
      clause =>
        typeof clause === "object" &&
        clause !== null &&
        (clause as { channel?: unknown }).channel instanceof RegExp
    ) as { channel: RegExp } | undefined;
    expect(channelClause?.channel.test("whatsapp")).toBe(true);

    const labelClause = clauses.find(
      clause =>
        typeof clause === "object" &&
        clause !== null &&
        (clause as { internal_labels?: unknown }).internal_labels instanceof
          RegExp
    ) as { internal_labels: RegExp } | undefined;
    expect(labelClause?.internal_labels.test("vip")).toBe(true);

    const searchClause = clauses.find(
      clause =>
        typeof clause === "object" &&
        clause !== null &&
        Array.isArray((clause as { $or?: unknown }).$or) &&
        (
          (clause as { $or: unknown[] }).$or as Array<Record<string, unknown>>
        ).some(entry => "rename" in entry)
    ) as { $or: Array<Record<string, unknown>> } | undefined;
    const renameSearch = searchClause?.$or.find(entry => "rename" in entry) as
      | { rename: RegExp }
      | undefined;
    expect(renameSearch?.rename.test("pricing lead")).toBe(true);

    const historySearch = searchClause?.$or.find(
      entry => "history_summary" in entry
    ) as { history_summary: RegExp } | undefined;
    expect(historySearch?.history_summary.test("pricing history")).toBe(true);

    const categorySearch = searchClause?.$or.find(entry => "$and" in entry) as
      | { $and: Array<Record<string, unknown>> }
      | undefined;
    expect(categorySearch?.$and).toEqual([
      { "classification.category": expect.any(RegExp) },
      buildCurrentConversationClassificationFilter(),
    ]);

    expect(JSON.stringify(match)).not.toContain("Sales Leads");
    expect(JSON.stringify(match)).not.toContain("ready_now");
    expect(JSON.stringify(match)).not.toContain("followUpAudience");
  });
});

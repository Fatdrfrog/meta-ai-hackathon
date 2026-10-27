import {
  actionPassesRunConditions,
  matchesAudienceFilter,
  nodePassesFlowFilters,
  resolveConversationCustomerFacts,
} from "@/lib/airi/scenario/scenario-audience";
import type { ScenarioRuntimeNode } from "@icecore/airi-runtime/scenario-graph";
import type { ConversationDocument } from "@/types/models";

function actionWithCondition(
  condition: Record<string, unknown>
): ScenarioRuntimeNode {
  return {
    id: "action",
    data: {
      kind: "action",
      actionType: "reply",
      actionRunConditions: {
        version: 1,
        match: "all",
        conditions: [condition],
      },
    } as ScenarioRuntimeNode["data"],
  };
}

function conversation(
  overrides: Record<string, unknown> = {}
): ConversationDocument {
  return {
    _id: "conversation-1",
    channel: "whatsapp",
    chat: { _id: "customer-1" },
    ...overrides,
  } as unknown as ConversationDocument;
}

function currentClassification(category: string) {
  return {
    classification: { category },
    is_classified: true,
    classification_revision: 4,
    classification_state: {
      contractVersion: 2,
      status: "ready",
      requestedRevision: 4,
      appliedRevision: 4,
    },
    classification_meta: {
      source_revision: 4,
      provenance_kind: "v2",
      analysis_revision_id: "analysis-4",
    },
  };
}

describe("scenario action run conditions", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    [
      "classification with segment locks",
      { id: "classification", type: "classification", category: "active" },
      conversation({
        classification: { category: "lead_generation" },
        internal_labels: ["seg:active", "override:segment_locked"],
      }),
    ],
    [
      "internal label",
      { id: "label", type: "internal_label", label: "vip" },
      conversation({ internal_labels: ["vip"] }),
    ],
    [
      "specific customer key",
      {
        id: "customer",
        type: "specific_customers",
        customerIds: ["whatsapp:customer-1"],
      },
      conversation(),
    ],
    [
      "purchase history",
      { id: "purchase", type: "has_purchase_history" },
      conversation({ revenue_attribution_id: "order-1" }),
    ],
    [
      "funnel stage",
      { id: "stage", type: "funnel_stage", stage: "sales_qualified" },
      conversation(currentClassification("sales_qualified")),
    ],
    [
      "last seen days",
      { id: "last-seen", type: "last_seen_days", minimumDays: 7 },
      conversation({ lastMessageAt: "2026-07-01T12:00:00.000Z" }),
    ],
  ] as const)("matches %s", (_, condition, input) => {
    expect(
      actionPassesRunConditions(actionWithCondition(condition), input)
    ).toBe(true);
  });

  it("matches specific customers by legacy conversation id", () => {
    expect(
      actionPassesRunConditions(
        actionWithCondition({
          id: "customer",
          type: "specific_customers",
          customerIds: ["conversation-1"],
        }),
        conversation()
      )
    ).toBe(true);
  });

  it("requires every configured condition to pass", () => {
    const action = actionWithCondition({
      id: "label",
      type: "internal_label",
      label: "vip",
    });
    action.data.actionRunConditions = {
      version: 1,
      match: "all",
      conditions: [
        { id: "label", type: "internal_label", label: "vip" },
        { id: "purchase", type: "has_purchase_history" },
      ],
    };

    expect(
      actionPassesRunConditions(
        action,
        conversation({ internal_labels: ["vip"] })
      )
    ).toBe(false);
  });

  it("fails closed for unsupported run-condition versions", () => {
    const action = actionWithCondition({
      id: "label",
      type: "internal_label",
      label: "vip",
    });
    action.data.actionRunConditions = { version: 99 } as never;

    expect(actionPassesRunConditions(action, conversation())).toBe(false);
  });

  it("passes absent, supported empty, and normalized-empty configurations", () => {
    const absent = {
      id: "absent",
      data: { kind: "action", actionType: "reply" },
    } as ScenarioRuntimeNode;
    const supportedEmpty = {
      id: "supported-empty",
      data: {
        kind: "action",
        actionType: "reply",
        actionRunConditions: { version: 1, match: "all", conditions: [] },
      },
    } as ScenarioRuntimeNode;
    const normalizedEmpty = {
      id: "normalized-empty",
      data: {
        kind: "action",
        actionType: "reply",
        actionRunConditions: {
          version: 1,
          match: "all",
          conditions: [{ id: "invalid", type: "unknown" }],
        },
      },
    } as unknown as ScenarioRuntimeNode;

    expect(actionPassesRunConditions(absent, conversation())).toBe(true);
    expect(actionPassesRunConditions(supportedEmpty, conversation())).toBe(
      true
    );
    expect(actionPassesRunConditions(normalizedEmpty, conversation())).toBe(
      true
    );
  });

  it("applies legacy audience filters and action conditions together", () => {
    const action = actionWithCondition({
      id: "purchase",
      type: "has_purchase_history",
    });
    action.data.audienceMode = "internalLabel";
    action.data.internalLabel = "vip";

    expect(
      nodePassesFlowFilters(
        action,
        conversation({
          internal_labels: ["vip"],
          estimated_customer_ltv: 10,
        }),
        "whatsapp"
      )
    ).toBe(true);
    expect(
      nodePassesFlowFilters(
        action,
        conversation({
          internal_labels: ["vip"],
          estimated_customer_ltv: 0,
        }),
        "whatsapp"
      )
    ).toBe(false);
  });

  it("does not apply action conditions to non-action nodes", () => {
    const logicNode = {
      id: "logic",
      data: {
        kind: "logic",
        logicType: "condition",
        actionRunConditions: { version: 99 },
      },
    } as unknown as ScenarioRuntimeNode;

    expect(nodePassesFlowFilters(logicNode, conversation(), "whatsapp")).toBe(
      true
    );
  });

  it("keeps equivalent legacy audience and action predicates in parity", () => {
    const input = conversation({
      classification: { category: "lead_generation" },
      internal_labels: ["seg:active", "override:segment_locked"],
    });
    const legacyNode = {
      id: "legacy-filter",
      data: {
        kind: "logic",
        audienceMode: "classification",
        classificationCategory: "active",
      },
    } as ScenarioRuntimeNode;

    expect(matchesAudienceFilter(legacyNode, input)).toBe(true);
    expect(
      actionPassesRunConditions(
        actionWithCondition({
          id: "classification",
          type: "classification",
          category: "active",
        }),
        input
      )
    ).toBe(true);
  });

  it("does not let stale classification satisfy category or funnel conditions", () => {
    const stale = conversation({
      classification: { category: "sales_qualified" },
    });
    const classificationAudience = {
      id: "classification-audience",
      data: {
        kind: "logic",
        audienceMode: "classification",
        classificationCategory: "sales_qualified",
      },
    } as ScenarioRuntimeNode;

    expect(matchesAudienceFilter(classificationAudience, stale)).toBe(false);
    expect(
      actionPassesRunConditions(
        actionWithCondition({
          id: "classification",
          type: "classification",
          category: "sales_qualified",
        }),
        stale
      )
    ).toBe(false);
    expect(
      actionPassesRunConditions(
        actionWithCondition({
          id: "funnel",
          type: "funnel_stage",
          stage: "sales_qualified",
        }),
        stale
      )
    ).toBe(false);
  });

  it("preserves manual stage, segment, and internal-label decisions without current classification", () => {
    const manual = conversation({
      classification: { category: "lead_generation" },
      internal_labels: ["stage:sales_qualified", "seg:active", "vip"],
    });

    expect(
      actionPassesRunConditions(
        actionWithCondition({
          id: "stage",
          type: "funnel_stage",
          stage: "sales_qualified",
        }),
        manual
      )
    ).toBe(true);
    expect(
      actionPassesRunConditions(
        actionWithCondition({
          id: "classification",
          type: "classification",
          category: "active",
        }),
        manual
      )
    ).toBe(true);
    expect(
      actionPassesRunConditions(
        actionWithCondition({
          id: "label",
          type: "internal_label",
          label: "vip",
        }),
        manual
      )
    ).toBe(true);
  });

  it("uses only current classification when deriving customer facts and preserves purchases", () => {
    expect(
      resolveConversationCustomerFacts({
        classification: { category: "active" },
      } as never)
    ).toEqual({
      classificationCategory: null,
      hasPurchaseHistory: false,
      isNewCustomer: true,
    });
    expect(
      resolveConversationCustomerFacts({
        ...currentClassification("active"),
      } as never)
    ).toEqual({
      classificationCategory: "active",
      hasPurchaseHistory: false,
      isNewCustomer: false,
    });
    expect(
      resolveConversationCustomerFacts({
        classification: { category: "active" },
        estimated_customer_ltv: 10,
      } as never)
    ).toEqual({
      classificationCategory: null,
      hasPurchaseHistory: true,
      isNewCustomer: false,
    });
  });

  it("does not let external callers fabricate a current classification for customer facts", () => {
    const resolveWithUntrustedArguments = resolveConversationCustomerFacts as (
      ...args: unknown[]
    ) => unknown;

    expect(
      resolveWithUntrustedArguments(
        { classification: { category: "active" } },
        { currentClassification: { category: "active" } }
      )
    ).toEqual({
      classificationCategory: null,
      hasPurchaseHistory: false,
      isNewCustomer: true,
    });
  });

  it("resolves one hydrated current projection for combined node filters", () => {
    const toObject = jest.fn(() => ({
      _id: "conversation-1",
      channel: "whatsapp",
      chat: { _id: "customer-1" },
      ...currentClassification("active"),
    }));
    const hydrated = Object.create({ toObject }) as ConversationDocument;
    const action = actionWithCondition({
      id: "classification",
      type: "classification",
      category: "active",
    });
    action.data.audienceMode = "classification";
    action.data.classificationCategory = "active";

    expect(nodePassesFlowFilters(action, hydrated, "whatsapp")).toBe(true);
    expect(toObject).toHaveBeenCalledTimes(1);
  });
});

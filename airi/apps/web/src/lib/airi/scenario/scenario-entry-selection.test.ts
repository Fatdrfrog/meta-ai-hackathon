import { buildScenarioTriggerLogEvaluationContext } from "./scenario-entry-selection";
import {
  getClientMessageSpecificity,
  projectActiveClientMessageFilters,
} from "@/lib/scenarios/client-message-trigger-criteria";

const resolveScenarioTriggerSpecificity = (
  triggerConfig: Parameters<typeof projectActiveClientMessageFilters>[0]
) =>
  triggerConfig
    ? getClientMessageSpecificity(
        projectActiveClientMessageFilters(triggerConfig)
      ).score
    : 0;

function currentClassification(category: string) {
  return {
    classification: { category },
    is_classified: true,
    classification_revision: 8,
    classification_state: {
      contractVersion: 2,
      status: "ready",
      requestedRevision: 8,
      appliedRevision: 8,
    },
    classification_meta: {
      source_revision: 8,
      provenance_kind: "v2",
      analysis_revision_id: "analysis-8",
    },
  };
}

describe("resolveScenarioTriggerSpecificity", () => {
  it("scores an enabled Any trigger from configuration alone", () => {
    expect(
      resolveScenarioTriggerSpecificity({
        enabled: true,
        messageMatchMode: "any",
        keywordPattern: "refund",
        keywordMatchMode: "regex",
      })
    ).toBe(100);
  });

  it.each([
    ["exact", "refund", 425],
    ["contains", "refund", 325],
  ] as const)(
    "scores a valid enabled %s trigger as %d",
    (messageMatchMode, keywordPattern, score) => {
      expect(
        resolveScenarioTriggerSpecificity({
          enabled: true,
          messageMatchMode,
          keywordPattern,
        })
      ).toBe(score);
    }
  );

  it.each([
    {
      name: "Exact without a pattern",
      config: {
        enabled: true,
        messageMatchMode: "exact" as const,
      },
    },
    {
      name: "Contains without a pattern",
      config: {
        enabled: true,
        messageMatchMode: "contains" as const,
      },
    },
    {
      name: "delimiter-only literal Contains",
      config: {
        enabled: true,
        messageMatchMode: "contains" as const,
        keywordPattern: ", ;\r\n",
        keywordMatchMode: "contains" as const,
      },
    },
    {
      name: "invalid regex Contains",
      config: {
        enabled: true,
        messageMatchMode: "contains" as const,
        keywordPattern: "[",
        keywordMatchMode: "regex" as const,
      },
    },
  ])("returns zero for $name", ({ config }) => {
    expect(resolveScenarioTriggerSpecificity(config)).toBe(0);
  });

  it("returns zero for disabled or missing trigger configuration", () => {
    expect(
      resolveScenarioTriggerSpecificity({
        enabled: false,
        messageMatchMode: "exact",
      })
    ).toBe(0);
    expect(resolveScenarioTriggerSpecificity(null)).toBe(0);
    expect(resolveScenarioTriggerSpecificity(undefined)).toBe(0);
  });

  it("retains the active-filter boost while ignoring inactive Any matcher fields", () => {
    expect(
      resolveScenarioTriggerSpecificity({
        enabled: true,
        messageMatchMode: "contains",
        keywordPattern: "refund",
      })
    ).toBe(325);

    expect(
      resolveScenarioTriggerSpecificity({
        enabled: true,
        messageMatchMode: "any",
        metaReferralSourceIds: ["ig-ad-123"],
      })
    ).toBe(125);

    expect(
      resolveScenarioTriggerSpecificity({
        enabled: true,
        messageMatchMode: "any",
        onlyNewCustomers: false,
      })
    ).toBe(100);
  });
});

describe("buildScenarioTriggerLogEvaluationContext", () => {
  it("omits stale classification from category and funnel fallback", () => {
    const context = buildScenarioTriggerLogEvaluationContext({
      conversation: {
        classification: { category: "sales_qualified" },
      } as never,
      channel: "whatsapp",
    });

    expect(context).toEqual(
      expect.objectContaining({
        classificationCategory: null,
        funnelStage: "other",
        isNewCustomer: true,
      })
    );
  });

  it("uses current classification for the evaluation snapshot", () => {
    const context = buildScenarioTriggerLogEvaluationContext({
      conversation: currentClassification("sales_qualified") as never,
      channel: "whatsapp",
    });

    expect(context).toEqual(
      expect.objectContaining({
        classificationCategory: "sales_qualified",
        funnelStage: "sales_qualified",
        isNewCustomer: false,
      })
    );
  });

  it("keeps manual stage then segment precedence when classification is stale", () => {
    const stageContext = buildScenarioTriggerLogEvaluationContext({
      conversation: {
        classification: { category: "lead_generation" },
        internal_labels: ["stage:sales_qualified", "seg:active"],
      } as never,
      channel: "whatsapp",
    });
    const segmentContext = buildScenarioTriggerLogEvaluationContext({
      conversation: {
        classification: { category: "lead_generation" },
        internal_labels: ["seg:active"],
      } as never,
      channel: "whatsapp",
    });

    expect(stageContext?.funnelStage).toBe("sales_qualified");
    expect(segmentContext?.funnelStage).toBe("active");
  });
});

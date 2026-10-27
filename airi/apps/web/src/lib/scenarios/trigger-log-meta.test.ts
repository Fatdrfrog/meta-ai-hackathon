import type { ScenarioNodeData } from "@icecore/scenario-contracts";
import { compileScenarioGraph } from "@icecore/airi-runtime/scenario-graph";
import {
  buildScenarioTriggerLogFilterSummary,
  buildScenarioTriggerLogPathMeta,
  buildScenarioTriggerLogTemplateButtonTap,
} from "@/lib/scenarios/trigger-log-meta";

function createNode(id: string, data: ScenarioNodeData) {
  return { id, data };
}

describe("buildScenarioTriggerLogFilterSummary", () => {
  it("keeps only populated trigger filters", () => {
    expect(
      buildScenarioTriggerLogFilterSummary({
        channelFilter: ["whatsapp", "telegram"],
        messageMatchMode: "contains",
        keywordPattern: "refund",
        keywordMatchMode: "contains",
        onlyNewCustomers: true,
      })
    ).toEqual({
      channelFilter: ["whatsapp", "telegram"],
      messageMatchMode: "contains",
      keywordPattern: "refund",
      keywordMatchMode: "contains",
      onlyNewCustomers: true,
    });
  });

  it("returns null when the trigger config has no relevant filters", () => {
    expect(buildScenarioTriggerLogFilterSummary({})).toBeNull();
    expect(
      buildScenarioTriggerLogFilterSummary({
        messageMatchMode: "any",
        onlyNewCustomers: false,
      })
    ).toBeNull();
  });

  it("omits preserved message matcher fields while matching Any", () => {
    expect(
      buildScenarioTriggerLogFilterSummary({
        messageMatchMode: "any",
        keywordPattern: "refund",
        keywordMatchMode: "regex",
        metaReferralSourceIds: ["ig-ad-123"],
      })
    ).toEqual({
      metaReferralSourceIds: ["ig-ad-123"],
    });
  });

  it("does not report a preserved regex mode while matching Exact", () => {
    expect(
      buildScenarioTriggerLogFilterSummary({
        messageMatchMode: "exact",
        keywordPattern: "refund request",
        keywordMatchMode: "regex",
      })
    ).toEqual({
      messageMatchMode: "exact",
      keywordPattern: "refund request",
    });
  });

  it.each([
    {
      name: "Exact without a pattern",
      config: {
        messageMatchMode: "exact" as const,
        keywordPattern: " \n ",
      },
      expected: {
        messageMatchMode: "exact",
        keywordPattern: null,
        keywordMatchStatus: "missing-pattern",
      },
    },
    {
      name: "Contains without a pattern",
      config: {
        messageMatchMode: "contains" as const,
      },
      expected: {
        messageMatchMode: "contains",
        keywordPattern: null,
        keywordMatchMode: "contains",
        keywordMatchStatus: "missing-pattern",
      },
    },
    {
      name: "delimiter-only literal Contains",
      config: {
        messageMatchMode: "contains" as const,
        keywordPattern: ", ;\r\n",
        keywordMatchMode: "contains" as const,
      },
      expected: {
        messageMatchMode: "contains",
        keywordPattern: ", ;\r\n",
        keywordMatchMode: "contains",
        keywordMatchStatus: "empty-literal-pattern",
      },
    },
    {
      name: "invalid regex Contains",
      config: {
        messageMatchMode: "contains" as const,
        keywordPattern: "[",
        keywordMatchMode: "regex" as const,
      },
      expected: {
        messageMatchMode: "contains",
        keywordPattern: "[",
        keywordMatchMode: "regex",
        keywordMatchStatus: "invalid-regex",
      },
    },
  ])("retains projected diagnostics for $name", ({ config, expected }) => {
    expect(buildScenarioTriggerLogFilterSummary(config)).toEqual(expected);
  });
});

describe("buildScenarioTriggerLogPathMeta", () => {
  it("captures the chosen node path and source handles", () => {
    const graph = compileScenarioGraph(
      [
        createNode("trigger-1", {
          kind: "trigger",
        }),
        createNode("context-1", {
          kind: "context",
        }),
        createNode("action-1", {
          kind: "action",
          actionType: "reply",
        }),
      ],
      [
        {
          source: "trigger-1",
          target: "context-1",
          sourceHandle: "right-source",
        },
        {
          source: "context-1",
          target: "action-1",
          sourceHandle: "preferred-branch",
        },
      ]
    );

    expect(
      buildScenarioTriggerLogPathMeta({
        graph,
        pathNodeIds: ["trigger-1", "context-1", "action-1"],
      })
    ).toEqual({
      selectedPathNodeIds: ["trigger-1", "context-1", "action-1"],
      selectedSourceHandleIds: ["right-source", "preferred-branch"],
      selectedSourceHandleUsed: "preferred-branch",
    });
  });

  it("returns empty path detail when no path exists", () => {
    const graph = compileScenarioGraph([], []);

    expect(buildScenarioTriggerLogPathMeta({ graph, pathNodeIds: [] })).toEqual(
      {
        selectedPathNodeIds: [],
        selectedSourceHandleIds: [],
        selectedSourceHandleUsed: null,
      }
    );
  });
});

describe("buildScenarioTriggerLogTemplateButtonTap", () => {
  const menu = (
    buttonIds?: ScenarioNodeData["actionWhatsAppTemplateButtonIds"]
  ) =>
    compileScenarioGraph(
      [
        createNode("menu", {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateComponents: [
            {
              type: "BUTTONS",
              buttons: [
                { type: "URL", text: "See plans", url: "https://shop.test" },
                { type: "QUICK_REPLY", text: "Premium" },
              ],
            },
          ],
          ...(buttonIds ? { actionWhatsAppTemplateButtonIds: buttonIds } : {}),
        }),
      ],
      []
    );

  it("records the tapped button's id and where the step's template has it", () => {
    expect(
      buildScenarioTriggerLogTemplateButtonTap({
        graph: menu(),
        quickReplyPayload: "stb:menu:1",
      })
    ).toEqual({ actionNodeId: "menu", buttonId: 1, metaIndex: 1 });
    expect(
      buildScenarioTriggerLogTemplateButtonTap({
        graph: menu({
          version: 1,
          nextId: 11,
          buttons: [{ id: 10, index: 1, text: "Premium" }],
        }),
        quickReplyPayload: "stb:menu:10",
      })
    ).toEqual({ actionNodeId: "menu", buttonId: 10, metaIndex: 1 });
  });

  it("records a tap on a button the step no longer has", () => {
    expect(
      buildScenarioTriggerLogTemplateButtonTap({
        graph: menu(),
        quickReplyPayload: "stb:menu:0",
      })
    ).toEqual({ actionNodeId: "menu", buttonId: 0, metaIndex: null });
  });

  it("ignores other replies and other scenarios' steps", () => {
    for (const quickReplyPayload of [null, "Premium", "stb:other:1"]) {
      expect(
        buildScenarioTriggerLogTemplateButtonTap({
          graph: menu(),
          quickReplyPayload,
        })
      ).toBeNull();
    }
  });
});

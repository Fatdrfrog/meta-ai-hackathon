import { enrichLogicNodeData } from "./logic";
import {
  collectRecipientColumnNames,
  collectRecipientColumnValueSuggestions,
} from "@/lib/scenarios/recipient-column-split";
import type { ScenarioCampaignRecipient } from "../../types";

describe("enrichLogicNodeData", () => {
  it("derives column metadata from an immutable recipient snapshot", () => {
    const recipients: readonly ScenarioCampaignRecipient[] = Object.freeze([
      {
        phone: "+10000000001",
        fields: { tier: "gold", region: "KZ" },
      },
      {
        phone: "+10000000002",
        fields: { tier: "silver", region: "KZ" },
      },
    ]);

    expect(collectRecipientColumnNames(recipients)).toEqual(["region", "tier"]);
    expect(
      collectRecipientColumnValueSuggestions({ recipients, column: "tier" })
    ).toEqual(["gold", "silver"]);
  });

  it("projects post-action condition scope and persists branch deltas", () => {
    const updateNodeById = jest.fn();
    const enriched = enrichLogicNodeData(
      "condition-1",
      {
        kind: "logic",
        logicType: "post_action_condition",
      },
      {
        callbacksRef: {
          current: {
            updateNodeById,
            removeNodeById: jest.fn(),
          },
        },
        openNodePickerFromHandle: jest.fn(),
        graphIndex: {
          postActionConditionScopeByNodeId: new Map([
            [
              "condition-1",
              { scope: "telegram_branch", branchLabel: "Approve" },
            ],
          ]),
          destinationsBySourceHandleByNodeId: new Map([
            [
              "condition-1",
              new Map([["right-source-user-replied", { nodeId: "next", label: "Next" }]]),
            ],
          ]),
          connectedSourceHandleIdsByNodeId: new Map([
            ["condition-1", ["right-source-user-replied"]],
          ]),
          bulkColumnSplitNodeByRootId: new Map(),
          bulkColumnSplitRoutingByRootId: new Map(),
          bulkRootByColumnSplitNodeId: new Map(),
          connectedColumnSplitHandlesBySplitNodeId: new Map(),
        },
        whatsAppTemplates: [],
        t: (key: string) => key,
      } as never
    );

    enriched.uiOnConditionBranchChange?.("no_reply_timeout", {
      timeoutMinutes: 45,
    });

    expect(enriched.uiPostActionConditionScope).toBe("telegram_branch");
    expect(enriched.uiPostActionConditionScopeLabel).toBe("Approve");
    expect(enriched.uiDestinationsBySourceHandle?.get("right-source-user-replied")).toEqual({
      nodeId: "next",
      label: "Next",
    });
    expect(enriched.uiConnectedHandleIds?.has("right-source-user-replied")).toBe(
      true
    );
    expect(enriched.conditionBranches).toHaveLength(2);
    expect(updateNodeById).toHaveBeenCalledWith(
      "condition-1",
      expect.objectContaining({
        logicType: "post_action_condition",
        conditionBranches: expect.arrayContaining([
          expect.objectContaining({
            type: "no_reply_timeout",
            timeoutMinutes: 45,
          }),
        ]),
      })
    );
  });

  it("projects recipient columns, suggestions, and connected split handles", () => {
    const uploadedRecipients = [
      {
        phone: "+10000000001",
        fields: { tier: "gold", region: "KZ" },
      },
      {
        phone: "+10000000002",
        fields: { tier: "silver", region: "KZ" },
      },
    ];
    const connectedHandles = new Set(["right-source-column-split-gold"]);

    const enriched = enrichLogicNodeData(
      "split-1",
      {
        kind: "logic",
        logicType: "recipient_column_split",
      },
      {
        callbacksRef: {
          current: {
            updateNodeById: jest.fn(),
            removeNodeById: jest.fn(),
          },
        },
        openNodePickerFromHandle: jest.fn(),
        graphIndex: {
          postActionConditionScopeByNodeId: new Map(),
          destinationsBySourceHandleByNodeId: new Map(),
          connectedSourceHandleIdsByNodeId: new Map(),
          bulkColumnSplitNodeByRootId: new Map([["bulk-1", "split-1"]]),
          bulkColumnSplitRoutingByRootId: new Map(),
          bulkRootByColumnSplitNodeId: new Map([
            [
              "split-1",
              {
                bulkRootId: "bulk-1",
                birthdayAudience: false,
                uploadedRecipients,
              },
            ],
          ]),
          connectedColumnSplitHandlesBySplitNodeId: new Map([
            ["split-1", connectedHandles],
          ]),
        },
        whatsAppTemplates: [],
        t: (key: string) => key,
      } as never
    );

    expect(enriched.uiRecipientColumnOptions).toEqual(["region", "tier"]);
    expect(enriched.uiRecipientColumnValueSuggestions).toEqual({
      region: ["KZ"],
      tier: ["gold", "silver"],
    });
    expect(enriched.uiConnectedColumnSplitHandleIds).toBe(connectedHandles);
  });
});

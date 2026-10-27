/**
 * @jest-environment jsdom
 */

import { SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE } from "@icecore/scenario-contracts";
import { BulkCampaignSendError } from "@/lib/campaign/bulk-campaign-client";
import { resolveBulkConnectedActionFromNode } from "@/lib/scenarios/bulk-column-split-routing";
import type {
  ScenarioBulkConnectedAction,
  ScenarioNodeData,
  ScenarioWhatsAppTemplate,
} from "../types";
import {
  buildActionPatchForSelector,
  buildActionSourceOptions,
  resolveActionSelectorTypeForNode,
} from "./action/selector-utils";
import { enrichActionNodeData as enrichActionNodeDataImpl } from "./node-enrichment/action";
import { enrichBulkRootNodeData as enrichBulkRootNodeDataImpl } from "./node-enrichment/bulk";
import {
  buildScenarioNodeGraphIndex,
  type ScenarioNodeGraphIndex,
} from "./node-enrichment/scenario-node-graph-index";
import { enrichTriggerNodeData } from "./node-enrichment/trigger";
import type { ScenarioPersistedNodeDataOfKind } from "./node-enrichment/types";

const BULK_SEND_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

const REQUIRED_NODE_ENRICHMENT_CONTEXT_STATE = {
  selectedNodeId: null,
  sourceCapabilities: {
    hasWhatsApp: false,
    hasWhatsAppCoexistence: false,
    hasMetaAds: false,
  },
  legacyRoutingByActionId: new Map(),
  linkedConditionParentCountByNodeId: new Map<string, number>(),
};

function createTestGraphIndex(
  overrides?: Partial<ScenarioNodeGraphIndex>
): ScenarioNodeGraphIndex {
  return {
    ...buildScenarioNodeGraphIndex({ nodes: [], edges: [] }),
    ...overrides,
  };
}

function enrichActionNodeData(
  ...[nodeId, nodeData, ctx]: Parameters<typeof enrichActionNodeDataImpl>
) {
  return enrichActionNodeDataImpl(nodeId, nodeData, {
    ...ctx,
    graphIndex: createTestGraphIndex(ctx.graphIndex),
  });
}

function enrichBulkRootNodeData(
  nodeId: string,
  nodeData: Parameters<typeof enrichBulkRootNodeDataImpl>[1],
  ctx: Parameters<typeof enrichBulkRootNodeDataImpl>[2] & {
    whatsAppTemplates: ScenarioWhatsAppTemplate[];
  }
) {
  const graphIndexOverrides = ctx.graphIndex as
    | (Omit<Partial<ScenarioNodeGraphIndex>, "bulkActionByRootId"> & {
        bulkActionByRootId?: ReadonlyMap<
          string,
          | ScenarioBulkConnectedAction
          | { nodeId: string; data: ScenarioNodeData }
        >;
      })
    | undefined;
  let graphIndex = createTestGraphIndex(
    graphIndexOverrides as Partial<ScenarioNodeGraphIndex> | undefined
  );
  if (graphIndexOverrides?.bulkActionByRootId) {
    const bulkActionByRootId = new Map<string, ScenarioBulkConnectedAction>();
    for (const [rootId, action] of graphIndexOverrides.bulkActionByRootId) {
      if ("data" in action) {
        const resolved = resolveBulkConnectedActionFromNode({
          actionNodeId: action.nodeId,
          actionData: action.data,
          whatsAppTemplates: ctx.whatsAppTemplates,
        });
        if (resolved) bulkActionByRootId.set(rootId, resolved);
      } else {
        bulkActionByRootId.set(rootId, action);
      }
    }
    graphIndex = { ...graphIndex, bulkActionByRootId };
  }
  return enrichBulkRootNodeDataImpl(nodeId, nodeData, {
    ...ctx,
    graphIndex,
    t: ctx.t ?? (key => key),
    prepareScenarioBulkSend:
      ctx.prepareScenarioBulkSend ?? (async () => () => undefined),
  });
}

describe("enrichTriggerNodeData", () => {
  it("enriches a trigger without scenario-wide or trigger-type selector state", () => {
    const enriched = enrichTriggerNodeData(
      "trigger-1",
      {
        kind: "trigger",
        triggerConfig: { enabled: true },
      },
      {
        ...REQUIRED_NODE_ENRICHMENT_CONTEXT_STATE,
        callbacksRef: {
          current: {
            updateNodeById: jest.fn(),
            removeNodeById: jest.fn(),
            updateTriggerConfigById: jest.fn(),
          },
        },
        scenarioCallbacksRef: {
          current: {
            onScenarioMatchingRoleChange: jest.fn(),
            onScenarioEntryPolicyChange: jest.fn(),
            onScenarioJourneyPoolKeyChange: jest.fn(),
          },
        },
        graphIndex: { actionNodeCount: 0 },
        openNodePickerFromHandle: jest.fn(),
        audienceOptions: {
          channels: [],
          customers: [],
          internalLabels: [],
          funnelStages: [],
          classificationCategories: [],
        },
        scenarioMatchingRole: "fallback",
        scenarioEntryPolicy: "once_per_conversation",
        scenarioJourneyPoolKey: "product_entry",
        t: (key: string) => key,
      } as never
    );

    expect(enriched).not.toHaveProperty("uiScenarioMatchingRole");
    expect(enriched).not.toHaveProperty("uiOnScenarioMatchingRoleChange");
    expect(enriched).not.toHaveProperty("uiScenarioEntryPolicy");
    expect(enriched).not.toHaveProperty("uiOnScenarioEntryPolicyChange");
    expect(enriched).not.toHaveProperty("uiScenarioJourneyPoolKey");
    expect(enriched).not.toHaveProperty("uiOnScenarioJourneyPoolKeyChange");
    expect(enriched).not.toHaveProperty("uiIsScenarioEntrySettingsOwner");
    expect(enriched).not.toHaveProperty("uiTriggerTypeOptions");
    expect(enriched).not.toHaveProperty("uiOnTriggerTypeChange");
    expect(enriched.uiTriggerConfig).toMatchObject({
      enabled: true,
      messageMatchMode: "any",
    });
  });
});

describe("scenario action selector display state", () => {
  it("builds the source picker from messaging sources without pseudo-sources", () => {
    const t = (key: string) =>
      ({
        actionSourceWhatsApp: "WhatsApp",
        actionSourceInstagram: "Instagram",
        actionSourceTelegram: "Telegram",
        actionSourceEmail: "Email",
        actionSourceWebWidget: "Web widget",
        actionSourceTeam: "Team",
        actionSourceAiri: "Airi",
      })[key] ?? key;

    expect(
      buildActionSourceOptions({
        connectedActionSources: [
          "whatsapp",
          "instagram",
          "web_widget",
          "email",
        ],
        selectedSourceId: "whatsapp",
        t,
      }).map(option => option.id)
    ).toEqual(["whatsapp", "instagram", "web_widget", "email"]);
    expect(
      buildActionSourceOptions({
        connectedActionSources: ["whatsapp"],
        selectedSourceId: "team",
        t,
      }).map(option => option.id)
    ).toEqual(["whatsapp"]);
    expect(
      buildActionSourceOptions({
        connectedActionSources: ["whatsapp"],
        selectedSourceId: "telegram",
        t,
      }).map(option => option.id)
    ).toEqual(["whatsapp", "telegram"]);
  });

  it("maps email and web widget replies to dedicated channel selectors", () => {
    expect(
      resolveActionSelectorTypeForNode({
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "email",
      })
    ).toBe("email_reply");
    expect(
      resolveActionSelectorTypeForNode({
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "web_widget",
      })
    ).toBe("web_widget_reply");
  });

  it("maps Instagram reply nodes to an Instagram-specific selector", () => {
    expect(
      resolveActionSelectorTypeForNode({
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "instagram",
      })
    ).toBe("instagram_reply");
  });

  it("maps Telegram reply nodes to the Telegram builder selector", () => {
    expect(
      resolveActionSelectorTypeForNode({
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "telegram",
      })
    ).toBe("telegram_builder");
    expect(
      resolveActionSelectorTypeForNode({
        kind: "action",
        actionType: "reply",
        actionTelegramQuickReplies: [],
      })
    ).toBe("telegram_builder");
  });

  it("persists email reply as a reply action scoped to email", () => {
    expect(
      buildActionPatchForSelector({
        nodeData: {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          actionReplyText: "Email follow-up",
        },
        selectorType: "email_reply",
      })
    ).toMatchObject({
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyChannel: "email",
    });
  });

  it("persists Instagram reply as a reply action scoped to Instagram", () => {
    const nodeData: ScenarioNodeData = {
      kind: "action",
      actionType: "reply",
      actionReplyMode: "ai",
      actionReplyChannel: "instagram",
      actionInstagramConfig: {
        kind: "quick_replies",
        quickReplies: [{ title: "Pricing", payload: "pricing" }],
      },
      actionTelegramQuickReplies: [[{ text: "Old", payload: "old" }]],
    };

    expect(
      buildActionPatchForSelector({
        nodeData,
        selectorType: "instagram_reply",
      })
    ).toMatchObject({
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyChannel: "instagram",
      actionTelegramQuickReplies: undefined,
      actionInstagramConfig: {
        kind: "quick_replies",
        quickReplies: [{ title: "Pricing", payload: "pricing" }],
      },
    });
  });

  it("persists Telegram builder as a Telegram-scoped fixed reply", () => {
    expect(
      buildActionPatchForSelector({
        nodeData: {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "ai",
          actionReplyChannel: "instagram",
          actionInstagramConfig: {
            kind: "quick_replies",
            quickReplies: [{ title: "Old", payload: "old" }],
          },
        },
        selectorType: "telegram_builder",
      })
    ).toMatchObject({
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyChannel: "telegram",
      actionTelegramQuickReplies: [],
      actionInstagramConfig: undefined,
    });
  });

  it("clears the Instagram scope when switching back to generic reply", () => {
    expect(
      buildActionPatchForSelector({
        nodeData: {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          actionReplyText: "Hi",
          actionReplyChannel: "instagram",
        },
        selectorType: "reply",
      })
    ).toMatchObject({
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyChannel: undefined,
    });
  });
});

describe("enrichBulkRootNodeData", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("adopts the exact generated-send revision returned by the server", async () => {
    const updateNodeById = jest.fn();
    const adoptGeneratedBulkServerUpdate = jest.fn().mockReturnValue(true);
    const scenarioUpdate = {
      nodeId: "node-bulk-root",
      bulkRootConfigPatch: {
        generatedRecipientCount: 2,
        sendStatus: {
          total: 2,
          queued: 1,
          sent: 0,
          skipped: 1,
          failed: 0,
        },
        generatedSendState: {
          revision: "generation-job-1",
          operationId: "operation-1",
          state: "completed" as const,
          requestedAt: "2026-07-27T10:00:00.000Z",
          completedAt: "2026-07-27T10:01:00.000Z",
        },
      },
      scenarioUpdatedAt: "2026-07-27T10:01:00.000Z",
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        operationDisposition: "completed",
        queued: true,
        total: 1,
        requestedTotal: 2,
        skippedOptIn: 1,
        scenarioStatus: "active",
        scenarioUpdate,
      }),
    }) as jest.Mock;

    const rawData: ScenarioPersistedNodeDataOfKind<"bulk"> = {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "VIP Reactivation",
        recipientSourceSummary: "2 recipients",
        generationStatus: "complete",
        generationJobId: "generation-job-1",
      },
    };

    const enriched = enrichBulkRootNodeData("node-bulk-root", rawData, {
      activeScenarioId: "scenario-1",
      workspaceId: "workspace-1",
      nodes: [],
      edges: [],
      callbacksRef: {
        current: {
          updateNodeById,
          removeNodeById: jest.fn(),
        },
      },
      graphIndex: {
        bulkActionByRootId: new Map([
          [
            "node-bulk-root",
            {
              nodeId: "action-1",
              data: {
                kind: "action",
                actionType: "whatsapp_template",
                actionWhatsAppTemplateName: "vip_offer",
                actionWhatsAppTemplateLanguage: "en",
                actionWhatsAppTemplateComponents: [
                  { type: "BODY", text: "Hi {{name}}" },
                ],
              },
            },
          ],
        ]),
        instagramReplyActionIdsBlockedByBulkRoot: new Set<string>(),
      },
      whatsAppTemplates: [
        { name: "vip_offer", language: "en", status: "APPROVED" },
      ],
      t: (key: string) =>
        key === "bulkNodeSendRequiresAction"
          ? "Connect this campaign audience to a message action before sending"
          : key,
      openNodePickerFromHandle: jest.fn(),
      adoptGeneratedBulkServerUpdate,
    } as never);

    await enriched.uiOnBulkSend?.({ idempotencyKey: "generated-attempt-1" });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/scenario-generator/send",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          scenarioId: "scenario-1",
          idempotencyKey: "generated-attempt-1",
        }),
      })
    );
    expect(adoptGeneratedBulkServerUpdate).toHaveBeenCalledWith(
      scenarioUpdate,
      "active"
    );
    expect(updateNodeById).not.toHaveBeenCalled();
  });

  it("reconciles generated media refreshes without creating local node edits", async () => {
    const updateNodeById = jest.fn();
    const reconcileGeneratedJobServerUpdate = jest
      .fn()
      .mockResolvedValue({ status: "applied" });
    const actionData: ScenarioNodeData = {
      kind: "action",
      actionType: "reply",
      actionReplyText: "Generated media ready",
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        generationJobId: "generation-job-1",
        previousScenarioUpdatedAt: "2026-07-27T10:00:00.000Z",
        scenarioUpdatedAt: "2026-07-27T10:01:00.000Z",
        scenarioRevisionConflict: false,
        nodeUpdates: [{ id: "action-1", data: actionData }],
      }),
    }) as jest.Mock;

    const enriched = enrichBulkRootNodeData(
      "node-bulk-root",
      {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "VIP Reactivation",
          recipientSourceSummary: "Generated audience",
          generationStatus: "generating_media",
          generationJobId: "generation-job-1",
          generatedRecipientCount: 2,
        },
      },
      {
        activeScenarioId: "scenario-1",
        workspaceId: "workspace-1",
        nodes: [],
        edges: [],
        callbacksRef: {
          current: {
            updateNodeById,
            removeNodeById: jest.fn(),
          },
        },
        prepareGeneratedJobRefresh: jest.fn().mockResolvedValue(true),
        reconcileGeneratedJobServerUpdate,
        openNodePickerFromHandle: jest.fn(),
      } as never
    );

    await enriched.uiOnRefreshGenerationJob?.();

    expect(reconcileGeneratedJobServerUpdate).toHaveBeenCalledWith({
      generationJobId: "generation-job-1",
      previousScenarioUpdatedAt: "2026-07-27T10:00:00.000Z",
      scenarioUpdatedAt: "2026-07-27T10:01:00.000Z",
      scenarioRevisionConflict: false,
      nodeUpdates: [{ id: "action-1", data: actionData }],
    });
    expect(updateNodeById).not.toHaveBeenCalled();
  });

  it("awaits owner save preparation before fetching a generated media refresh", async () => {
    let releasePreparation: ((ready: boolean) => void) | undefined;
    const prepareGeneratedJobRefresh = jest.fn(
      () =>
        new Promise<boolean>(resolve => {
          releasePreparation = resolve;
        })
    );
    const reconcileGeneratedJobServerUpdate = jest
      .fn()
      .mockResolvedValue({ status: "no_op" });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        generationJobId: "generation-job-1",
        previousScenarioUpdatedAt: "2026-07-27T10:00:00.000Z",
        scenarioUpdatedAt: "2026-07-27T10:00:00.000Z",
        scenarioRevisionConflict: false,
        nodeUpdates: [],
      }),
    }) as jest.Mock;

    const enriched = enrichBulkRootNodeData(
      "node-bulk-root",
      {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "VIP Reactivation",
          recipientSourceSummary: "Generated audience",
          generationStatus: "generating_media",
          generationJobId: "generation-job-1",
          generatedRecipientCount: 2,
        },
      },
      {
        activeScenarioId: "scenario-1",
        workspaceId: "workspace-1",
        nodes: [],
        edges: [],
        callbacksRef: {
          current: {
            updateNodeById: jest.fn(),
            removeNodeById: jest.fn(),
          },
        },
        prepareGeneratedJobRefresh,
        reconcileGeneratedJobServerUpdate,
        openNodePickerFromHandle: jest.fn(),
      } as never
    );

    const refreshPromise = enriched.uiOnRefreshGenerationJob?.();

    expect(prepareGeneratedJobRefresh).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();

    releasePreparation?.(true);
    await refreshPromise;

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(reconcileGeneratedJobServerUpdate).toHaveBeenCalledTimes(1);
  });

  it("preserves generated-send audience confirmation details for the bulk node", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        code: "bulk_campaign_recent_audience_confirmation_required",
        error: "Confirm sending to this recent audience again.",
        audience: {
          fingerprint: "b".repeat(64),
          overlap: {
            kind: "exact",
            intersectionCount: 10,
            candidateCount: 10,
            ratio: 1,
          },
        },
        audienceConfirmation: {
          required: true,
          confirmed: false,
          fingerprint: "b".repeat(64),
        },
      }),
    }) as jest.Mock;

    const enriched = enrichBulkRootNodeData(
      "node-bulk-root",
      {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "VIP Reactivation",
          recipientSourceSummary: "Generated audience",
          generationStatus: "complete",
          generationJobId: "generation-job-1",
          generatedRecipientCount: 10,
        },
      },
      {
        activeScenarioId: "scenario-1",
        workspaceId: "workspace-1",
        nodes: [],
        edges: [],
        callbacksRef: {
          current: {
            updateNodeById: jest.fn(),
            removeNodeById: jest.fn(),
          },
        },
        graphIndex: {
          bulkActionByRootId: new Map([
            [
              "node-bulk-root",
              {
                nodeId: "action-1",
                data: {
                  kind: "action",
                  actionType: "whatsapp_template",
                  actionWhatsAppTemplateName: "vip_offer",
                  actionWhatsAppTemplateLanguage: "en",
                  actionWhatsAppTemplateComponents: [
                    { type: "BODY", text: "Hi {{name}}" },
                  ],
                },
              },
            ],
          ]),
          instagramReplyActionIdsBlockedByBulkRoot: new Set<string>(),
        },
        whatsAppTemplates: [
          { name: "vip_offer", language: "en", status: "APPROVED" },
        ],
        openNodePickerFromHandle: jest.fn(),
      } as never
    );

    let error: unknown;
    try {
      await enriched.uiOnBulkSend?.();
    } catch (value) {
      error = value;
    }

    expect(error).toBeInstanceOf(BulkCampaignSendError);
    expect(error).toMatchObject({
      code: "bulk_campaign_recent_audience_confirmation_required",
      audienceFingerprint: "b".repeat(64),
      confirmationRequired: true,
      overlap: {
        kind: "exact",
        intersectionCount: 10,
        candidateCount: 10,
        ratio: 1,
      },
    });
  });

  it("blocks immediate send when the campaign audience has no connected message action", async () => {
    const updateNodeById = jest.fn();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 1,
      }),
    }) as jest.Mock;

    const rawData: ScenarioPersistedNodeDataOfKind<"bulk"> = {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "VIP Reactivation",
        recipientSourceSummary: "Manual upload",
        generationStatus: "idle",
      },
    };

    const enriched = enrichBulkRootNodeData("node-bulk-root", rawData, {
      activeScenarioId: "scenario-1",
      workspaceId: "workspace-1",
      nodes: [],
      edges: [],
      callbacksRef: {
        current: {
          updateNodeById,
          removeNodeById: jest.fn(),
        },
      },
      t: (key: string) =>
        key === "bulkNodeSendRequiresAction"
          ? "Connect this campaign audience to a message action before sending"
          : key,
      openNodePickerFromHandle: jest.fn(),
    } as never);

    await expect(enriched.uiOnBulkSend?.()).rejects.toThrow(
      "campaign audience"
    );

    expect(global.fetch).not.toHaveBeenCalled();
    expect(updateNodeById).not.toHaveBeenCalled();
  });

  it("blocks send when the connected WhatsApp template is stale", async () => {
    const updateNodeById = jest.fn();
    global.fetch = jest.fn() as jest.Mock;

    const rawData: ScenarioPersistedNodeDataOfKind<"bulk"> = {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "Stale template campaign",
        recipientSourceSummary: "Manual upload",
        generationStatus: "idle",
      },
    };

    const enriched = enrichBulkRootNodeData("node-bulk-root", rawData, {
      activeScenarioId: "scenario-1",
      workspaceId: "workspace-1",
      nodes: [],
      edges: [],
      callbacksRef: {
        current: {
          updateNodeById,
          removeNodeById: jest.fn(),
        },
      },
      graphIndex: {
        bulkActionByRootId: new Map([
          [
            "node-bulk-root",
            {
              nodeId: "action-1",
              data: {
                kind: "action",
                actionType: "whatsapp_template",
                actionWhatsAppTemplateName: "1",
                actionWhatsAppTemplateLanguage: "ru",
                actionWhatsAppTemplateComponents: [
                  { type: "BODY", text: "Hello" },
                ],
              },
            },
          ],
        ]),
        instagramReplyActionIdsBlockedByBulkRoot: new Set<string>(),
      },
      whatsAppTemplates: [
        { name: "other_template", language: "en", status: "APPROVED" },
      ],
      t: (key: string) => key,
      openNodePickerFromHandle: jest.fn(),
    } as never);

    expect(enriched.uiBulkConnectedAction?.templateSendBlockReason).toBe(
      "stale"
    );
    await expect(
      enriched.uiOnBulkSend?.({
        recipients: [{ phone: "77001234567", name: "Sam" }],
      })
    ).rejects.toThrow("bulkNodeTemplateSendBlockedStale");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("sends uploaded recipients through the connected WhatsApp template action", async () => {
    const updateNodeById = jest.fn();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        queued: true,
        total: 1,
        campaignId: "campaign-1",
        dispatchId: "dispatch-1",
        workflowId: "workflow-1",
        status: "queued",
        audience: {
          fingerprint: "a".repeat(64),
          requestedTotal: 1,
          queuedTotal: 1,
          skippedOptIn: 0,
          overlap: {
            kind: "high",
            intersectionCount: 8,
            candidateCount: 10,
            ratio: 0.8,
          },
        },
      }),
    }) as jest.Mock;

    const rawData: ScenarioPersistedNodeDataOfKind<"bulk"> = {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "VIP Reactivation",
        recipientSourceSummary: "Manual upload",
        generationStatus: "idle",
        audienceRevision: 4,
        audienceUploadEvidence: {
          originalFilename: "vip.csv",
          selectedAt: "2026-07-24T08:00:00.000Z",
        },
      },
    };

    const enriched = enrichBulkRootNodeData("node-bulk-root", rawData, {
      activeScenarioId: "scenario-1",
      workspaceId: BULK_SEND_WORKSPACE_ID,
      nodes: [],
      edges: [],
      callbacksRef: {
        current: {
          updateNodeById,
          removeNodeById: jest.fn(),
        },
      },
      graphIndex: {
        bulkActionByRootId: new Map([
          [
            "node-bulk-root",
            {
              nodeId: "action-1",
              data: {
                kind: "action",
                actionType: "whatsapp_template",
                actionWhatsAppTemplateName: "vip_offer",
                actionWhatsAppTemplateLanguage: "en",
                actionWhatsAppTemplateComponents: [
                  { type: "BODY", text: "Hi {{name}}" },
                ],
              },
            },
          ],
        ]),
        instagramReplyActionIdsBlockedByBulkRoot: new Set<string>(),
      },
      whatsAppTemplates: [
        { name: "vip_offer", language: "en", status: "APPROVED" },
      ],
      openNodePickerFromHandle: jest.fn(),
    } as never);

    await enriched.uiOnBulkSend?.({
      recipients: [
        {
          phone: "77001234567",
          name: "Aibek",
          fields: { name: "Aibek" },
        },
      ],
      variableConfigs: {
        name: { mode: "contact_name" },
      },
      audienceUploadEvidence: {
        originalFilename: "vip.csv",
        selectedAt: "2026-07-24T08:00:00.000Z",
      },
      audienceConfirmationFingerprint: "b".repeat(64),
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/campaigns/bulk-send",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"templateName":"vip_offer"'),
      })
    );
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body).toMatchObject({
      workspaceId: BULK_SEND_WORKSPACE_ID,
      channel: "whatsapp",
      campaignName: "VIP Reactivation",
      provenance: {
        kind: "scenario_run_now",
        scenarioId: "scenario-1",
        rootNodeId: "node-bulk-root",
        actionNodeId: "action-1",
      },
      templateName: "vip_offer",
      languageCode: "en",
      audience: {
        kind: "inline",
        recipients: [
          {
            phone: "77001234567",
            variables: { name: "Aibek" },
          },
        ],
        uploadEvidence: {
          originalFilename: "vip.csv",
          selectedAt: "2026-07-24T08:00:00.000Z",
        },
      },
      audienceConfirmationFingerprint: "b".repeat(64),
    });
    expect(updateNodeById).toHaveBeenCalledWith("node-bulk-root", {
      bulkRootConfig: {
        ...rawData.bulkRootConfig,
        sendStatus: expect.objectContaining({
          campaignId: "campaign-1",
          dispatchId: "dispatch-1",
          workflowId: "workflow-1",
          lifecycleStatus: "queued",
          audienceFingerprint: "a".repeat(64),
          audienceRevision: 4,
          overlap: expect.objectContaining({
            intersectionCount: 8,
            candidateCount: 10,
          }),
        }),
      },
    });
  });

  it("sends registered business phones through the connected WhatsApp template action", async () => {
    const updateNodeById = jest.fn();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        queued: true,
        total: 12,
      }),
    }) as jest.Mock;

    const rawData: ScenarioPersistedNodeDataOfKind<"bulk"> = {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "Registered Business Follow-up",
        recipientSourceSummary: "Registered businesses",
        generationStatus: "idle",
      },
    };

    const enriched = enrichBulkRootNodeData("node-bulk-root", rawData, {
      activeScenarioId: "scenario-1",
      workspaceId: BULK_SEND_WORKSPACE_ID,
      nodes: [],
      edges: [],
      callbacksRef: {
        current: {
          updateNodeById,
          removeNodeById: jest.fn(),
        },
      },
      graphIndex: {
        bulkActionByRootId: new Map([
          [
            "node-bulk-root",
            {
              nodeId: "action-1",
              data: {
                kind: "action",
                actionType: "whatsapp_template",
                actionWhatsAppTemplateName: "vip_offer",
                actionWhatsAppTemplateLanguage: "en",
                actionWhatsAppTemplateCategory: "MARKETING",
                actionWhatsAppTemplateComponents: [
                  { type: "BODY", text: "Hi {{name}}" },
                ],
              },
            },
          ],
        ]),
        instagramReplyActionIdsBlockedByBulkRoot: new Set<string>(),
      },
      whatsAppTemplates: [
        { name: "vip_offer", language: "en", status: "APPROVED" },
      ],
      openNodePickerFromHandle: jest.fn(),
    } as never);

    await enriched.uiOnBulkSend?.({
      registeredBusinessPhonesAudience: {
        type: SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE,
      },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/campaigns/bulk-send",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining(
          `"audience":{"kind":"${SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE}"}`
        ),
      })
    );
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body).toMatchObject({
      workspaceId: BULK_SEND_WORKSPACE_ID,
      channel: "whatsapp",
      campaignName: "Registered Business Follow-up",
      provenance: {
        kind: "scenario_run_now",
        scenarioId: "scenario-1",
        rootNodeId: "node-bulk-root",
        actionNodeId: "action-1",
      },
      templateName: "vip_offer",
      languageCode: "en",
      audience: {
        kind: SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE,
      },
    });
    expect(body).not.toHaveProperty("recipients");
    expect(body.audience).not.toHaveProperty("recipients");
  });

  it("passes the selected schedule date when uploaded recipients are scheduled", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        queued: true,
        total: 1,
        scheduledAt: "2099-05-15T10:00:00.000Z",
      }),
    }) as jest.Mock;

    const rawData: ScenarioPersistedNodeDataOfKind<"bulk"> = {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "Scheduled Reactivation",
        recipientSourceSummary: "Manual upload",
        generationStatus: "idle",
      },
    };

    const enriched = enrichBulkRootNodeData("node-bulk-root", rawData, {
      activeScenarioId: "scenario-1",
      workspaceId: BULK_SEND_WORKSPACE_ID,
      nodes: [],
      edges: [],
      callbacksRef: {
        current: {
          updateNodeById: jest.fn(),
          removeNodeById: jest.fn(),
        },
      },
      graphIndex: {
        bulkActionByRootId: new Map([
          [
            "node-bulk-root",
            {
              nodeId: "action-1",
              data: {
                kind: "action",
                actionType: "whatsapp_template",
                actionWhatsAppTemplateName: "vip_offer",
                actionWhatsAppTemplateLanguage: "en",
                actionWhatsAppTemplateComponents: [
                  { type: "BODY", text: "Hi {{name}}" },
                ],
              },
            },
          ],
        ]),
        instagramReplyActionIdsBlockedByBulkRoot: new Set<string>(),
      },
      whatsAppTemplates: [
        { name: "vip_offer", language: "en", status: "APPROVED" },
      ],
      openNodePickerFromHandle: jest.fn(),
    } as never);

    await enriched.uiOnBulkSend?.({
      recipients: [
        {
          phone: "77001234567",
          name: "Aibek",
          fields: { name: "Aibek" },
        },
      ],
      variableConfigs: {
        name: { mode: "contact_name" },
      },
      scheduledAt: "2099-05-15T10:00:00.000Z",
    } as never);

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body).toMatchObject({
      scheduledAt: "2099-05-15T10:00:00.000Z",
    });
  });
});

describe("enrichActionNodeData", () => {
  it("routes action selector changes through the branch transition exactly once", () => {
    const handleBranchSyncForNode = jest.fn();
    const updateNodeById = jest.fn();
    const enriched = enrichActionNodeData(
      "action-1",
      { kind: "action", actionType: "reply" },
      {
        ...REQUIRED_NODE_ENRICHMENT_CONTEXT_STATE,
        graphIndex: {
          actionNodeCount: 1,
          connectedSourceHandleIdsByNodeId: new Map(),
          connectedTelegramBranchPayloadsByActionId: new Map(),
          connectedInstagramBranchPayloadsByActionId: new Map(),
          connectedWhatsAppSessionChoicePayloadsByActionId: new Map(),
          connectedFlowBranchIdsByActionId: new Map(),
          connectedWhatsAppTemplateButtonPayloadsByActionId: new Map(),
          bulkPrimaryActionIds: new Set<string>(),
          instagramReplyActionIdsBlockedByBulkRoot: new Set<string>(),
          postActionConditionScopeByNodeId: new Map(),
        },
        callbacksRef: {
          current: {
            updateNodeById,
            resolvePreviewProfileForActionNode: jest.fn(() => ({
              channel: "whatsapp",
            })),
          },
        },
        handleBranchSyncForNodeRef: { current: handleBranchSyncForNode },
        whatsAppTemplates: [],
        t: (key: string) => key,
      } as never
    );

    enriched.uiActionCommands.changeType("whatsapp_template");

    expect(updateNodeById).not.toHaveBeenCalled();
    expect(handleBranchSyncForNode).toHaveBeenCalledTimes(1);
    expect(handleBranchSyncForNode).toHaveBeenCalledWith(
      "action-1",
      expect.any(Array),
      buildActionPatchForSelector({
        nodeData: { kind: "action", actionType: "reply" },
        selectorType: "whatsapp_template",
      }),
      undefined
    );
  });

  it("converts projected legacy routing before editing or opening an outcome", async () => {
    const convertLegacyActionRouting = jest.fn().mockResolvedValue(true);
    const updateNodeById = jest.fn();
    const openNodePickerFromHandle = jest.fn();
    const legacyPresentation = {
      actionOutcomes: {
        version: 1 as const,
        anyReply: { enabled: true },
      },
      actionOutcomesSource: {
        sourceNodeId: "condition-1",
        sourceKind: "post_action_condition" as const,
      },
      actionRunConditionsSource: {
        sourceNodeId: "gate-1",
        sourceKind: "audience_filter" as const,
      },
    };
    const enriched = enrichActionNodeData(
      "action-1",
      {
        kind: "action",
        actionType: "reply",
        actionOutcomes: legacyPresentation.actionOutcomes,
      },
      {
        ...REQUIRED_NODE_ENRICHMENT_CONTEXT_STATE,
        legacyRoutingByActionId: new Map([["action-1", legacyPresentation]]),
        graphIndex: {
          actionNodeCount: 1,
          connectedSourceHandleIdsByNodeId: new Map(),
          connectedTelegramBranchPayloadsByActionId: new Map(),
          connectedInstagramBranchPayloadsByActionId: new Map(),
          connectedWhatsAppSessionChoicePayloadsByActionId: new Map(),
          connectedFlowBranchIdsByActionId: new Map(),
          connectedWhatsAppTemplateButtonPayloadsByActionId: new Map(),
          bulkPrimaryActionIds: new Set<string>(),
          instagramReplyActionIdsBlockedByBulkRoot: new Set<string>(),
          postActionConditionScopeByNodeId: new Map(),
        },
        t: (key: string) => key,
        callbacksRef: {
          current: {
            convertLegacyActionRouting,
            updateNodeById,
            resolvePreviewProfileForActionNode: jest.fn(() => ({
              channel: "whatsapp",
            })),
          },
        },
        handleBranchSyncForNodeRef: { current: jest.fn() },
        openNodePickerFromHandle,
        whatsAppTemplates: [],
      } as never
    );
    const actionOutcomes = {
      version: 1 as const,
      noReply: { enabled: true, timeoutMinutes: 45 },
    };
    const actionRunConditions = {
      version: 1 as const,
      match: "all" as const,
      conditions: [
        { id: "vip", type: "internal_label" as const, label: "vip" },
      ],
    };

    enriched.uiOnPatch?.({ actionOutcomes });
    enriched.uiOnPatch?.({ actionRunConditions });
    await enriched.uiOnCreateNodeFromSourceHandle?.(
      "right-source-action-outcome::any-reply",
      100,
      200
    );

    expect(convertLegacyActionRouting).toHaveBeenNthCalledWith(1, {
      sourceActionNodeId: "action-1",
      sourceNodeId: "condition-1",
      sourceKind: "post_action_condition",
      patch: { actionOutcomes },
    });
    expect(convertLegacyActionRouting).toHaveBeenNthCalledWith(2, {
      sourceActionNodeId: "action-1",
      sourceNodeId: "gate-1",
      sourceKind: "audience_filter",
      patch: { actionRunConditions },
    });
    expect(convertLegacyActionRouting).toHaveBeenNthCalledWith(3, {
      sourceActionNodeId: "action-1",
      sourceNodeId: "condition-1",
      sourceKind: "post_action_condition",
      patch: {},
    });
    expect(updateNodeById).not.toHaveBeenCalled();
    expect(openNodePickerFromHandle).toHaveBeenCalledWith(
      "action-1",
      "right-source-action-outcome::any-reply",
      100,
      200
    );
  });

  it("opens persisted outcome handles without converting an unrelated legacy gate", async () => {
    const convertLegacyActionRouting = jest.fn().mockResolvedValue(true);
    const openNodePickerFromHandle = jest.fn();
    const enriched = enrichActionNodeData(
      "action-1",
      {
        kind: "action",
        actionType: "reply",
        actionOutcomes: { version: 1, anyReply: { enabled: true } },
      },
      {
        ...REQUIRED_NODE_ENRICHMENT_CONTEXT_STATE,
        legacyRoutingByActionId: new Map([
          [
            "action-1",
            {
              actionRunConditionsSource: {
                sourceNodeId: "gate-1",
                sourceKind: "audience_filter",
              },
            },
          ],
        ]),
        graphIndex: {
          actionNodeCount: 1,
          connectedSourceHandleIdsByNodeId: new Map(),
          connectedTelegramBranchPayloadsByActionId: new Map(),
          connectedInstagramBranchPayloadsByActionId: new Map(),
          connectedWhatsAppSessionChoicePayloadsByActionId: new Map(),
          connectedFlowBranchIdsByActionId: new Map(),
          connectedWhatsAppTemplateButtonPayloadsByActionId: new Map(),
          bulkPrimaryActionIds: new Set<string>(),
          instagramReplyActionIdsBlockedByBulkRoot: new Set<string>(),
          postActionConditionScopeByNodeId: new Map(),
        },
        t: (key: string) => key,
        callbacksRef: {
          current: {
            convertLegacyActionRouting,
            resolvePreviewProfileForActionNode: jest.fn(() => ({
              channel: "whatsapp",
            })),
          },
        },
        handleBranchSyncForNodeRef: { current: jest.fn() },
        openNodePickerFromHandle,
        whatsAppTemplates: [],
      } as never
    );

    await enriched.uiOnCreateNodeFromSourceHandle?.(
      "right-source-action-outcome::any-reply",
      10,
      20
    );

    expect(convertLegacyActionRouting).not.toHaveBeenCalled();
    expect(openNodePickerFromHandle).toHaveBeenCalledWith(
      "action-1",
      "right-source-action-outcome::any-reply",
      10,
      20
    );
  });

  it("marks Instagram reply actions disabled when attached to a bulk campaign path", () => {
    const enriched = enrichActionNodeData(
      "action-instagram",
      {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "instagram",
      },
      {
        ...REQUIRED_NODE_ENRICHMENT_CONTEXT_STATE,
        graphIndex: {
          actionNodeCount: 1,
          connectedTelegramBranchPayloadsByActionId: new Map(),
          connectedInstagramBranchPayloadsByActionId: new Map(),
          connectedWhatsAppSessionChoicePayloadsByActionId: new Map(),
          connectedFlowBranchIdsByActionId: new Map(),
          connectedWhatsAppTemplateButtonPayloadsByActionId: new Map(),
          instagramReplyActionIdsBlockedByBulkRoot: new Set([
            "action-instagram",
          ]),
        },
        whatsAppTemplates: [],
        whatsAppFlows: [],
        workspaceId: "workspace-1",
        t: (key: string) =>
          key === "instagramReplyBulkDisabled"
            ? "Instagram reply cannot be used in bulk"
            : key,
        callbacksRef: {
          current: {
            updateNodeById: jest.fn(),
            removeNodeById: jest.fn(),
            resolvePreviewProfileForActionNode: jest.fn(() => ({
              channel: "instagram",
            })),
          },
        },
      } as never
    );

    expect(enriched.uiInstagramReplyDisabledReason).toBe(
      "Instagram reply cannot be used in bulk"
    );
  });

  it("marks the top-connected bulk template action as the primary bulk send action", () => {
    const enriched = enrichActionNodeData(
      "action-template",
      {
        kind: "action",
        actionType: "whatsapp_template",
      },
      {
        ...REQUIRED_NODE_ENRICHMENT_CONTEXT_STATE,
        nodes: [],
        edges: [],
        graphIndex: {
          actionNodeCount: 1,
          connectedTelegramBranchPayloadsByActionId: new Map(),
          connectedInstagramBranchPayloadsByActionId: new Map(),
          connectedWhatsAppSessionChoicePayloadsByActionId: new Map(),
          connectedFlowBranchIdsByActionId: new Map(),
          connectedWhatsAppTemplateButtonPayloadsByActionId: new Map(),
          bulkPrimaryActionIds: new Set(["action-template"]),
          instagramReplyActionIdsBlockedByBulkRoot: new Set<string>(),
          postActionConditionScopeByNodeId: new Map(),
        },
        connectedActionSources: ["whatsapp"],
        t: (key: string) => key,
        callbacksRef: {
          current: {
            resolvePreviewProfileForActionNode: jest.fn(() => ({
              channel: "whatsapp",
            })),
          },
        },
        handleBranchSyncForNodeRef: {
          current: jest.fn(),
        },
        openNodePickerFromHandle: jest.fn(),
        whatsAppTemplates: [],
      } as never
    );

    expect(enriched.uiBulkPrimaryAction).toBe(true);
  });

  it("opens the WhatsApp picker without forcing a refresh", () => {
    const loadWhatsAppTemplates = jest.fn().mockResolvedValue(undefined);

    const enriched = enrichActionNodeData(
      "action-template",
      {
        kind: "action",
        actionType: "whatsapp_template",
      },
      {
        ...REQUIRED_NODE_ENRICHMENT_CONTEXT_STATE,
        graphIndex: {
          actionNodeCount: 1,
          connectedTelegramBranchPayloadsByActionId: new Map(),
          connectedInstagramBranchPayloadsByActionId: new Map(),
          connectedWhatsAppSessionChoicePayloadsByActionId: new Map(),
          connectedFlowBranchIdsByActionId: new Map(),
          connectedWhatsAppTemplateButtonPayloadsByActionId: new Map(),
          bulkPrimaryActionIds: new Set<string>(),
          instagramReplyActionIdsBlockedByBulkRoot: new Set<string>(),
          postActionConditionScopeByNodeId: new Map(),
        },
        connectedActionSources: ["whatsapp"],
        t: (key: string) => key,
        callbacksRef: {
          current: {
            loadWhatsAppTemplates,
            resolvePreviewProfileForActionNode: jest.fn(() => ({
              channel: "whatsapp",
            })),
          },
        },
        handleBranchSyncForNodeRef: {
          current: jest.fn(),
        },
        openNodePickerFromHandle: jest.fn(),
        whatsAppTemplates: [],
      } as never
    );

    enriched.uiWhatsAppTemplates.onOpenChange(true);
    expect(loadWhatsAppTemplates).toHaveBeenCalledWith();

    loadWhatsAppTemplates.mockClear();
    enriched.uiWhatsAppTemplates.onOpenChange(false);
    expect(loadWhatsAppTemplates).not.toHaveBeenCalled();
  });
});

const mockPostBulkCampaignSend = jest.fn();

jest.mock("@/lib/campaign/bulk-campaign-client", () => {
  const actual = jest.requireActual("@/lib/campaign/bulk-campaign-client");
  return {
    ...actual,
    postBulkCampaignSend: (...args: unknown[]) =>
      mockPostBulkCampaignSend(...args),
  };
});

import { BulkCampaignSendError } from "@/lib/campaign/bulk-campaign-client";
import { parseBulkCampaignSendRequest } from "@/lib/campaign/bulk-campaign-contracts";
import { resolveBulkColumnSplitRouting } from "@/lib/scenarios/bulk-column-split-routing";
import { enrichBulkRootNodeData } from "./bulk";
import type { ScenarioCampaignRecipient } from "../../types";
import type { ScenarioPersistedNodeDataOfKind } from "./types";

const { postBulkCampaignSend: actualPostBulkCampaignSend } = jest.requireActual<
  typeof import("@/lib/campaign/bulk-campaign-client")
>("@/lib/campaign/bulk-campaign-client");

const workspaceId = "00000000-0000-4000-8000-000000000801";

function baseContext(updateNodeById = jest.fn()) {
  return {
    activeScenarioId: "scenario-1",
    workspaceId,
    whatsAppTemplates: [],
    callbacksRef: {
      current: {
        updateNodeById,
        removeNodeById: jest.fn(),
      },
    },
    scenarioCallbacksRef: { current: {} },
    openNodePickerFromHandle: jest.fn(),
    prepareGeneratedJobRefresh: jest.fn(),
    prepareScenarioBulkSend: jest.fn().mockResolvedValue(jest.fn()),
    reconcileGeneratedJobServerUpdate: jest.fn(),
    adoptGeneratedBulkServerUpdate: jest.fn(),
    t: (key: string) => key,
  };
}

const connectedAction = {
  nodeId: "action-1",
  actionType: "whatsapp_template" as const,
  templateName: "vip_offer",
  templateLanguage: "en",
  templateCategory: "MARKETING",
  templateComponents: [{ type: "BODY", text: "Hi" }],
};

const canonicalSendResult = {
  ok: true,
  outcome: {
    disposition: "queued" as const,
    evaluatedAt: "2026-08-24T12:00:00.000Z",
    lifecycleStatus: "queued" as const,
    requestedTotal: 4,
    acceptedTotal: 1,
    queuedTotal: 1,
    uniqueRecipients: { requested: 4, accepted: 1, queued: 1 },
    skippedByReason: {
      marketing_opt_out: 1,
      prior_failure: 1,
      recipient_limit: 1,
    },
    warnings: { missingMarketingConsent: 0 },
    campaignId: "campaign-1",
    dispatchId: "dispatch-1",
    workflowId: "workflow-1",
  },
  queued: true,
  scheduled: false,
  noOp: false,
  status: "queued",
  total: 1,
  requestedTotal: 4,
  successful: 1,
  skippedRecipientCount: 3,
  skippedOptIn: 1,
  skippedPriorFailed: 1,
  skippedRecipientLimit: 1,
  campaignId: "campaign-1",
  dispatchId: "dispatch-1",
  workflowId: "workflow-1",
};

describe("enrichBulkRootNodeData", () => {
  beforeEach(() => {
    mockPostBulkCampaignSend.mockReset();
    mockPostBulkCampaignSend.mockResolvedValue(canonicalSendResult);
  });

  it("projects the connected primary action and blocks sends without one", async () => {
    const rawData: ScenarioPersistedNodeDataOfKind<"bulk"> = {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "VIP reactivation",
        recipientSourceSummary: "Manual upload",
        generationStatus: "idle",
      },
    };
    const baseContext = {
      activeScenarioId: "scenario-1",
      workspaceId: "workspace-1",
      whatsAppTemplates: [],
      callbacksRef: {
        current: {
          updateNodeById: jest.fn(),
          removeNodeById: jest.fn(),
        },
      },
      scenarioCallbacksRef: { current: {} },
      openNodePickerFromHandle: jest.fn(),
      prepareGeneratedJobRefresh: jest.fn(),
      reconcileGeneratedJobServerUpdate: jest.fn(),
      adoptGeneratedBulkServerUpdate: jest.fn(),
      t: (key: string) => key,
    };

    const connected = enrichBulkRootNodeData("bulk-1", rawData, {
      ...baseContext,
      graphIndex: {
        bulkColumnSplitRoutingByRootId: new Map(),
        bulkActionByRootId: new Map([
          [
            "bulk-1",
            {
              nodeId: "action-1",
              actionType: "whatsapp_template",
              templateName: "vip_offer",
              templateLanguage: "en",
            },
          ],
        ]),
      },
    } as never);
    const disconnected = enrichBulkRootNodeData("bulk-1", rawData, {
      ...baseContext,
      graphIndex: {
        bulkActionByRootId: new Map(),
        bulkColumnSplitRoutingByRootId: new Map(),
      },
    } as never);

    expect(connected.uiBulkConnectedAction).toMatchObject({
      nodeId: "action-1",
      actionType: "whatsapp_template",
      templateName: "vip_offer",
    });
    await expect(
      disconnected.uiOnBulkSend?.({
        recipients: [{ phone: "+10000000001" }],
      })
    ).rejects.toThrow("bulkNodeSendRequiresAction");
  });

  it("sends scenario_run_now provenance with root and action ids and never serializes recipient scenarioNodeId or category as authority", async () => {
    const updateNodeById = jest.fn();
    const rawData: ScenarioPersistedNodeDataOfKind<"bulk"> = {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "VIP reactivation",
        recipientSourceSummary: "Manual upload",
        generationStatus: "idle",
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      },
    };
    const enriched = enrichBulkRootNodeData("bulk-1", rawData, {
      ...baseContext(updateNodeById),
      graphIndex: {
        bulkColumnSplitRoutingByRootId: new Map(),
        bulkActionByRootId: new Map([["bulk-1", connectedAction]]),
      },
    } as never);

    await enriched.uiOnBulkSend?.({
      recipients: [
        {
          phone: "+10000000001",
          scenarioNodeId: "must-not-be-authority",
          templateCategory: "AUTHENTICATION",
        } as ScenarioCampaignRecipient & {
          scenarioNodeId: string;
          templateCategory: string;
        },
      ],
      recipientPolicy: {
        version: 1,
        excludePriorFailedBulkSends: true,
      },
    });

    expect(mockPostBulkCampaignSend).toHaveBeenCalledTimes(1);
    const request = mockPostBulkCampaignSend.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(request.provenance).toEqual({
      kind: "scenario_run_now",
      scenarioId: "scenario-1",
      rootNodeId: "bulk-1",
      actionNodeId: "action-1",
    });
    expect(request.recipientPolicy).toEqual({
      version: 1,
      excludePriorFailedBulkSends: true,
    });
    expect(request).not.toHaveProperty("executionSource");
    expect(request).not.toHaveProperty("scenarioNodeId");
    expect(request.templateCategory).toBeUndefined();
    const audience = request.audience as {
      kind: string;
      recipients: Array<Record<string, unknown>>;
    };
    expect(audience.kind).toBe("inline");
    expect(audience.recipients[0]).not.toHaveProperty("scenarioNodeId");
    expect(audience.recipients[0]).not.toHaveProperty("templateCategory");
  });

  it("patches sendStatus from the canonical outcome rather than flat skipped arithmetic", async () => {
    const updateNodeById = jest.fn();
    const rawData: ScenarioPersistedNodeDataOfKind<"bulk"> = {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "VIP reactivation",
        recipientSourceSummary: "Manual upload",
        generationStatus: "idle",
      },
    };
    const enriched = enrichBulkRootNodeData("bulk-1", rawData, {
      ...baseContext(updateNodeById),
      graphIndex: {
        bulkColumnSplitRoutingByRootId: new Map(),
        bulkActionByRootId: new Map([["bulk-1", connectedAction]]),
      },
    } as never);

    await enriched.uiOnBulkSend?.({
      recipients: [{ phone: "+10000000001" }],
    });

    expect(updateNodeById).toHaveBeenCalledWith(
      "bulk-1",
      expect.objectContaining({
        bulkRootConfig: expect.objectContaining({
          sendStatus: expect.objectContaining({
            total: 4,
            queued: 1,
            sent: 0,
            skipped: 3,
            failed: 0,
            campaignId: "campaign-1",
            dispatchId: "dispatch-1",
            workflowId: "workflow-1",
            lifecycleStatus: "queued",
            lastOutcome: canonicalSendResult.outcome,
          }),
        }),
      })
    );
  });

  it("does not add skippedOptIn on top of skippedRecipientCount when no canonical outcome is present", async () => {
    mockPostBulkCampaignSend.mockResolvedValue({
      skippedOptIn: 5,
      skippedRecipientCount: 3,
      requestedTotal: 4,
      total: 1,
      campaignId: "campaign-legacy",
      dispatchId: "dispatch-legacy",
    });
    const updateNodeById = jest.fn();
    const rawData: ScenarioPersistedNodeDataOfKind<"bulk"> = {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "VIP reactivation",
        recipientSourceSummary: "Manual upload",
        generationStatus: "idle",
      },
    };
    const enriched = enrichBulkRootNodeData("bulk-1", rawData, {
      ...baseContext(updateNodeById),
      graphIndex: {
        bulkColumnSplitRoutingByRootId: new Map(),
        bulkActionByRootId: new Map([["bulk-1", connectedAction]]),
      },
    } as never);

    await enriched.uiOnBulkSend?.({
      recipients: [{ phone: "+10000000001" }],
    });

    expect(updateNodeById).toHaveBeenCalledWith(
      "bulk-1",
      expect.objectContaining({
        bulkRootConfig: expect.objectContaining({
          sendStatus: expect.objectContaining({
            total: 4,
            queued: 1,
            skipped: 3,
          }),
        }),
      })
    );
    const patched = updateNodeById.mock.calls[0]?.[1] as {
      bulkRootConfig?: { sendStatus?: { lastOutcome?: unknown } };
    };
    expect(patched.bulkRootConfig?.sendStatus?.lastOutcome).toBeUndefined();
  });

  describe("scenario activation on send", () => {
    const rawData: ScenarioPersistedNodeDataOfKind<"bulk"> = {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "VIP reactivation",
        recipientSourceSummary: "Manual upload",
        generationStatus: "idle",
      },
    };

    function enrichForActivation(adoptScenarioActivation: jest.Mock) {
      const onScenarioStatusChange = jest.fn();
      const releaseScenarioSaves = jest.fn();
      const prepareScenarioBulkSend = jest
        .fn()
        .mockResolvedValue(releaseScenarioSaves);
      const ctx = {
        ...baseContext(),
        scenarioCallbacksRef: { current: { onScenarioStatusChange } },
        prepareScenarioBulkSend,
        adoptScenarioActivation,
        graphIndex: {
          bulkColumnSplitRoutingByRootId: new Map(),
          bulkActionByRootId: new Map([["bulk-1", connectedAction]]),
        },
      };
      return {
        ctx,
        onScenarioStatusChange,
        prepareScenarioBulkSend,
        releaseScenarioSaves,
        enriched: enrichBulkRootNodeData("bulk-1", rawData, ctx as never),
      };
    }

    it("adopts the activation revision for the scenario that sent the campaign", async () => {
      const adoptScenarioActivation = jest.fn().mockReturnValue(true);
      const {
        ctx,
        enriched,
        onScenarioStatusChange,
        prepareScenarioBulkSend,
        releaseScenarioSaves,
      } = enrichForActivation(adoptScenarioActivation);
      mockPostBulkCampaignSend.mockImplementation(async () => {
        // The editor moves on while the send is in flight.
        ctx.activeScenarioId = "scenario-2";
        return {
          ...canonicalSendResult,
          scenarioActivated: true,
          scenarioStatus: "active",
          scenarioUpdatedAt: "2026-09-30T12:00:00.000Z",
          previousScenarioUpdatedAt: "2026-09-30T10:00:00.000Z",
        };
      });

      await enriched.uiOnBulkSend?.({
        recipients: [{ phone: "+10000000001" }],
      });

      expect(adoptScenarioActivation).toHaveBeenCalledWith({
        scenarioId: "scenario-1",
        scenarioUpdatedAt: "2026-09-30T12:00:00.000Z",
        previousScenarioUpdatedAt: "2026-09-30T10:00:00.000Z",
      });
      expect(onScenarioStatusChange).not.toHaveBeenCalled();
      // Pending edits are saved first, and saves resume only after adoption.
      expect(prepareScenarioBulkSend.mock.invocationCallOrder[0]).toBeLessThan(
        mockPostBulkCampaignSend.mock.invocationCallOrder[0]!
      );
      expect(adoptScenarioActivation.mock.invocationCallOrder[0]).toBeLessThan(
        releaseScenarioSaves.mock.invocationCallOrder[0]!
      );
    });

    it("adopts the activation a refused send reports and still rethrows", async () => {
      const adoptScenarioActivation = jest.fn().mockReturnValue(true);
      const { enriched, releaseScenarioSaves } = enrichForActivation(
        adoptScenarioActivation
      );
      const refusal = new BulkCampaignSendError(
        "Confirm sending to this recent audience again.",
        {
          code: "bulk_campaign_recent_audience_confirmation_required",
          error: "Confirm sending to this recent audience again.",
          scenarioActivated: true,
          scenarioStatus: "active",
          scenarioUpdatedAt: "2026-09-30T12:00:00.000Z",
          previousScenarioUpdatedAt: "2026-09-30T10:00:00.000Z",
        },
        409
      );
      mockPostBulkCampaignSend.mockRejectedValue(refusal);

      await expect(
        enriched.uiOnBulkSend?.({ recipients: [{ phone: "+10000000001" }] })
      ).rejects.toBe(refusal);

      expect(adoptScenarioActivation).toHaveBeenCalledWith({
        scenarioId: "scenario-1",
        scenarioUpdatedAt: "2026-09-30T12:00:00.000Z",
        previousScenarioUpdatedAt: "2026-09-30T10:00:00.000Z",
      });
      expect(releaseScenarioSaves).toHaveBeenCalledTimes(1);
    });

    it("does not send when pending scenario edits could not be saved", async () => {
      const adoptScenarioActivation = jest.fn();
      const { enriched, prepareScenarioBulkSend } = enrichForActivation(
        adoptScenarioActivation
      );
      prepareScenarioBulkSend.mockResolvedValue(null);

      await expect(
        enriched.uiOnBulkSend?.({ recipients: [{ phone: "+10000000001" }] })
      ).rejects.toThrow("bulkNodeSaveBeforeSend");

      expect(mockPostBulkCampaignSend).not.toHaveBeenCalled();
      expect(adoptScenarioActivation).not.toHaveBeenCalled();
    });

    it("resumes scenario saves when the send fails without an activation", async () => {
      const adoptScenarioActivation = jest.fn();
      const { enriched, releaseScenarioSaves } = enrichForActivation(
        adoptScenarioActivation
      );
      mockPostBulkCampaignSend.mockRejectedValue(new TypeError("offline"));

      await expect(
        enriched.uiOnBulkSend?.({ recipients: [{ phone: "+10000000001" }] })
      ).rejects.toThrow("offline");

      expect(adoptScenarioActivation).not.toHaveBeenCalled();
      expect(releaseScenarioSaves).toHaveBeenCalledTimes(1);
    });

    it("does not fall back to a status change when the editor rejects the activation", async () => {
      const adoptScenarioActivation = jest.fn().mockReturnValue(false);
      const { enriched, onScenarioStatusChange } = enrichForActivation(
        adoptScenarioActivation
      );
      mockPostBulkCampaignSend.mockResolvedValue({
        ...canonicalSendResult,
        scenarioActivated: true,
        scenarioStatus: "active",
        scenarioUpdatedAt: "2026-09-30T12:00:00.000Z",
      });

      await enriched.uiOnBulkSend?.({
        recipients: [{ phone: "+10000000001" }],
      });

      expect(adoptScenarioActivation).toHaveBeenCalledTimes(1);
      expect(onScenarioStatusChange).not.toHaveBeenCalled();
    });

    it("marks only the sending scenario active when a legacy response has no revision", async () => {
      const adoptScenarioActivation = jest.fn();
      const { enriched, onScenarioStatusChange } = enrichForActivation(
        adoptScenarioActivation
      );
      mockPostBulkCampaignSend.mockResolvedValue({
        ...canonicalSendResult,
        scenarioActivated: true,
        scenarioStatus: "active",
      });

      await enriched.uiOnBulkSend?.({
        recipients: [{ phone: "+10000000001" }],
      });

      expect(adoptScenarioActivation).not.toHaveBeenCalled();
      expect(onScenarioStatusChange).toHaveBeenCalledWith(
        "active",
        "scenario-1"
      );
    });

    it("leaves the scenario alone when the send did not activate it", async () => {
      const adoptScenarioActivation = jest.fn();
      const { enriched, onScenarioStatusChange } = enrichForActivation(
        adoptScenarioActivation
      );

      await enriched.uiOnBulkSend?.({
        recipients: [{ phone: "+10000000001" }],
      });

      expect(adoptScenarioActivation).not.toHaveBeenCalled();
      expect(onScenarioStatusChange).not.toHaveBeenCalled();
    });
  });

  it("blocks a column-split send whose Else connects to a non-template step", async () => {
    const enriched = enrichBulkRootNodeData(
      "bulk-1",
      {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "Split campaign",
          recipientSourceSummary: "Manual upload",
          generationStatus: "idle",
          uploadedRecipients: [
            { phone: "+10000000001", fields: { city: "Almaty" } },
          ],
        },
      },
      {
        ...baseContext(),
        graphIndex: {
          bulkActionByRootId: new Map(),
          actionVariableConfigsByNodeId: new Map(),
          bulkColumnSplitRoutingByRootId: new Map([
            [
              "bulk-1",
              resolveBulkColumnSplitRouting({
                bulkRootId: "bulk-1",
                nodes: [
                  {
                    id: "bulk-1",
                    position: { x: 0, y: 0 },
                    data: { kind: "bulk" },
                  },
                  {
                    id: "split-1",
                    position: { x: 0, y: 0 },
                    data: {
                      kind: "logic",
                      logicType: "recipient_column_split",
                      recipientColumnSplit: {
                        version: 1,
                        paths: [
                          {
                            id: "almaty",
                            label: "Almaty",
                            rules: [
                              {
                                id: "r1",
                                column: "city",
                                op: "equals",
                                value: "Almaty",
                              },
                            ],
                          },
                        ],
                      },
                    },
                  },
                  {
                    id: "action-2",
                    position: { x: 0, y: 0 },
                    data: {
                      kind: "action",
                      actionType: "whatsapp_template",
                      actionWhatsAppTemplateName: "vip_offer",
                      actionWhatsAppTemplateLanguage: "en",
                      actionWhatsAppTemplateComponents: [
                        { type: "BODY", text: "Hi" },
                      ],
                    },
                  },
                  {
                    id: "reply-1",
                    position: { x: 0, y: 0 },
                    data: {
                      kind: "action",
                      actionType: "reply",
                      actionReplyText: "Hello",
                    },
                  },
                ] as never,
                edges: [
                  {
                    id: "e1",
                    source: "bulk-1",
                    target: "split-1",
                    sourceHandle: "right-source",
                  },
                  {
                    id: "e2",
                    source: "split-1",
                    target: "action-2",
                    sourceHandle: "right-source-column-split-almaty",
                  },
                  {
                    id: "e3",
                    source: "split-1",
                    target: "reply-1",
                    sourceHandle: "right-source-column-split-else",
                  },
                ] as never,
                whatsAppTemplates: [
                  { name: "vip_offer", language: "en", status: "APPROVED" },
                ],
              }),
            ],
          ]),
        },
      } as never
    );

    // No row lands on Else, but the server refuses the send for it
    // (action_message_kind_mismatch), so the preview blocks Send.
    expect(enriched.uiBulkColumnSplitPreview).toMatchObject({
      elseCount: 0,
      ready: false,
      disabledReason: "bulkNodeUploadedRequiresTemplate",
    });
    await expect(
      enriched.uiOnBulkSend?.({
        recipients: [{ phone: "+10000000001", fields: { city: "Almaty" } }],
        useColumnSplitRouting: true,
      })
    ).rejects.toThrow("bulkNodeUploadedRequiresTemplate");
    expect(mockPostBulkCampaignSend).not.toHaveBeenCalled();
  });

  function enrichForColumnSplit(updateNodeById = jest.fn()) {
    const rawData: ScenarioPersistedNodeDataOfKind<"bulk"> = {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "Split campaign",
        recipientSourceSummary: "Manual upload",
        generationStatus: "idle",
        uploadedRecipients: [{ phone: "+10000000001" }],
      },
    };

    return enrichBulkRootNodeData("bulk-1", rawData, {
      ...baseContext(updateNodeById),
      graphIndex: {
        bulkActionByRootId: new Map(),
        actionVariableConfigsByNodeId: new Map(),
        bulkColumnSplitRoutingByRootId: new Map([
          [
            "bulk-1",
            {
              splitNodeId: "split-1",
              config: {
                version: 1,
                paths: [
                  {
                    id: "almaty",
                    label: "Almaty",
                    rules: [
                      {
                        id: "r1",
                        column: "city",
                        op: "equals",
                        value: "Almaty",
                      },
                    ],
                  },
                ],
              },
              routes: [
                {
                  pathId: "almaty",
                  handleId: "almaty",
                  label: "Almaty",
                  actionNodeId: "action-2",
                  action: {
                    nodeId: "action-2",
                    actionType: "whatsapp_template",
                    templateName: "vip_offer",
                    templateLanguage: "en",
                    templateCategory: "MARKETING",
                    templateComponents: [{ type: "BODY", text: "Hi" }],
                  },
                },
              ],
              elseRoute: {
                pathId: "else",
                handleId: "else",
                label: "Else",
                actionNodeId: null,
                action: null,
              },
            },
          ],
        ]),
      },
    } as never);
  }

  it("posts a column-split send that the real client and server request parsers accept", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => canonicalSendResult,
    })) as unknown as typeof fetch;
    // Run the real client parse and serialization; only the network is stubbed.
    mockPostBulkCampaignSend.mockImplementation(request =>
      actualPostBulkCampaignSend(request, fetchImpl)
    );
    const enriched = enrichForColumnSplit();

    await expect(
      enriched.uiOnBulkSend?.({
        recipients: [
          { phone: "+10000000001", fields: { city: "Almaty" } },
          { phone: "+10000000002", fields: { city: "Astana" } },
        ],
        useColumnSplitRouting: true,
      })
    ).resolves.toMatchObject({ ok: true });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe("/api/campaigns/bulk-send");
    const posted = JSON.parse(String((init as RequestInit).body));
    // The bulk-send route parses the posted body with the same contract. Its
    // provenance check runs against this graph (Else unconnected) in
    // route.test.ts, "column split with the Else path left unconnected".
    const serverRequest = parseBulkCampaignSendRequest(posted);
    expect(serverRequest).toMatchObject({
      channel: "whatsapp",
      useColumnSplitRouting: true,
      provenance: {
        kind: "scenario_run_now",
        scenarioId: "scenario-1",
        rootNodeId: "bulk-1",
        columnSplitNodeId: "split-1",
      },
    });
    expect(serverRequest).not.toHaveProperty("templateName");
    // The unconnected Else row is skipped; the routed row names its template.
    expect(serverRequest.audience).toEqual({
      kind: "inline",
      recipients: [
        {
          phone: "+10000000001",
          fields: { city: "Almaty" },
          templateName: "vip_offer",
          languageCode: "en",
        },
      ],
    });
  });

  it("sends column-split provenance without recipient scenarioNodeId authority", async () => {
    const enriched = enrichForColumnSplit();

    await enriched.uiOnBulkSend?.({
      recipients: [
        { phone: "+10000000001", fields: { city: "Almaty" } },
      ],
      useColumnSplitRouting: true,
    });

    const request = mockPostBulkCampaignSend.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(request.provenance).toEqual({
      kind: "scenario_run_now",
      scenarioId: "scenario-1",
      rootNodeId: "bulk-1",
      columnSplitNodeId: "split-1",
    });
    expect(request).not.toHaveProperty("executionSource");
    const recipients = (request.recipients as Array<Record<string, unknown>>) ||
      (
        request.audience as {
          recipients?: Array<Record<string, unknown>>;
        }
      )?.recipients ||
      [];
    expect(recipients.every(recipient => !recipient.scenarioNodeId)).toBe(true);
  });

  describe("when template variables are missing", () => {
    const rawData: ScenarioPersistedNodeDataOfKind<"bulk"> = {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "VIP reactivation",
        recipientSourceSummary: "Manual upload",
        generationStatus: "idle",
      },
    };
    const recipients = [1, 2, 3, 4, 5].map(index => ({
      phone: `+1000000000${index}`,
      fields: { city: "Almaty" },
    }));
    const expectedMessage = [
      "bulkNodeVariableMissing:5",
      "+10000000001: {{1}}",
      "+10000000002: {{1}}",
      "+10000000003: {{1}}",
      "bulkNodeVariableMissingMore:2",
    ].join("\n");
    const countingT = (key: string, values?: { count?: number }) =>
      values?.count === undefined ? key : `${key}:${values.count}`;

    it("lists the first recipients on an uploaded send", async () => {
      const enriched = enrichBulkRootNodeData("bulk-1", rawData, {
        ...baseContext(),
        t: countingT,
        graphIndex: {
          bulkColumnSplitRoutingByRootId: new Map(),
          bulkActionByRootId: new Map([
            ["bulk-1", { ...connectedAction, templateVariables: ["1"] }],
          ]),
        },
      } as never);

      await expect(
        enriched.uiOnBulkSend?.({
          recipients,
          variableConfigs: { "1": { mode: "custom", customValue: "" } },
        })
      ).rejects.toThrow(expectedMessage);
      expect(mockPostBulkCampaignSend).not.toHaveBeenCalled();
    });

    it("lists the first recipients on a column-split send", async () => {
      const enriched = enrichBulkRootNodeData(
        "bulk-1",
        {
          ...rawData,
          bulkRootConfig: {
            ...rawData.bulkRootConfig!,
            uploadedRecipients: recipients,
          },
        },
        {
          ...baseContext(),
          t: countingT,
          graphIndex: {
            bulkActionByRootId: new Map(),
            actionVariableConfigsByNodeId: {
              "action-2": { "1": { mode: "custom", customValue: "" } },
            },
            bulkColumnSplitRoutingByRootId: new Map([
              [
                "bulk-1",
                {
                  splitNodeId: "split-1",
                  config: {
                    version: 1,
                    paths: [
                      {
                        id: "almaty",
                        label: "Almaty",
                        rules: [
                          {
                            id: "r1",
                            column: "city",
                            op: "equals",
                            value: "Almaty",
                          },
                        ],
                      },
                    ],
                  },
                  routes: [
                    {
                      pathId: "almaty",
                      handleId: "almaty",
                      label: "Almaty",
                      actionNodeId: "action-2",
                      action: {
                        ...connectedAction,
                        nodeId: "action-2",
                        templateVariables: ["1"],
                      },
                    },
                  ],
                  elseRoute: {
                    pathId: "else",
                    handleId: "else",
                    label: "Else",
                    actionNodeId: null,
                    action: null,
                  },
                },
              ],
            ]),
          },
        } as never
      );

      // The old column-split message passed these lines as an unused ICU
      // value, so the error never named a recipient.
      await expect(
        enriched.uiOnBulkSend?.({ recipients, useColumnSplitRouting: true })
      ).rejects.toThrow(expectedMessage);
      expect(mockPostBulkCampaignSend).not.toHaveBeenCalled();
    });
  });
});

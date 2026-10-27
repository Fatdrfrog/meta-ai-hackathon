import {
  MAX_RECIPIENT_COLUMN_SPLIT_PATHS,
  RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID,
  buildRecipientColumnSplitPathHandleId,
} from "@icecore/scenario-contracts";
import type { WhatsAppTemplate } from "@icecore/shared/types/whatsapp";
import {
  WhatsAppTemplateCatalogError,
  type WhatsAppTemplateCatalogMetadata,
} from "@/lib/whatsapp/templates/catalog-contracts";
import { parseBulkCampaignSendRequest } from "./bulk-campaign-contracts";
import {
  routeVerifiedBulkCampaignScenarioScheduleProvenance,
  routeVerifiedBulkCampaignProvenance,
  routeVerifiedGeneratedBulkCampaignProvenance,
  readVerifiedBulkCampaignScenarioScheduleContext,
  verifyBulkCampaignProvenance,
  verifyBulkCampaignProvenanceCapability,
  verifyGeneratedBulkCampaignProvenanceCapability,
  verifyBulkCampaignScenarioScheduleCapability,
  verifyBulkCampaignScenarioScheduleProvenance,
  type VerifyBulkCampaignProvenanceDependencies,
  type VerifyBulkCampaignProvenanceInput,
} from "./bulk-campaign-provenance";

const workspaceId = "workspace-1";
const scenarioId = "scenario-1";
const rootNodeId = "bulk-root";
const actionNodeId = "marketing-action";

type ScenarioFixture = {
  _id: unknown;
  workspaceId: string;
  mode: string;
  deletedAt: string | null;
  nodes: unknown;
  edges: unknown;
};

const promoTemplate: WhatsAppTemplate = {
  id: "template-promo",
  name: "promo",
  language: "en_US",
  status: "APPROVED",
  category: "MARKETING",
  components: [{ type: "BODY", text: "Provider promo" }],
};

const receiptTemplate: WhatsAppTemplate = {
  id: "template-receipt",
  name: "receipt",
  language: "en_US",
  status: "APPROVED",
  category: "UTILITY",
  components: [{ type: "BODY", text: "Provider receipt" }],
};

function bulkRoot(id = rootNodeId, overrides: Record<string, unknown> = {}) {
  return {
    id,
    data: {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        channels: ["whatsapp"],
        sourceIds: ["source-1"],
      },
      ...overrides,
    },
  };
}

function whatsappAction(
  id = actionNodeId,
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    data: {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: id === "utility-action" ? "receipt" : "promo",
      actionWhatsAppTemplateLanguage: "en-US",
      actionWhatsAppTemplateCategory:
        id === "utility-action" ? "UTILITY" : "MARKETING",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Untrusted stored preview" },
      ],
      ...overrides,
    },
  };
}

function directScenario(
  overrides: Partial<ScenarioFixture> = {}
): ScenarioFixture {
  return {
    _id: scenarioId,
    workspaceId,
    mode: "bulk_campaign",
    deletedAt: null,
    nodes: [bulkRoot(), whatsappAction()],
    edges: [
      {
        source: rootNodeId,
        sourceHandle: "right-source",
        target: actionNodeId,
      },
    ],
    ...overrides,
  };
}

function splitScenario(params?: {
  pathCount?: number;
  omitElse?: boolean;
  splitNodeId?: string;
}): ScenarioFixture {
  const splitNodeId = params?.splitNodeId ?? "column-split";
  const pathCount = params?.pathCount ?? 2;
  const paths = Array.from({ length: pathCount }, (_, index) => ({
    id: index === 0 ? "marketing" : index === 1 ? "utility" : `path_${index}`,
    rules: [
      {
        id: `rule_${index}`,
        column: "tier",
        op: "equals",
        value: index === 0 ? "gold" : index === 1 ? "silver" : String(index),
      },
    ],
  }));
  const routeEdges = paths.map((path, index) => ({
    source: splitNodeId,
    sourceHandle: buildRecipientColumnSplitPathHandleId(path.id),
    target: index === 1 ? "utility-action" : actionNodeId,
  }));

  return directScenario({
    nodes: [
      bulkRoot(),
      {
        id: splitNodeId,
        data: {
          kind: "logic",
          logicType: "recipient_column_split",
          recipientColumnSplit: { version: 1, paths },
        },
      },
      whatsappAction(),
      whatsappAction("utility-action"),
    ],
    edges: [
      {
        source: rootNodeId,
        sourceHandle: "right-source",
        target: splitNodeId,
      },
      ...routeEdges,
      ...(params?.omitElse
        ? []
        : [
            {
              source: splitNodeId,
              sourceHandle: RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID,
              target: "utility-action",
            },
          ]),
    ],
  });
}

function request(
  overrides: Partial<VerifyBulkCampaignProvenanceInput> = {}
): VerifyBulkCampaignProvenanceInput {
  return {
    workspaceId,
    intent: {
      kind: "scenario_run_now",
      scenarioId,
      rootNodeId,
      actionNodeId,
    },
    channel: "whatsapp",
    recipients: [
      {
        stableId: "row-1",
        recipient: { phone: "+15550000001", sourceId: "source-1" },
      },
    ],
    messageIntent: {
      kind: "whatsapp_template",
      sourceId: "source-1",
      templateName: "promo",
      language: "en-US",
    },
    ...overrides,
  };
}

function dependenciesFor(
  scenario: ScenarioFixture | null,
  templates: WhatsAppTemplate[] = [promoTemplate, receiptTemplate]
): VerifyBulkCampaignProvenanceDependencies {
  return {
    findScenario: jest.fn(async () => scenario),
    listApprovedWhatsAppTemplatesForSend: jest.fn(async () => templates),
  };
}

function dependenciesForSources(
  scenario: ScenarioFixture,
  templatesBySourceId: Record<string, WhatsAppTemplate[]>
): VerifyBulkCampaignProvenanceDependencies {
  return {
    findScenario: jest.fn(async () => scenario),
    listApprovedWhatsAppTemplatesForSend: jest.fn(
      async (_workspaceId, options) =>
        templatesBySourceId[options.sourceId] ?? []
    ),
  };
}

function expectInvalid(promise: Promise<unknown>) {
  return expect(promise).rejects.toMatchObject({
    code: "bulk_campaign_provenance_invalid",
  });
}

const conversationTemplateBindings = {
  version: 1,
  parameters: { "body:1": { source: "context", key: "first_name" } },
};

const conversationTemplateBindingsError = {
  code: "bulk_campaign_provenance_invalid",
  reason: "template_bindings_require_conversation",
  message: expect.stringContaining("campaign recipient mappings"),
};

function expectInvalidCall(call: () => unknown): void {
  try {
    call();
    throw new Error("expected provenance call to reject");
  } catch (error) {
    expect(error).toMatchObject({ code: "bulk_campaign_provenance_invalid" });
  }
}

describe("verifyBulkCampaignProvenance", () => {
  it("returns an empty verified route set for ad hoc provenance", async () => {
    const deps = dependenciesFor(null);
    const verified = await verifyBulkCampaignProvenance(
      request({ intent: { kind: "ad_hoc" } }),
      deps
    );

    expect(verified).toMatchObject({ kind: "ad_hoc", routes: [] });
    expect(deps.findScenario).not.toHaveBeenCalled();
    expect(deps.listApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
  });

  it.each([conversationTemplateBindings, null])(
    "rejects present conversation template bindings on a bulk primary action",
    async actionWhatsAppTemplateBindings => {
      const deps = dependenciesFor(
        directScenario({
          nodes: [
            bulkRoot(),
            whatsappAction(actionNodeId, { actionWhatsAppTemplateBindings }),
          ],
        })
      );
      await expect(
        verifyBulkCampaignProvenance(request(), deps)
      ).rejects.toMatchObject(conversationTemplateBindingsError);
      expect(deps.listApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
    }
  );

  it("rejects conversation bindings on a split primary even when another route is selected", async () => {
    const scenario = splitScenario();
    scenario.nodes = (
      scenario.nodes as ReturnType<typeof whatsappAction>[]
    ).map(node =>
      node.id === "utility-action"
        ? whatsappAction("utility-action", {
            actionWhatsAppTemplateBindings: conversationTemplateBindings,
          })
        : node
    );
    await expect(
      verifyBulkCampaignProvenance(
        request({
          intent: {
            kind: "scenario_run_now",
            scenarioId,
            rootNodeId,
            columnSplitNodeId: "column-split",
          },
          recipients: [
            {
              stableId: "row-1",
              recipient: {
                phone: "+15550000001",
                sourceId: "source-1",
                fields: { tier: "gold" },
              },
            },
          ],
        }),
        dependenciesFor(scenario)
      )
    ).rejects.toMatchObject(conversationTemplateBindingsError);
  });

  it("rejects conversation bindings on a scheduled primary action", async () => {
    await expect(
      verifyBulkCampaignScenarioScheduleProvenance(
        {
          workspaceId,
          scenarioId,
          rootNodeId,
          actionNodeId,
          channel: "whatsapp",
          recipients: request().recipients,
          messageIntent: request().messageIntent,
        },
        dependenciesFor(
          directScenario({
            nodes: [
              bulkRoot(),
              whatsappAction(actionNodeId, {
                actionWhatsAppTemplateBindings: conversationTemplateBindings,
              }),
            ],
          })
        )
      )
    ).rejects.toMatchObject(conversationTemplateBindingsError);
  });

  it("preserves conversation bindings on follow-up actions after the bulk primary", async () => {
    const scenario = directScenario();
    scenario.nodes = [
      bulkRoot(),
      whatsappAction(),
      whatsappAction("follow-up", {
        actionWhatsAppTemplateBindings: conversationTemplateBindings,
      }),
    ];
    scenario.edges = [
      ...(scenario.edges as {
        source: string;
        target: string;
        sourceHandle: string;
      }[]),
      {
        source: actionNodeId,
        target: "follow-up",
        sourceHandle: "right-source",
      },
    ];
    await expect(
      verifyBulkCampaignProvenance(request(), dependenciesFor(scenario))
    ).resolves.toMatchObject({ routes: [{ actionNodeId }] });
  });

  it("rejects conversation bindings when routing a generated bulk primary", async () => {
    const deps = dependenciesFor(
      directScenario({
        nodes: [
          bulkRoot(rootNodeId, {
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              sendMode: "immediate",
              channels: ["whatsapp"],
              sourceIds: ["source-1"],
              generationJobId: "revision-1",
              cohorts: [
                { id: "cohort-a", branchId: "cohort-a", label: "A", count: 1 },
              ],
            },
          }),
          whatsappAction(actionNodeId, {
            bulkRecipientBranchId: "cohort-a",
            actionWhatsAppTemplateBindings: conversationTemplateBindings,
          }),
        ],
      })
    );
    const capability = await verifyGeneratedBulkCampaignProvenanceCapability(
      {
        workspaceId,
        scenarioId,
        rootNodeId,
        audienceRevision: "revision-1",
      },
      deps
    );
    await expect(
      routeVerifiedGeneratedBulkCampaignProvenance(capability, [
        {
          stableId: "row-1",
          nodeId: actionNodeId,
          branchId: "cohort-a",
          channel: "whatsapp",
          sourceId: "source-1",
          recipient: { phone: "+15550000001", sourceId: "source-1" },
        },
      ])
    ).rejects.toMatchObject(conversationTemplateBindingsError);
  });

  it.each([
    ["missing scenario", null],
    ["foreign workspace", directScenario({ workspaceId: "workspace-2" })],
    ["deleted scenario", directScenario({ deletedAt: "2026-08-21" })],
    [
      "conversation scenario without a bulk root",
      directScenario({
        mode: "conversation",
        nodes: [
          { id: rootNodeId, data: { kind: "trigger" } },
          whatsappAction(),
        ],
      }),
    ],
    [
      "non-bulk root",
      directScenario({
        nodes: [
          { id: rootNodeId, data: { kind: "trigger" } },
          whatsappAction(),
        ],
      }),
    ],
    [
      "unreachable action",
      directScenario({
        edges: [
          {
            source: rootNodeId,
            sourceHandle: "right-source",
            target: "other-action",
          },
        ],
      }),
    ],
    [
      "wrong action message kind",
      directScenario({
        nodes: [
          bulkRoot(),
          whatsappAction(actionNodeId, {
            actionType: "reply",
            actionWhatsAppTemplateName: undefined,
            actionWhatsAppServiceMessage: { message: { type: "text" } },
          }),
        ],
      }),
    ],
  ])("rejects %s provenance", async (_label, scenario) => {
    await expectInvalid(
      verifyBulkCampaignProvenance(request(), dependenciesFor(scenario))
    );
  });

  it("sends a builder campaign from a conversation scenario whose bulk root stores no sources", async () => {
    // Production shape: the builder saves bulk roots in conversation mode,
    // never writes sourceIds, and continues with session-message steps.
    const builderScenario = directScenario({
      mode: "conversation",
      nodes: [
        bulkRoot(rootNodeId, {
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            sendMode: "immediate",
            channels: ["whatsapp"],
          },
        }),
        whatsappAction(),
        {
          id: "follow-up-reply",
          data: {
            kind: "action",
            actionType: "reply",
            actionWhatsAppServiceMessage: {
              version: 1,
              message: { kind: "text", body: { mode: "fixed", text: "Hi" } },
            },
          },
        },
      ],
      edges: [
        {
          source: rootNodeId,
          sourceHandle: "right-source",
          target: actionNodeId,
        },
        {
          source: actionNodeId,
          sourceHandle: "right-source",
          target: "follow-up-reply",
        },
      ],
    });
    const deps = dependenciesFor(builderScenario);

    const verified = await verifyBulkCampaignProvenance(
      request({
        recipients: [
          { stableId: "row-1", recipient: { phone: "+15550000001" } },
          { stableId: "row-2", recipient: { phone: "+15550000002" } },
        ],
      }),
      deps
    );

    expect(deps.listApprovedWhatsAppTemplatesForSend).toHaveBeenCalledTimes(1);
    expect(deps.listApprovedWhatsAppTemplatesForSend).toHaveBeenCalledWith(
      workspaceId,
      { sourceId: "source-1" }
    );
    expect(verified).toMatchObject({
      kind: "scenario_run_now",
      scenarioId,
      rootNodeId,
    });
    expect(verified.routes).toEqual([
      expect.objectContaining({
        recipientStableId: "row-1",
        actionNodeId,
        sourceId: "source-1",
        template: expect.objectContaining({ name: "promo" }),
      }),
      expect.objectContaining({
        recipientStableId: "row-2",
        actionNodeId,
        sourceId: "source-1",
        template: expect.objectContaining({ name: "promo" }),
      }),
    ]);
  });

  it("keeps configured root sources authoritative over the requested source", async () => {
    const deps = dependenciesFor(directScenario({ mode: "conversation" }));
    await expect(
      verifyBulkCampaignProvenance(
        request({
          messageIntent: {
            kind: "whatsapp_template",
            sourceId: "source-2",
            templateName: "promo",
            language: "en-US",
          },
          recipients: [
            { stableId: "row-1", recipient: { phone: "+15550000001" } },
          ],
        }),
        deps
      )
    ).rejects.toMatchObject({ reason: "whatsapp_source_mismatch" });
    expect(deps.listApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
  });

  it("still requires an unambiguous source when a root stores none and none is requested", async () => {
    const deps = dependenciesFor(
      directScenario({
        mode: "conversation",
        nodes: [
          bulkRoot(rootNodeId, {
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              channels: ["whatsapp"],
            },
          }),
          whatsappAction(),
        ],
      })
    );
    await expect(
      verifyBulkCampaignProvenance(
        request({
          messageIntent: {
            kind: "whatsapp_template",
            sourceId: "",
            templateName: "promo",
            language: "en-US",
          },
          recipients: [
            { stableId: "row-1", recipient: { phone: "+15550000001" } },
          ],
        }),
        deps
      )
    ).rejects.toMatchObject({ reason: "whatsapp_source_ambiguous" });
    expect(deps.listApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
  });

  it("rejects ownership and graph failures in the capability phase before catalog or audience work", async () => {
    const deps = dependenciesFor(
      directScenario({ workspaceId: "workspace-2" })
    );

    await expectInvalid(
      verifyBulkCampaignProvenanceCapability(
        {
          workspaceId,
          intent: request().intent,
          channel: "whatsapp",
          messageIntent: request().messageIntent,
        },
        deps
      )
    );
    expect(deps.listApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
  });

  it("composes the capability and routing phases without repeating lookups", async () => {
    const deps = dependenciesFor(directScenario());
    const capability = await verifyBulkCampaignProvenanceCapability(
      {
        workspaceId,
        intent: request().intent,
        channel: "whatsapp",
        messageIntent: request().messageIntent,
      },
      deps
    );
    const verified = routeVerifiedBulkCampaignProvenance(
      capability,
      request().recipients
    );

    expect(verified.routes[0]).toMatchObject({
      recipientStableId: "row-1",
      actionNodeId,
      sourceId: "source-1",
      template: {
        name: "promo",
        language: "en_us",
        category: "MARKETING",
        components: [{ type: "BODY", text: "Provider promo" }],
      },
    });
    expect(deps.findScenario).toHaveBeenCalledTimes(1);
    expect(deps.listApprovedWhatsAppTemplatesForSend).toHaveBeenCalledTimes(1);

    const replayed = routeVerifiedBulkCampaignProvenance(
      capability,
      request().recipients
    );
    expect(replayed.routes).toEqual(verified.routes);
    expect(deps.findScenario).toHaveBeenCalledTimes(1);
    expect(deps.listApprovedWhatsAppTemplatesForSend).toHaveBeenCalledTimes(1);

    if (verified.routes[0]?.template) {
      verified.routes[0].template.components[0] = {
        type: "BODY",
        text: "caller mutation",
      };
    }
    expect(
      routeVerifiedBulkCampaignProvenance(capability, request().recipients)
        .routes[0]?.template?.components[0]
    ).toEqual({ type: "BODY", text: "Provider promo" });
  });

  it("rejects forged, copied, and serialized capability tokens", async () => {
    const capability = await verifyBulkCampaignProvenanceCapability(
      {
        workspaceId,
        intent: request().intent,
        channel: "whatsapp",
        messageIntent: request().messageIntent,
      },
      dependenciesFor(directScenario())
    );

    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.keys(capability)).toEqual([]);
    expectInvalidCall(() =>
      routeVerifiedBulkCampaignProvenance(
        { ...capability } as never,
        request().recipients
      )
    );
    expectInvalidCall(() =>
      routeVerifiedBulkCampaignProvenance(
        structuredClone(capability) as never,
        request().recipients
      )
    );
    expectInvalidCall(() =>
      routeVerifiedBulkCampaignProvenance({} as never, request().recipients)
    );
  });

  it("rejects a capability token from a stale module instance", async () => {
    const capability = await verifyBulkCampaignProvenanceCapability(
      {
        workspaceId,
        intent: request().intent,
        channel: "whatsapp",
        messageIntent: request().messageIntent,
      },
      dependenciesFor(directScenario())
    );
    let reloadedRoute: typeof routeVerifiedBulkCampaignProvenance | undefined;
    jest.isolateModules(() => {
      reloadedRoute = jest.requireActual<
        typeof import("./bulk-campaign-provenance")
      >("./bulk-campaign-provenance").routeVerifiedBulkCampaignProvenance;
    });

    expectInvalidCall(() => reloadedRoute!(capability, request().recipients));
  });

  it("keeps channel and provenance kind in private state despite mutation attempts", async () => {
    const capability = await verifyBulkCampaignProvenanceCapability(
      {
        workspaceId,
        intent: request().intent,
        channel: "whatsapp",
        messageIntent: request().messageIntent,
      },
      dependenciesFor(directScenario())
    );

    expect(Reflect.set(capability as object, "channel", "email")).toBe(false);
    expect(Reflect.set(capability as object, "kind", "scenario_schedule")).toBe(
      false
    );
    const verified = routeVerifiedBulkCampaignProvenance(
      capability,
      request().recipients
    );
    expect(verified.kind).toBe("scenario_run_now");
    expect(verified.routes[0]?.channel).toBe("whatsapp");

    expectInvalidCall(() =>
      routeVerifiedBulkCampaignScenarioScheduleProvenance(
        capability as never,
        request().recipients
      )
    );
  });

  it("accepts a lean Mongoose ObjectId as the persisted scenario identity", async () => {
    const verified = await verifyBulkCampaignProvenance(
      request(),
      dependenciesFor(
        directScenario({
          _id: { toString: () => scenarioId },
        })
      )
    );

    expect(verified.scenarioId).toBe(scenarioId);
  });

  it("derives mixed-category action and provider template data per recipient from the stored split", async () => {
    const deps = dependenciesFor(splitScenario());
    const verified = await verifyBulkCampaignProvenance(
      request({
        intent: {
          kind: "scenario_run_now",
          scenarioId,
          rootNodeId,
          columnSplitNodeId: "column-split",
        },
        recipients: [
          {
            stableId: "row-1",
            recipient: {
              phone: "+15550000001",
              sourceId: "source-1",
              fields: { tier: "gold" },
              scenarioNodeId: "browser-claimed-action",
              templateCategory: "MARKETING",
            } as never,
          },
          {
            stableId: "row-2",
            recipient: {
              phone: "+15550000002",
              sourceId: "source-1",
              fields: { tier: "silver" },
              scenarioNodeId: "browser-claimed-action",
              templateCategory: "UTILITY",
            } as never,
          },
        ],
      }),
      deps
    );

    expect(
      verified.routes.map(item => ({
        recipientStableId: item.recipientStableId,
        actionNodeId: item.actionNodeId,
        templateName: item.template?.name,
        templateCategory: item.template?.category,
      }))
    ).toEqual([
      {
        recipientStableId: "row-1",
        actionNodeId: "marketing-action",
        templateName: "promo",
        templateCategory: "MARKETING",
      },
      {
        recipientStableId: "row-2",
        actionNodeId: "utility-action",
        templateName: "receipt",
        templateCategory: "UTILITY",
      },
    ]);
    expect(deps.listApprovedWhatsAppTemplatesForSend).toHaveBeenCalledTimes(1);
    expect(deps.listApprovedWhatsAppTemplatesForSend).toHaveBeenCalledWith(
      workspaceId,
      { sourceId: "source-1" }
    );
  });

  it("blocks an untrusted first-recipient compatibility hint that conflicts with the verified split route", async () => {
    const capability = await verifyBulkCampaignProvenanceCapability(
      {
        workspaceId,
        intent: {
          kind: "scenario_run_now",
          scenarioId,
          rootNodeId,
          columnSplitNodeId: "column-split",
        },
        channel: "whatsapp",
        messageIntent: {
          kind: "whatsapp_template",
          sourceId: "source-1",
          templateName: "promo",
          language: "en-US",
        },
      },
      dependenciesFor(splitScenario())
    );

    expectInvalidCall(() =>
      routeVerifiedBulkCampaignProvenance(capability, [
        {
          stableId: "first-inline-row",
          recipient: {
            phone: "+15550000002",
            sourceId: "source-1",
            fields: { tier: "silver" },
            templateName: "promo",
            languageCode: "en-US",
          } as never,
        },
      ])
    );
  });

  it("derives the unique connected split when canonical columnSplitNodeId is omitted", async () => {
    const verified = await verifyBulkCampaignProvenance(
      request({
        intent: { kind: "scenario_run_now", scenarioId, rootNodeId },
        recipients: [
          {
            stableId: "row-1",
            recipient: {
              phone: "+15550000001",
              sourceId: "source-1",
              fields: { tier: "gold" },
            },
          },
        ],
      }),
      dependenciesFor(splitScenario())
    );

    expect(verified).toMatchObject({
      columnSplitNodeId: "column-split",
      routes: [{ actionNodeId: "marketing-action" }],
    });
  });

  it("rejects an unrelated split and a row routed to a missing Else route", async () => {
    await expectInvalid(
      verifyBulkCampaignProvenance(
        request({
          intent: {
            kind: "scenario_run_now",
            scenarioId,
            rootNodeId,
            columnSplitNodeId: "unrelated-split",
          },
        }),
        dependenciesFor(splitScenario())
      )
    );
    // row-1 has no tier, so it lands on Else, which has no connected action.
    await expect(
      verifyBulkCampaignProvenance(
        request({
          intent: {
            kind: "scenario_run_now",
            scenarioId,
            rootNodeId,
            columnSplitNodeId: "column-split",
          },
        }),
        dependenciesFor(splitScenario({ omitElse: true }))
      )
    ).rejects.toMatchObject({
      code: "bulk_campaign_provenance_invalid",
      reason: "recipient_route_missing",
    });
  });

  it("accepts an unconnected Else when every row routes to a connected path", async () => {
    // The editor offers "leave empty to skip send" for Else, and the scenario
    // bulk node drops the rows that would land there before posting.
    const verified = await verifyBulkCampaignProvenance(
      request({
        intent: {
          kind: "scenario_run_now",
          scenarioId,
          rootNodeId,
          columnSplitNodeId: "column-split",
        },
        recipients: [
          {
            stableId: "row-gold",
            recipient: {
              phone: "+15550000001",
              sourceId: "source-1",
              fields: { tier: "gold" },
            },
          },
          {
            stableId: "row-silver",
            recipient: {
              phone: "+15550000002",
              sourceId: "source-1",
              fields: { tier: "silver" },
            },
          },
        ],
      }),
      dependenciesFor(splitScenario({ omitElse: true }))
    );

    expect(verified).toMatchObject({
      columnSplitNodeId: "column-split",
      routes: [
        { recipientStableId: "row-gold", actionNodeId: "marketing-action" },
        { recipientStableId: "row-silver", actionNodeId: "utility-action" },
      ],
    });
  });

  it("accepts an unconnected path and rejects only rows that land on it", async () => {
    const scenario = splitScenario();
    scenario.edges = (
      scenario.edges as Array<{ sourceHandle?: string }>
    ).filter(
      edge =>
        edge.sourceHandle !== buildRecipientColumnSplitPathHandleId("utility")
    );
    const capability = await verifyBulkCampaignProvenanceCapability(
      {
        workspaceId,
        intent: {
          kind: "scenario_run_now",
          scenarioId,
          rootNodeId,
          columnSplitNodeId: "column-split",
        },
        channel: "whatsapp",
        messageIntent: request().messageIntent,
      },
      dependenciesFor(scenario)
    );

    expect(
      routeVerifiedBulkCampaignProvenance(capability, [
        {
          stableId: "row-gold",
          recipient: { phone: "+15550000001", fields: { tier: "gold" } },
        },
        {
          stableId: "row-else",
          recipient: { phone: "+15550000003", fields: { tier: "bronze" } },
        },
      ]).routes.map(route => route.actionNodeId)
    ).toEqual(["marketing-action", "utility-action"]);
    expect(() =>
      routeVerifiedBulkCampaignProvenance(capability, [
        {
          stableId: "row-silver",
          recipient: { phone: "+15550000002", fields: { tier: "silver" } },
        },
      ])
    ).toThrow(
      expect.objectContaining({
        code: "bulk_campaign_provenance_invalid",
        reason: "recipient_route_missing",
      })
    );
  });

  it("rejects a split with no connected path or Else before catalog work", async () => {
    const scenario = splitScenario({ omitElse: true });
    scenario.edges = (scenario.edges as Array<{ source: string }>).filter(
      edge => edge.source !== "column-split"
    );
    const deps = dependenciesFor(scenario);

    await expect(
      verifyBulkCampaignProvenance(
        request({
          intent: {
            kind: "scenario_run_now",
            scenarioId,
            rootNodeId,
            columnSplitNodeId: "column-split",
          },
        }),
        deps
      )
    ).rejects.toMatchObject({
      code: "bulk_campaign_provenance_invalid",
      reason: "column_split_routes_missing",
    });
    expect(deps.listApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
  });

  it("rejects a follow-up workflow root for bulk campaign provenance", async () => {
    const scenario = directScenario({
      nodes: [
        bulkRoot(rootNodeId, {
          bulkRootConfig: {
            workflowKind: "follow_up_workflow",
            channels: ["whatsapp"],
            sourceIds: ["source-1"],
          },
        }),
        whatsappAction(),
      ],
    });

    await expectInvalid(
      verifyBulkCampaignProvenance(request(), dependenciesFor(scenario))
    );
  });

  it("rejects duplicate or ambiguous root and split edges", async () => {
    const duplicateRoot = directScenario();
    duplicateRoot.edges = [
      ...((duplicateRoot.edges as unknown[]) ?? []),
      {
        source: rootNodeId,
        sourceHandle: "right-source",
        target: actionNodeId,
      },
    ];
    await expectInvalid(
      verifyBulkCampaignProvenance(request(), dependenciesFor(duplicateRoot))
    );

    const duplicateSplit = splitScenario();
    duplicateSplit.edges = [
      ...((duplicateSplit.edges as unknown[]) ?? []),
      {
        source: "column-split",
        sourceHandle: buildRecipientColumnSplitPathHandleId("marketing"),
        target: "utility-action",
      },
    ];
    await expect(
      verifyBulkCampaignProvenance(
        request({
          intent: {
            kind: "scenario_run_now",
            scenarioId,
            rootNodeId,
            columnSplitNodeId: "column-split",
          },
        }),
        dependenciesFor(duplicateSplit)
      )
    ).rejects.toMatchObject({
      code: "bulk_campaign_provenance_invalid",
      reason: "column_split_route_ambiguous",
    });
  });

  it("rejects raw 21 paths before any provider call and accepts 20", async () => {
    const overLimitDeps = dependenciesFor(
      splitScenario({ pathCount: MAX_RECIPIENT_COLUMN_SPLIT_PATHS + 1 })
    );
    const splitRequest = request({
      intent: {
        kind: "scenario_run_now",
        scenarioId,
        rootNodeId,
        columnSplitNodeId: "column-split",
      },
    });
    await expectInvalid(
      verifyBulkCampaignProvenance(splitRequest, overLimitDeps)
    );
    expect(
      overLimitDeps.listApprovedWhatsAppTemplatesForSend
    ).not.toHaveBeenCalled();

    const atLimitDeps = dependenciesFor(
      splitScenario({ pathCount: MAX_RECIPIENT_COLUMN_SPLIT_PATHS })
    );
    const verified = await verifyBulkCampaignProvenance(
      splitRequest,
      atLimitDeps
    );
    expect(verified.routes).toHaveLength(1);
    expect(
      atLimitDeps.listApprovedWhatsAppTemplatesForSend
    ).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate approved catalog keys", async () => {
    const duplicate = { ...promoTemplate, id: "template-promo-duplicate" };
    await expectInvalid(
      verifyBulkCampaignProvenance(
        request(),
        dependenciesFor(directScenario(), [promoTemplate, duplicate])
      )
    );
  });

  it("rejects an unapproved template and a stored category conflict", async () => {
    await expectInvalid(
      verifyBulkCampaignProvenance(
        request(),
        dependenciesFor(directScenario(), [
          { ...promoTemplate, status: "PENDING" },
        ])
      )
    );
    await expectInvalid(
      verifyBulkCampaignProvenance(
        request(),
        dependenciesFor(
          directScenario({
            nodes: [
              bulkRoot(),
              whatsappAction(actionNodeId, {
                actionWhatsAppTemplateCategory: "UTILITY",
              }),
            ],
          })
        )
      )
    );
  });

  describe("a stale saved template catalog", () => {
    function catalog(
      overrides: Partial<WhatsAppTemplateCatalogMetadata> = {}
    ): WhatsAppTemplateCatalogMetadata {
      return {
        source: "cache",
        stale: true,
        fetchedAt: "2026-10-07T08:00:00.000Z",
        wabaId: "waba-1",
        refreshOutcome: "cooldown",
        retryAt: "2026-10-07T10:00:00.000Z",
        providerCode: 80008,
        ...overrides,
      };
    }

    // What the shared catalog returns instead of throwing while it can't
    // refresh: the last saved templates, marked stale.
    function readingDependencies(
      templates: WhatsAppTemplate[],
      metadata: WhatsAppTemplateCatalogMetadata
    ) {
      return {
        ...dependenciesFor(directScenario(), templates),
        readApprovedWhatsAppTemplatesForSend: jest.fn(async () => ({
          templates,
          catalog: metadata,
        })),
      };
    }

    it("fails the lookup for a template it misses during a Meta cooldown", async () => {
      const deps = readingDependencies([receiptTemplate], catalog());

      const error = await verifyBulkCampaignProvenance(request(), deps).catch(
        (caught: unknown) => caught
      );

      expect(error).toMatchObject({
        code: "bulk_campaign_provenance_invalid",
        reason: "lookup_failed",
      });
      const cause = (error as Error).cause;
      expect(cause).toBeInstanceOf(WhatsAppTemplateCatalogError);
      expect(cause).toMatchObject({
        code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
        retryAt: "2026-10-07T10:00:00.000Z",
        providerCode: 80008,
      });
      expect(deps.readApprovedWhatsAppTemplatesForSend).toHaveBeenCalledWith(
        workspaceId,
        { sourceId: "source-1" }
      );
      expect(deps.listApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
    });

    it("still calls a template missing from a current catalog unapproved", async () => {
      const deps = readingDependencies(
        [receiptTemplate],
        catalog({
          stale: false,
          refreshOutcome: "fresh",
          retryAt: null,
          providerCode: undefined,
        })
      );

      await expect(
        verifyBulkCampaignProvenance(request(), deps)
      ).rejects.toMatchObject({ reason: "approved_template_missing" });
    });

    it("verifies a template the stale catalog lists as approved", async () => {
      const deps = readingDependencies(
        [promoTemplate, receiptTemplate],
        catalog()
      );

      await expect(
        verifyBulkCampaignProvenance(request(), deps)
      ).resolves.toMatchObject({ kind: "scenario_run_now", scenarioId });
    });
  });

  it("uses a root source fallback only when it is unambiguous", async () => {
    const fallbackRequest = request({
      messageIntent: {
        kind: "whatsapp_template",
        sourceId: "",
        templateName: "promo",
        language: "en-US",
      },
      recipients: [{ stableId: "row-1", recipient: { phone: "+15550000001" } }],
    });
    const verified = await verifyBulkCampaignProvenance(
      fallbackRequest,
      dependenciesFor(directScenario())
    );
    expect(verified.routes[0]?.sourceId).toBe("source-1");

    const ambiguousRoot = directScenario({
      nodes: [
        bulkRoot(rootNodeId, {
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            channels: ["whatsapp"],
            sourceIds: ["source-1", "source-2"],
          },
        }),
        whatsappAction(),
      ],
    });
    const deps = dependenciesFor(ambiguousRoot);
    await expectInvalid(verifyBulkCampaignProvenance(fallbackRequest, deps));
    expect(deps.listApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
  });

  it("rejects source, template, and category conflicts", async () => {
    await expectInvalid(
      verifyBulkCampaignProvenance(
        request({
          messageIntent: {
            kind: "whatsapp_template",
            sourceId: "source-2",
            templateName: "promo",
            language: "en-US",
          },
        }),
        dependenciesFor(directScenario())
      )
    );
    await expectInvalid(
      verifyBulkCampaignProvenance(
        request({
          messageIntent: {
            kind: "whatsapp_template",
            sourceId: "source-1",
            templateName: "receipt",
            language: "en-US",
          },
        }),
        dependenciesFor(directScenario())
      )
    );
    await expectInvalid(
      verifyBulkCampaignProvenance(
        request({
          recipients: [
            {
              stableId: "row-1",
              recipient: {
                phone: "+15550000001",
                sourceId: "source-1",
                templateCategory: "UTILITY",
              } as never,
            },
          ],
        }),
        dependenciesFor(directScenario())
      )
    );
  });

  it("requires a unique connected action when canonical actionNodeId is omitted", async () => {
    const single = await verifyBulkCampaignProvenance(
      request({
        intent: { kind: "scenario_run_now", scenarioId, rootNodeId },
      }),
      dependenciesFor(directScenario())
    );
    expect(single.routes[0]?.actionNodeId).toBe(actionNodeId);

    const ambiguous = directScenario({
      nodes: [bulkRoot(), whatsappAction(), whatsappAction("second-action")],
      edges: [
        {
          source: rootNodeId,
          sourceHandle: "right-source",
          target: actionNodeId,
        },
        {
          source: rootNodeId,
          sourceHandle: "right-source",
          target: "second-action",
        },
      ],
    });
    await expectInvalid(
      verifyBulkCampaignProvenance(
        request({
          intent: { kind: "scenario_run_now", scenarioId, rootNodeId },
        }),
        dependenciesFor(ambiguous)
      )
    );
  });

  it("derives exactly one legacy root and never persists claimedNodeId", async () => {
    const verified = await verifyBulkCampaignProvenance(
      request({
        intent: {
          kind: "legacy_scenario_run_now",
          scenarioId,
          claimedNodeId: actionNodeId,
        },
      }),
      dependenciesFor(directScenario())
    );
    expect(verified).toMatchObject({
      kind: "scenario_run_now",
      scenarioId,
      rootNodeId,
      routes: [{ actionNodeId }],
    });
    expect(verified).not.toHaveProperty("claimedNodeId");
  });

  it("derives the unique legacy root from a claimed connected split", async () => {
    const verified = await verifyBulkCampaignProvenance(
      request({
        intent: {
          kind: "legacy_scenario_run_now",
          scenarioId,
          claimedNodeId: "column-split",
        },
      }),
      dependenciesFor(splitScenario())
    );

    expect(verified).toMatchObject({
      kind: "scenario_run_now",
      scenarioId,
      rootNodeId,
      columnSplitNodeId: "column-split",
    });
    expect(verified).not.toHaveProperty("claimedNodeId");
  });

  it("rejects legacy claims with zero or multiple matching roots", async () => {
    const legacyRequest = request({
      intent: {
        kind: "legacy_scenario_run_now",
        scenarioId,
        claimedNodeId: actionNodeId,
      },
    });
    await expectInvalid(
      verifyBulkCampaignProvenance(
        legacyRequest,
        dependenciesFor(directScenario({ edges: [] }))
      )
    );

    const multiple = directScenario({
      nodes: [bulkRoot(), bulkRoot("bulk-root-2"), whatsappAction()],
      edges: [
        {
          source: rootNodeId,
          sourceHandle: "right-source",
          target: actionNodeId,
        },
        {
          source: "bulk-root-2",
          sourceHandle: "right-source",
          target: actionNodeId,
        },
      ],
    });
    await expectInvalid(
      verifyBulkCampaignProvenance(legacyRequest, dependenciesFor(multiple))
    );
  });

  it.each([
    ["nodes are not an array", { nodes: { id: rootNodeId } }],
    ["an edge is malformed", { edges: [{ source: rootNodeId, target: 7 }] }],
    ["node data is malformed", { nodes: [{ id: rootNodeId, data: [] }] }],
  ])(
    "rejects malformed Mixed graph data when %s",
    async (_label, overrides) => {
      await expectInvalid(
        verifyBulkCampaignProvenance(
          request(),
          dependenciesFor(directScenario(overrides))
        )
      );
    }
  );

  it("validates Telegram and email graph compatibility without inventing message content", async () => {
    const channelScenario = (channel: "telegram" | "email") =>
      directScenario({
        nodes: [
          bulkRoot(rootNodeId, {
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              channels: [channel],
              sourceIds: channel === "telegram" ? ["telegram-source"] : [],
            },
          }),
          {
            id: actionNodeId,
            data: {
              kind: "action",
              actionType: "reply",
              actionReplyChannel: channel,
              actionReplyMode: "fixed",
              actionReplyText: "Persisted content is validated elsewhere",
            },
          },
        ],
      });

    const telegram = await verifyBulkCampaignProvenance(
      request({
        channel: "telegram",
        messageIntent: { kind: "unsupported", messageKind: "telegram" },
        recipients: [
          {
            stableId: "row-1",
            recipient: { chatId: "123", sourceId: "telegram-source" },
          },
        ],
      }),
      dependenciesFor(channelScenario("telegram"))
    );
    expect(telegram.routes[0]).toEqual({
      recipientStableId: "row-1",
      actionNodeId,
      channel: "telegram",
      sourceId: "telegram-source",
    });

    const email = await verifyBulkCampaignProvenance(
      request({
        channel: "email",
        messageIntent: { kind: "unsupported", messageKind: "email" },
        recipients: [
          { stableId: "row-1", recipient: { email: "a@example.com" } },
        ],
      }),
      dependenciesFor(channelScenario("email"))
    );
    expect(email.routes[0]).toEqual({
      recipientStableId: "row-1",
      actionNodeId,
      channel: "email",
      sourceId: null,
    });
  });

  it("constructs server-owned schedule provenance through the same verifier", async () => {
    const verified = await verifyBulkCampaignScenarioScheduleProvenance(
      {
        workspaceId,
        scenarioId,
        rootNodeId,
        actionNodeId,
        channel: "whatsapp",
        recipients: request().recipients,
        messageIntent: request().messageIntent,
      },
      dependenciesFor(directScenario())
    );

    expect(verified).toMatchObject({
      kind: "scenario_schedule",
      scenarioId,
      rootNodeId,
      routes: [{ actionNodeId }],
    });
  });

  it("derives scheduled provenance from the claimed action instead of a caller-supplied root", async () => {
    const scenario = directScenario({
      nodes: [
        bulkRoot(rootNodeId, {
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            channels: ["whatsapp"],
            sourceIds: ["source-1"],
            recipientPolicy: {
              version: 1,
              excludePriorFailedBulkSends: true,
            },
          },
        }),
        whatsappAction(),
      ],
    });
    const capability = await verifyBulkCampaignScenarioScheduleCapability(
      {
        workspaceId,
        scenarioId,
        scheduledNodeId: actionNodeId,
        channel: "whatsapp",
        messageIntent: request().messageIntent,
      } as Parameters<typeof verifyBulkCampaignScenarioScheduleCapability>[0],
      dependenciesFor(scenario)
    );
    const verified = routeVerifiedBulkCampaignScenarioScheduleProvenance(
      capability,
      request().recipients
    );

    expect(readVerifiedBulkCampaignScenarioScheduleContext(capability)).toEqual(
      {
        rootNodeId,
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      }
    );
    expect(verified).toMatchObject({
      kind: "scenario_schedule",
      scenarioId,
      rootNodeId,
      routes: [{ actionNodeId }],
    });
  });

  it("derives scheduled provenance directly when the claimed node is the bulk root", async () => {
    const verified = await verifyBulkCampaignScenarioScheduleProvenance(
      {
        workspaceId,
        scenarioId,
        scheduledNodeId: rootNodeId,
        channel: "whatsapp",
        recipients: request().recipients,
        messageIntent: request().messageIntent,
      } as Parameters<typeof verifyBulkCampaignScenarioScheduleProvenance>[0],
      dependenciesFor(directScenario())
    );

    expect(verified).toMatchObject({
      kind: "scenario_schedule",
      scenarioId,
      rootNodeId,
      routes: [{ actionNodeId }],
    });
  });

  it("verifies a root schedule whose split leaves Else unconnected and skips rows that land on it", async () => {
    const capability = await verifyBulkCampaignScenarioScheduleCapability(
      {
        workspaceId,
        scenarioId,
        scheduledNodeId: rootNodeId,
        channel: "whatsapp",
        messageIntent: request().messageIntent,
      } as Parameters<typeof verifyBulkCampaignScenarioScheduleCapability>[0],
      dependenciesFor(splitScenario({ omitElse: true }))
    );

    expect(
      routeVerifiedBulkCampaignScenarioScheduleProvenance(capability, [
        {
          stableId: "row-gold",
          recipient: { phone: "+15550000001", fields: { tier: "gold" } },
        },
      ]).routes.map(route => route.actionNodeId)
    ).toEqual(["marketing-action"]);
    // Like the bulk node, a scheduled occurrence skips rows on the empty
    // Else instead of failing the whole occurrence.
    const mixed = routeVerifiedBulkCampaignScenarioScheduleProvenance(
      capability,
      [
        {
          stableId: "row-gold",
          recipient: { phone: "+15550000001", fields: { tier: "gold" } },
        },
        {
          stableId: "row-none",
          recipient: { phone: "+15550000002", fields: { tier: "bronze" } },
        },
      ]
    );
    expect(mixed.routes.map(route => route.recipientStableId)).toEqual([
      "row-gold",
    ]);
    expect(mixed.skippedStableIds).toEqual(["row-none"]);
    // With nothing left to send, the occurrence still fails.
    expect(() =>
      routeVerifiedBulkCampaignScenarioScheduleProvenance(capability, [
        {
          stableId: "row-none",
          recipient: { phone: "+15550000002", fields: { tier: "bronze" } },
        },
      ])
    ).toThrow(
      expect.objectContaining({
        code: "bulk_campaign_provenance_invalid",
        reason: "recipient_route_missing",
      })
    );
    // A skipped row still counts toward duplicate stable ids.
    expect(() =>
      routeVerifiedBulkCampaignScenarioScheduleProvenance(capability, [
        {
          stableId: "row-gold",
          recipient: { phone: "+15550000001", fields: { tier: "gold" } },
        },
        {
          stableId: "row-gold",
          recipient: { phone: "+15550000002", fields: { tier: "bronze" } },
        },
      ])
    ).toThrow(
      expect.objectContaining({ reason: "recipient_stable_id_duplicate" })
    );
  });

  it("binds a split action schedule to only the claimed action", async () => {
    const capability = await verifyBulkCampaignScenarioScheduleCapability(
      {
        workspaceId,
        scenarioId,
        scheduledNodeId: actionNodeId,
        channel: "whatsapp",
        messageIntent: request().messageIntent,
      } as Parameters<typeof verifyBulkCampaignScenarioScheduleCapability>[0],
      dependenciesFor(splitScenario())
    );

    const verified = routeVerifiedBulkCampaignScenarioScheduleProvenance(
      capability,
      [
        {
          stableId: "row-gold",
          recipient: { phone: "+15550000001", fields: { tier: "gold" } },
        },
        {
          stableId: "row-silver",
          recipient: { phone: "+15550000002", fields: { tier: "silver" } },
        },
      ]
    );

    expect(verified.rootNodeId).toBe(rootNodeId);
    expect(verified.routes).toHaveLength(2);
    expect(
      verified.routes.every(route => route.actionNodeId === actionNodeId)
    ).toBe(true);
  });

  it("rejects an unrelated claimed scheduled node before catalog work", async () => {
    const deps = dependenciesFor(directScenario());

    await expectInvalid(
      verifyBulkCampaignScenarioScheduleCapability(
        {
          workspaceId,
          scenarioId,
          scheduledNodeId: "unrelated-node",
          channel: "whatsapp",
          messageIntent: request().messageIntent,
        } as Parameters<typeof verifyBulkCampaignScenarioScheduleCapability>[0],
        deps
      )
    );
    expect(deps.listApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
  });

  describe("builder root schedules", () => {
    function builderScenario(rootConfig: Record<string, unknown> = {}) {
      return directScenario({
        mode: "conversation",
        nodes: [
          bulkRoot(rootNodeId, {
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              channels: ["whatsapp"],
              ...rootConfig,
            },
          }),
          whatsappAction(),
        ],
      });
    }

    function scheduleRoot(sourceId: string) {
      return {
        workspaceId,
        scenarioId,
        scheduledNodeId: rootNodeId,
        channel: "whatsapp",
        messageIntent: { ...request().messageIntent, sourceId },
      } as Parameters<typeof verifyBulkCampaignScenarioScheduleCapability>[0];
    }

    const birthdayRecipients = [
      { stableId: "+15550000001", recipient: { phone: "+15550000001" } },
    ];

    it("routes a root that stores no sources through the server-resolved source", async () => {
      const deps = dependenciesFor(builderScenario());
      const capability = await verifyBulkCampaignScenarioScheduleCapability(
        scheduleRoot(" source-1 "),
        deps
      );

      expect(
        routeVerifiedBulkCampaignScenarioScheduleProvenance(
          capability,
          birthdayRecipients
        )
      ).toMatchObject({
        kind: "scenario_schedule",
        scenarioId,
        rootNodeId,
        routes: [
          {
            recipientStableId: "+15550000001",
            actionNodeId,
            sourceId: "source-1",
            template: { name: "promo" },
          },
        ],
      });
      expect(deps.listApprovedWhatsAppTemplatesForSend).toHaveBeenCalledWith(
        workspaceId,
        { sourceId: "source-1" }
      );
    });

    it("fails closed when no server source was resolved", async () => {
      const deps = dependenciesFor(builderScenario());
      await expect(
        verifyBulkCampaignScenarioScheduleCapability(scheduleRoot(""), deps)
      ).rejects.toMatchObject({ reason: "whatsapp_source_missing" });
      expect(deps.listApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
    });

    it("keeps configured root sources authoritative over the server source", async () => {
      const deps = dependenciesFor(
        builderScenario({ sourceIds: ["source-1"] })
      );
      const capability = await verifyBulkCampaignScenarioScheduleCapability(
        scheduleRoot("source-2"),
        deps
      );

      expect(
        routeVerifiedBulkCampaignScenarioScheduleProvenance(
          capability,
          birthdayRecipients
        ).routes
      ).toEqual([expect.objectContaining({ sourceId: "source-1" })]);
      expect(deps.listApprovedWhatsAppTemplatesForSend).toHaveBeenCalledTimes(
        1
      );
      expect(deps.listApprovedWhatsAppTemplatesForSend).toHaveBeenCalledWith(
        workspaceId,
        { sourceId: "source-1" }
      );
    });

    it("still requires stored sources for a legacy bulk_campaign root", async () => {
      const deps = dependenciesFor({
        ...builderScenario(),
        mode: "bulk_campaign",
      });
      await expect(
        verifyBulkCampaignScenarioScheduleCapability(
          scheduleRoot("source-1"),
          deps
        )
      ).rejects.toMatchObject({ reason: "whatsapp_source_missing" });
    });

    it("rejects a follow-up workflow root", async () => {
      const deps = dependenciesFor(
        builderScenario({ workflowKind: "follow_up_workflow" })
      );
      await expect(
        verifyBulkCampaignScenarioScheduleCapability(
          scheduleRoot("source-1"),
          deps
        )
      ).rejects.toMatchObject({ reason: "scheduled_node_not_bulk_root" });
      expect(deps.listApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
    });

    function telegramBirthdayScenario(
      rootConfig: Record<string, unknown> = {}
    ) {
      return directScenario({
        mode: "conversation",
        nodes: [
          bulkRoot(rootNodeId, {
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              channels: ["telegram"],
              recipientAudienceSource: "customer_birthdays",
              telegramSubscriberSourceId: "tg-source",
              ...rootConfig,
            },
          }),
          {
            id: actionNodeId,
            data: {
              kind: "action",
              actionType: "reply",
              actionReplyChannel: "telegram",
              actionReplyMode: "fixed",
              actionReplyText: "Happy birthday {{name}}",
            },
          },
        ],
      });
    }

    const telegramScheduleInput = {
      workspaceId,
      scenarioId,
      scheduledNodeId: rootNodeId,
      channel: "telegram",
      messageIntent: { kind: "unsupported", messageKind: "telegram" },
    } as Parameters<typeof verifyBulkCampaignScenarioScheduleCapability>[0];

    it("authorizes Telegram birthday recipients only through the selected bot", async () => {
      const deps = dependenciesFor(telegramBirthdayScenario());
      const capability = await verifyBulkCampaignScenarioScheduleCapability(
        telegramScheduleInput,
        deps
      );
      expect(
        routeVerifiedBulkCampaignScenarioScheduleProvenance(capability, [
          {
            stableId: "10001:tg-source",
            recipient: { chatId: "10001", sourceId: "tg-source" },
          },
        ])
      ).toMatchObject({
        kind: "scenario_schedule",
        rootNodeId,
        routes: [{ actionNodeId, channel: "telegram", sourceId: "tg-source" }],
      });
      expect(() =>
        routeVerifiedBulkCampaignScenarioScheduleProvenance(capability, [
          {
            stableId: "10001:other-bot",
            recipient: { chatId: "10001", sourceId: "other-bot" },
          },
        ])
      ).toThrow("telegram_source_mismatch");
      expect(deps.listApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
    });

    it("rejects a Telegram birthday schedule without its selected bot", async () => {
      await expect(
        verifyBulkCampaignScenarioScheduleCapability(
          telegramScheduleInput,
          dependenciesFor(
            telegramBirthdayScenario({ telegramSubscriberSourceId: undefined })
          )
        )
      ).rejects.toMatchObject({ reason: "telegram_source_missing" });
    });

    it("rejects conflicting configured sources on a Telegram birthday root", async () => {
      await expect(
        verifyBulkCampaignScenarioScheduleCapability(
          telegramScheduleInput,
          dependenciesFor(
            telegramBirthdayScenario({ sourceIds: ["other-bot"] })
          )
        )
      ).rejects.toMatchObject({ reason: "telegram_source_mismatch" });
    });
  });

  it.each([
    ["foreign workspace", directScenario({ workspaceId: "workspace-2" })],
    ["deleted scenario", directScenario({ deletedAt: "2026-08-21" })],
    [
      "conversation scenario but is not its bulk root",
      directScenario({ mode: "conversation" }),
    ],
  ])(
    "fails closed when a claimed scheduled node belongs to a %s",
    async (_label, scenario) => {
      const deps = dependenciesFor(scenario);
      await expectInvalid(
        verifyBulkCampaignScenarioScheduleCapability(
          {
            workspaceId,
            scenarioId,
            scheduledNodeId: actionNodeId,
            channel: "whatsapp",
            messageIntent: request().messageIntent,
          } as Parameters<
            typeof verifyBulkCampaignScenarioScheduleCapability
          >[0],
          deps
        )
      );
      expect(deps.listApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
    }
  );

  it("fails closed when a claimed scheduled descendant matches more than one bulk root", async () => {
    const ambiguous = directScenario({
      nodes: [bulkRoot(), bulkRoot("bulk-root-2"), whatsappAction()],
      edges: [
        {
          source: rootNodeId,
          sourceHandle: "right-source",
          target: actionNodeId,
        },
        {
          source: "bulk-root-2",
          sourceHandle: "right-source",
          target: actionNodeId,
        },
      ],
    });
    const deps = dependenciesFor(ambiguous);

    await expectInvalid(
      verifyBulkCampaignScenarioScheduleCapability(
        {
          workspaceId,
          scenarioId,
          scheduledNodeId: actionNodeId,
          channel: "whatsapp",
          messageIntent: request().messageIntent,
        } as Parameters<typeof verifyBulkCampaignScenarioScheduleCapability>[0],
        deps
      )
    );
    expect(deps.listApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
  });

  it("derives scheduled provenance from a claimed split descendant through findLegacyRoot", async () => {
    const capability = await verifyBulkCampaignScenarioScheduleCapability(
      {
        workspaceId,
        scenarioId,
        scheduledNodeId: "column-split",
        channel: "whatsapp",
        messageIntent: request().messageIntent,
      } as Parameters<typeof verifyBulkCampaignScenarioScheduleCapability>[0],
      dependenciesFor(splitScenario())
    );
    const verified = routeVerifiedBulkCampaignScenarioScheduleProvenance(
      capability,
      [
        {
          stableId: "row-gold",
          recipient: { phone: "+15550000001", fields: { tier: "gold" } },
        },
        {
          stableId: "row-silver",
          recipient: { phone: "+15550000002", fields: { tier: "silver" } },
        },
      ]
    );

    expect(readVerifiedBulkCampaignScenarioScheduleContext(capability)).toEqual(
      expect.objectContaining({ rootNodeId })
    );
    expect(verified).toMatchObject({
      kind: "scenario_schedule",
      rootNodeId,
      columnSplitNodeId: "column-split",
    });
    expect(
      verified.routes.map(route => ({
        stableId: route.recipientStableId,
        actionNodeId: route.actionNodeId,
      }))
    ).toEqual([
      { stableId: "row-gold", actionNodeId: "marketing-action" },
      { stableId: "row-silver", actionNodeId: "utility-action" },
    ]);
  });

  it("keeps scenario_schedule impossible to construct through browser request parsing", () => {
    expect(() =>
      parseBulkCampaignSendRequest({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        channel: "whatsapp",
        audience: { kind: "inline", recipients: [{ phone: "+15550000001" }] },
        provenance: { kind: "scenario_schedule", scenarioId },
        templateName: "promo",
      })
    ).toThrow();
  });

  it("rejects invalid schedule capability before recipients or catalog work", async () => {
    const deps = dependenciesFor(
      directScenario({ workspaceId: "workspace-2" })
    );

    await expectInvalid(
      verifyBulkCampaignScenarioScheduleCapability(
        {
          workspaceId,
          scenarioId,
          rootNodeId,
          actionNodeId,
          channel: "whatsapp",
          messageIntent: request().messageIntent,
        },
        deps
      )
    );
    expect(deps.listApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
  });

  it("routes a verified schedule later without repeating graph or catalog work", async () => {
    const deps = dependenciesFor(directScenario());
    const capability = await verifyBulkCampaignScenarioScheduleCapability(
      {
        workspaceId,
        scenarioId,
        rootNodeId,
        actionNodeId,
        channel: "whatsapp",
        messageIntent: request().messageIntent,
      },
      deps
    );
    expect(deps.findScenario).toHaveBeenCalledTimes(1);
    expect(deps.listApprovedWhatsAppTemplatesForSend).toHaveBeenCalledTimes(1);

    const verified = routeVerifiedBulkCampaignScenarioScheduleProvenance(
      capability,
      request().recipients
    );
    expect(verified).toMatchObject({
      kind: "scenario_schedule",
      scenarioId,
      rootNodeId,
      routes: [{ actionNodeId, sourceId: "source-1" }],
    });
    expect(deps.findScenario).toHaveBeenCalledTimes(1);
    expect(deps.listApprovedWhatsAppTemplatesForSend).toHaveBeenCalledTimes(1);
  });

  it("loads one catalog per authorized schedule source and routes provider authority per recipient", async () => {
    const scenario = directScenario({
      nodes: [
        bulkRoot(rootNodeId, {
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            channels: ["whatsapp"],
            sourceIds: ["source-1", "source-2", "source-1"],
          },
        }),
        whatsappAction(actionNodeId, {
          actionWhatsAppTemplateCategory: undefined,
        }),
      ],
    });
    const source2Template: WhatsAppTemplate = {
      ...promoTemplate,
      id: "template-promo-source-2",
      category: "UTILITY",
      components: [{ type: "BODY", text: "Provider source 2" }],
    };
    const deps = dependenciesForSources(scenario, {
      "source-1": [promoTemplate],
      "source-2": [source2Template],
    });
    const capability = await verifyBulkCampaignScenarioScheduleCapability(
      {
        workspaceId,
        scenarioId,
        rootNodeId,
        actionNodeId,
        channel: "whatsapp",
        messageIntent: request().messageIntent,
      },
      deps
    );

    expect(deps.listApprovedWhatsAppTemplatesForSend).toHaveBeenCalledTimes(2);
    expect(deps.listApprovedWhatsAppTemplatesForSend).toHaveBeenNthCalledWith(
      1,
      workspaceId,
      { sourceId: "source-1" }
    );
    expect(deps.listApprovedWhatsAppTemplatesForSend).toHaveBeenNthCalledWith(
      2,
      workspaceId,
      { sourceId: "source-2" }
    );

    const verified = routeVerifiedBulkCampaignScenarioScheduleProvenance(
      capability,
      [
        {
          stableId: "row-1",
          recipient: { phone: "+15550000001", sourceId: "source-1" },
        },
        {
          stableId: "row-2",
          recipient: { phone: "+15550000002", sourceId: "source-2" },
        },
      ]
    );
    expect(
      verified.routes.map(route => ({
        stableId: route.recipientStableId,
        sourceId: route.sourceId,
        category: route.template?.category,
        body: route.template?.components[0],
      }))
    ).toEqual([
      {
        stableId: "row-1",
        sourceId: "source-1",
        category: "MARKETING",
        body: { type: "BODY", text: "Provider promo" },
      },
      {
        stableId: "row-2",
        sourceId: "source-2",
        category: "UTILITY",
        body: { type: "BODY", text: "Provider source 2" },
      },
    ]);
    expect(deps.findScenario).toHaveBeenCalledTimes(1);
    expect(deps.listApprovedWhatsAppTemplatesForSend).toHaveBeenCalledTimes(2);
  });

  it("isolates duplicate, unavailable, and category-conflicting schedule catalogs by source", async () => {
    const multiSourceScenario = (category: string | undefined) =>
      directScenario({
        nodes: [
          bulkRoot(rootNodeId, {
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              channels: ["whatsapp"],
              sourceIds: ["source-1", "source-2"],
            },
          }),
          whatsappAction(actionNodeId, {
            actionWhatsAppTemplateCategory: category,
          }),
        ],
      });
    const source2Utility = {
      ...promoTemplate,
      id: "source-2-utility",
      category: "UTILITY" as const,
    };
    const scheduleInput = {
      workspaceId,
      scenarioId,
      rootNodeId,
      actionNodeId,
      channel: "whatsapp" as const,
      messageIntent: request().messageIntent,
    };

    await expectInvalid(
      verifyBulkCampaignScenarioScheduleCapability(
        scheduleInput,
        dependenciesForSources(multiSourceScenario(undefined), {
          "source-1": [promoTemplate],
          "source-2": [
            source2Utility,
            { ...source2Utility, id: "source-2-duplicate" },
          ],
        })
      )
    );
    await expectInvalid(
      verifyBulkCampaignScenarioScheduleCapability(
        scheduleInput,
        dependenciesForSources(multiSourceScenario(undefined), {
          "source-1": [promoTemplate],
          "source-2": [],
        })
      )
    );
    await expectInvalid(
      verifyBulkCampaignScenarioScheduleCapability(
        scheduleInput,
        dependenciesForSources(multiSourceScenario("MARKETING"), {
          "source-1": [promoTemplate],
          "source-2": [source2Utility],
        })
      )
    );
  });

  it("rejects ambiguous, unauthorized, and over-broad schedule source routing", async () => {
    const scenario = directScenario({
      nodes: [
        bulkRoot(rootNodeId, {
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            channels: ["whatsapp"],
            sourceIds: ["source-1", "source-2"],
          },
        }),
        whatsappAction(actionNodeId, {
          actionWhatsAppTemplateCategory: undefined,
        }),
      ],
    });
    const deps = dependenciesForSources(scenario, {
      "source-1": [promoTemplate],
      "source-2": [promoTemplate],
    });
    const capability = await verifyBulkCampaignScenarioScheduleCapability(
      {
        workspaceId,
        scenarioId,
        rootNodeId,
        actionNodeId,
        channel: "whatsapp",
        messageIntent: request().messageIntent,
      },
      deps
    );

    expectInvalidCall(() =>
      routeVerifiedBulkCampaignScenarioScheduleProvenance(capability, [
        { stableId: "row-1", recipient: { phone: "+15550000001" } },
      ])
    );
    expectInvalidCall(() =>
      routeVerifiedBulkCampaignScenarioScheduleProvenance(capability, [
        {
          stableId: "row-1",
          recipient: { phone: "+15550000001", sourceId: "source-3" },
        },
      ])
    );

    const overBroadScenario = directScenario({
      nodes: [
        bulkRoot(rootNodeId, {
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            channels: ["whatsapp"],
            sourceIds: Array.from(
              { length: 21 },
              (_, index) => `source-${index}`
            ),
          },
        }),
        whatsappAction(),
      ],
    });
    const overBroadDeps = dependenciesFor(overBroadScenario);
    await expectInvalid(
      verifyBulkCampaignScenarioScheduleCapability(
        {
          workspaceId,
          scenarioId,
          rootNodeId,
          actionNodeId,
          channel: "whatsapp",
          messageIntent: request().messageIntent,
        },
        overBroadDeps
      )
    );
    expect(
      overBroadDeps.listApprovedWhatsAppTemplatesForSend
    ).not.toHaveBeenCalled();
  });

  it("verifies a bounded generated multi-branch graph without weakening the run-now exactly-one-edge verifier", async () => {
    const generatedScenario = directScenario({
      mode: "conversation",
      nodes: [
        bulkRoot(rootNodeId, {
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            sendMode: "immediate",
            channels: ["whatsapp"],
            sourceIds: ["source-1"],
            generationJobId: "revision-1",
            recipientPolicy: {
              version: 1,
              excludePriorFailedBulkSends: true,
            },
            cohorts: [
              { id: "cohort-a", branchId: "cohort-a", label: "A", count: 1 },
              { id: "cohort-b", branchId: "cohort-b", label: "B", count: 1 },
            ],
          },
        }),
        whatsappAction("marketing-action", {
          bulkRecipientBranchId: "cohort-a",
        }),
        whatsappAction("utility-action", {
          bulkRecipientBranchId: "cohort-b",
        }),
      ],
      edges: [
        {
          source: rootNodeId,
          sourceHandle: "right-source",
          target: "marketing-action",
        },
        {
          source: rootNodeId,
          sourceHandle: "right-source",
          target: "utility-action",
        },
      ],
    });
    const deps = dependenciesFor(generatedScenario);

    await expectInvalid(
      verifyBulkCampaignProvenanceCapability(
        {
          workspaceId,
          intent: { kind: "scenario_run_now", scenarioId, rootNodeId },
          channel: "whatsapp",
          messageIntent: request().messageIntent,
        },
        deps
      )
    );

    const capability = await verifyGeneratedBulkCampaignProvenanceCapability(
      {
        workspaceId,
        scenarioId,
        rootNodeId,
        audienceRevision: "revision-1",
      },
      deps
    );
    const verified = await routeVerifiedGeneratedBulkCampaignProvenance(
      capability,
      [
        {
          stableId: "generated-a",
          nodeId: "marketing-action",
          branchId: "cohort-a",
          channel: "whatsapp",
          sourceId: "source-1",
          recipient: { phone: "+15550000001", sourceId: "source-1" },
        },
        {
          stableId: "generated-b",
          nodeId: "utility-action",
          branchId: "cohort-b",
          channel: "whatsapp",
          sourceId: "source-1",
          recipient: { phone: "+15550000002", sourceId: "source-1" },
        },
      ]
    );

    expect(verified).toMatchObject({
      kind: "scenario_run_now",
      scenarioId,
      rootNodeId,
      recipientPolicy: {
        version: 1,
        excludePriorFailedBulkSends: true,
      },
      routes: [
        {
          recipientStableId: "generated-a",
          actionNodeId: "marketing-action",
          template: { name: "promo", category: "MARKETING" },
        },
        {
          recipientStableId: "generated-b",
          actionNodeId: "utility-action",
          template: { name: "receipt", category: "UTILITY" },
        },
      ],
    });
    expect(deps.listApprovedWhatsAppTemplatesForSend).toHaveBeenCalledTimes(1);
    await expect(
      routeVerifiedGeneratedBulkCampaignProvenance(capability, [
        {
          stableId: "forged-branch",
          nodeId: "marketing-action",
          branchId: "cohort-b",
          channel: "whatsapp",
          sourceId: "source-1",
          recipient: { phone: "+15550000003", sourceId: "source-1" },
        },
      ])
    ).rejects.toThrow(
      expect.objectContaining({
        code: "bulk_campaign_provenance_invalid",
        reason: "recipient_route_missing",
      })
    );
  });

  it("routes generated mixed-channel rows through their persisted row channel and only catalogs participating WhatsApp sources", async () => {
    const generatedScenario = directScenario({
      mode: "conversation",
      nodes: [
        bulkRoot(rootNodeId, {
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            sendMode: "immediate",
            channels: ["whatsapp", "telegram"],
            sourceIds: ["wa-source", "tg-source", "research-source"],
            generationJobId: "revision-1",
            cohorts: [
              { id: "cohort-a", branchId: "cohort-a", label: "A", count: 2 },
            ],
          },
        }),
        whatsappAction("mixed-action", {
          bulkRecipientBranchId: "cohort-a",
        }),
      ],
      edges: [
        {
          source: rootNodeId,
          sourceHandle: "right-source",
          target: "mixed-action",
        },
      ],
    });
    const deps = dependenciesForSources(generatedScenario, {
      "wa-source": [promoTemplate],
    });

    const capability = await verifyGeneratedBulkCampaignProvenanceCapability(
      {
        workspaceId,
        scenarioId,
        rootNodeId,
        audienceRevision: "revision-1",
      },
      deps
    );
    const verified = await routeVerifiedGeneratedBulkCampaignProvenance(
      capability,
      [
        {
          stableId: "wa-row",
          nodeId: "mixed-action",
          branchId: "cohort-a",
          channel: "whatsapp",
          sourceId: "wa-source",
          recipient: { phone: "+15550000001", sourceId: "wa-source" },
        },
        {
          stableId: "tg-row",
          nodeId: "mixed-action",
          branchId: "cohort-a",
          channel: "telegram",
          sourceId: "tg-source",
          recipient: { chatId: "10001", sourceId: "tg-source" },
        },
      ]
    );

    expect(verified.routes).toMatchObject([
      {
        recipientStableId: "wa-row",
        channel: "whatsapp",
        sourceId: "wa-source",
        template: { name: "promo", category: "MARKETING" },
      },
      {
        recipientStableId: "tg-row",
        channel: "telegram",
        sourceId: "tg-source",
      },
    ]);
    expect(deps.listApprovedWhatsAppTemplatesForSend).toHaveBeenCalledTimes(1);
    expect(deps.listApprovedWhatsAppTemplatesForSend).toHaveBeenCalledWith(
      workspaceId,
      { sourceId: "wa-source" }
    );
  });

  it.each(["telegram", "email"] as const)(
    "accepts the canonical generated %s-only reply action shape",
    async channel => {
      const generatedScenario = directScenario({
        mode: "conversation",
        nodes: [
          bulkRoot(rootNodeId, {
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              sendMode: "immediate",
              channels: [channel],
              sourceIds: channel === "telegram" ? ["tg-source"] : [],
              generationJobId: "revision-1",
              cohorts: [
                {
                  id: "cohort-a",
                  branchId: "cohort-a",
                  label: "A",
                  count: 1,
                },
              ],
            },
          }),
          {
            id: "reply-action",
            data: {
              kind: "action",
              actionType: "reply",
              bulkRecipientBranchId: "cohort-a",
            },
          },
        ],
        edges: [
          {
            source: rootNodeId,
            sourceHandle: "right-source",
            target: "reply-action",
          },
        ],
      });
      const deps = dependenciesFor(generatedScenario);
      const capability = await verifyGeneratedBulkCampaignProvenanceCapability(
        {
          workspaceId,
          scenarioId,
          rootNodeId,
          audienceRevision: "revision-1",
        },
        deps
      );

      const verified = await routeVerifiedGeneratedBulkCampaignProvenance(
        capability,
        [
          {
            stableId: `${channel}-row`,
            nodeId: "reply-action",
            branchId: "cohort-a",
            channel,
            sourceId: channel === "telegram" ? "tg-source" : null,
            recipient:
              channel === "telegram"
                ? { chatId: "10001", sourceId: "tg-source" }
                : { email: "hello@example.com" },
          },
        ]
      );

      expect(verified.routes).toMatchObject([
        { recipientStableId: `${channel}-row`, channel },
      ]);
      expect(deps.listApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
    }
  );

  it("binds generated capabilities to the exact persisted revision before catalog work", async () => {
    const scenario = directScenario({
      nodes: [
        bulkRoot(rootNodeId, {
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            sendMode: "immediate",
            channels: ["whatsapp"],
            sourceIds: ["source-1"],
            generationJobId: "revision-current",
            cohorts: [
              { id: "cohort-a", branchId: "cohort-a", label: "A", count: 1 },
            ],
          },
        }),
        whatsappAction(actionNodeId, {
          bulkRecipientBranchId: "cohort-a",
        }),
      ],
    });
    const deps = dependenciesFor(scenario);

    await expectInvalid(
      verifyGeneratedBulkCampaignProvenanceCapability(
        {
          workspaceId,
          scenarioId,
          rootNodeId,
          audienceRevision: "revision-stale",
        },
        deps
      )
    );
    expect(deps.listApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
  });

  it("rejects a generated graph when any persisted cohort lacks its exact outbound action", async () => {
    const scenario = directScenario({
      nodes: [
        bulkRoot(rootNodeId, {
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            sendMode: "immediate",
            channels: ["whatsapp"],
            sourceIds: ["source-1"],
            generationJobId: "revision-1",
            cohorts: [
              { id: "cohort-a", branchId: "cohort-a", label: "A", count: 1 },
              { id: "cohort-b", branchId: "cohort-b", label: "B", count: 1 },
            ],
          },
        }),
        whatsappAction(actionNodeId, {
          bulkRecipientBranchId: "cohort-a",
        }),
      ],
    });

    await expectInvalid(
      verifyGeneratedBulkCampaignProvenanceCapability(
        {
          workspaceId,
          scenarioId,
          rootNodeId,
          audienceRevision: "revision-1",
        },
        dependenciesFor(scenario)
      )
    );
  });

  it("rejects 21 raw generated branches and accepts the shared bound of 20 before catalog work", async () => {
    const generatedScenario = (count: number) =>
      directScenario({
        mode: "conversation",
        nodes: [
          bulkRoot(rootNodeId, {
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              sendMode: "immediate",
              channels: ["whatsapp"],
              sourceIds: ["source-1"],
              generationJobId: "revision-1",
              cohorts: Array.from({ length: count }, (_, index) => ({
                id: `cohort-${index}`,
                branchId: `cohort-${index}`,
                label: String(index),
                count: 1,
              })),
            },
          }),
          ...Array.from({ length: count }, (_, index) =>
            whatsappAction(`action-${index}`, {
              bulkRecipientBranchId: `cohort-${index}`,
            })
          ),
        ],
        edges: Array.from({ length: count }, (_, index) => ({
          source: rootNodeId,
          sourceHandle: "right-source",
          target: `action-${index}`,
        })),
      });
    const overBound = dependenciesFor(generatedScenario(21));
    await expectInvalid(
      verifyGeneratedBulkCampaignProvenanceCapability(
        {
          workspaceId,
          scenarioId,
          rootNodeId,
          audienceRevision: "revision-1",
        },
        overBound
      )
    );
    expect(
      overBound.listApprovedWhatsAppTemplatesForSend
    ).not.toHaveBeenCalled();

    const atBound = dependenciesFor(generatedScenario(20));
    await expect(
      verifyGeneratedBulkCampaignProvenanceCapability(
        {
          workspaceId,
          scenarioId,
          rootNodeId,
          audienceRevision: "revision-1",
        },
        atBound
      )
    ).resolves.toBeDefined();
    expect(atBound.listApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
  });
});

describe("the action step's saved template on verified routes", () => {
  it("carries the step's template and button ids for WhatsApp routes", async () => {
    const components = [
      { type: "BODY", text: "Untrusted stored preview" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Premium" }] },
    ];
    const buttonIds = {
      version: 1,
      nextId: 10,
      buttons: [{ id: 1, index: 0, text: "Premium" }],
    };
    const verified = await verifyBulkCampaignProvenance(
      request(),
      dependenciesFor(
        directScenario({
          nodes: [
            bulkRoot(),
            whatsappAction(actionNodeId, {
              actionWhatsAppTemplateComponents: components,
              actionWhatsAppTemplateButtonIds: buttonIds,
            }),
          ],
        })
      )
    );

    expect(verified.routes[0]?.stepTemplate).toEqual({
      components,
      buttonIds,
    });
    // The approved template, not the step's copy, is what gets sent.
    expect(verified.routes[0]?.template?.components).toEqual(
      promoTemplate.components
    );
  });
});

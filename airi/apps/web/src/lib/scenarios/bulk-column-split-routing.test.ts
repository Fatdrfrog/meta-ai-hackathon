import type {
  ScenarioGraphEdge,
  ScenarioCanvasNode,
} from "@icecore/scenario-contracts";
import {
  applyBulkColumnSplitTemplateCatalogState,
  buildBulkColumnSplitPreview,
  prepareBulkColumnSplitRecipients,
  resolveBulkConnectedActionFromNode,
  resolveBulkColumnSplitRouting,
  summarizeBulkColumnSplitRouteCounts,
} from "./bulk-column-split-routing";

function makeNodes(): ScenarioCanvasNode[] {
  return [
    {
      id: "bulk-1",
      position: { x: 0, y: 0 },
      data: {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          channels: ["whatsapp"],
          sendMode: "immediate",
          campaignName: "Test",
          uploadedRecipients: [
            {
              phone: "+10000000001",
              fields: { loyalty: "gold", region: "KZ" },
            },
            {
              phone: "+10000000002",
              fields: { loyalty: "silver", region: "UZ" },
            },
            { phone: "+10000000003", fields: { loyalty: "bronze" } },
          ],
        },
      },
    },
    {
      id: "split-1",
      position: { x: 200, y: 0 },
      data: {
        kind: "logic",
        logicType: "recipient_column_split",
        recipientColumnSplit: {
          version: 1,
          paths: [
            {
              id: "gold",
              label: "Gold",
              rules: [
                { id: "r1", column: "loyalty", op: "equals", value: "gold" },
              ],
            },
            {
              id: "silver",
              label: "Silver",
              rules: [
                { id: "r2", column: "loyalty", op: "equals", value: "silver" },
              ],
            },
          ],
        },
      },
    },
    {
      id: "tpl-gold",
      position: { x: 400, y: -40 },
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "gold_offer",
        actionWhatsAppTemplateLanguage: "en",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Hello {{1}}" },
        ],
        actionCampaignVariableConfigs: {
          "1": { mode: "custom", customValue: "Gold" },
        },
      },
    },
    {
      id: "tpl-silver",
      position: { x: 400, y: 40 },
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "silver_offer",
        actionWhatsAppTemplateLanguage: "en",
        actionWhatsAppTemplateComponents: [{ type: "BODY", text: "Hi {{1}}" }],
        actionCampaignVariableConfigs: {
          "1": { mode: "custom", customValue: "Silver" },
        },
      },
    },
  ] as ScenarioCanvasNode[];
}

function makeEdges(): ScenarioGraphEdge[] {
  return [
    {
      id: "e1",
      source: "bulk-1",
      target: "split-1",
      sourceHandle: "right-source",
    },
    {
      id: "e2",
      source: "split-1",
      target: "tpl-gold",
      sourceHandle: "right-source-column-split-gold",
    },
    {
      id: "e3",
      source: "split-1",
      target: "tpl-silver",
      sourceHandle: "right-source-column-split-silver",
    },
  ] as ScenarioGraphEdge[];
}

describe("bulk-column-split-routing", () => {
  it.each([
    ["ru_RU", "ru", "APPROVED", null],
    ["ru_RU", "ru", undefined, "not_approved"],
    ["en", "en_US", "APPROVED", "stale"],
  ])(
    "applies the live template send gate for %s and %s with status %s",
    (saved, catalog, status, reason) => {
      expect(
        resolveBulkConnectedActionFromNode({
          actionNodeId: "template-1",
          actionData: {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "offer",
            actionWhatsAppTemplateLanguage: saved,
          },
          whatsAppTemplates: [{ name: "offer", language: catalog, status }],
        })
      ).toHaveProperty("templateSendBlockReason", reason);
    }
  );

  it.each([
    [{}, "ai"],
    [{ actionReplyText: "   " }, "ai"],
    [{ actionReplyText: "Hello" }, "fixed"],
    [{ actionReplyTemplate: "Hello {{first_name}}" }, "fixed"],
    [{ actionSnippetAnswer: "Saved answer" }, "fixed"],
    [{ actionReplyMode: "ai", actionReplyText: "Saved text" }, "ai"],
    [{ source: "messaging" }, "fixed"],
    [{ source: "airi", actionReplyText: "Saved text" }, "ai"],
  ] as const)("preserves inferred reply mode for %j", (data, replyMode) => {
    expect(
      resolveBulkConnectedActionFromNode({
        actionNodeId: "reply-1",
        actionData: { kind: "action", actionType: "reply", ...data },
        whatsAppTemplates: [],
      })
    ).toMatchObject({ actionType: "reply", replyMode });
  });

  it("keeps a generated template pending even when the catalog contains an approved match", () => {
    expect(
      resolveBulkConnectedActionFromNode({
        actionNodeId: "template-1",
        actionData: {
          kind: "action",
          actionType: "whatsapp_template",
          generatedTemplateDraft: {
            id: "draft-1",
            name: "offer",
            language: "en",
            status: "pending",
          },
        },
        whatsAppTemplates: [
          { name: "offer", language: "en", status: "APPROVED" },
        ],
      })
    ).toHaveProperty("templateSendBlockReason", "pending_review");
  });

  it("rejects Generative AI actions in the runtime bulk resolver", () => {
    expect(
      resolveBulkConnectedActionFromNode({
        actionNodeId: "generate",
        actionData: {
          kind: "action",
          actionType: "generative_ai",
          source: "whatsapp",
          actionGenerativeAIConfig: {
            version: 1,
            mode: "text_to_video",
            prompt: "Create one video per recipient",
          },
        },
      })
    ).toBeNull();
  });

  it("maps path handles to templates", () => {
    const routing = resolveBulkColumnSplitRouting({
      bulkRootId: "bulk-1",
      nodes: makeNodes(),
      edges: makeEdges(),
    });
    expect(routing?.splitNodeId).toBe("split-1");
    expect(routing?.routes[0]?.action?.templateName).toBe("gold_offer");
    expect(routing?.routes[1]?.action?.templateName).toBe("silver_offer");
    expect(routing?.elseRoute.action).toBeNull();
  });

  it("counts recipients by first-match path", () => {
    const routing = resolveBulkColumnSplitRouting({
      bulkRootId: "bulk-1",
      nodes: makeNodes(),
      edges: makeEdges(),
    })!;
    const recipients =
      (
        makeNodes()[0]!.data as {
          bulkRootConfig?: { uploadedRecipients?: unknown[] };
        }
      ).bulkRootConfig?.uploadedRecipients || [];
    const counts = summarizeBulkColumnSplitRouteCounts({
      recipients: recipients as never,
      routing,
    });
    expect(counts.byPathId.gold).toBe(1);
    expect(counts.byPathId.silver).toBe(1);
    expect(counts.elseCount).toBe(1);
  });

  it("prepares heterogeneous templates and skips else", () => {
    const nodes = makeNodes();
    (
      nodes[2]!.data as { actionWhatsAppTemplateCategory?: string }
    ).actionWhatsAppTemplateCategory = "MARKETING";
    (
      nodes[3]!.data as { actionWhatsAppTemplateCategory?: string }
    ).actionWhatsAppTemplateCategory = "UTILITY";
    const whatsAppTemplates = [
      {
        id: "tpl-gold-live",
        name: "gold_offer",
        language: "en",
        status: "APPROVED",
        category: "MARKETING",
        components: [{ type: "BODY", text: "Hello {{1}}" }],
      },
      {
        id: "tpl-silver-live",
        name: "silver_offer",
        language: "en",
        status: "APPROVED",
        category: "UTILITY",
        components: [{ type: "BODY", text: "Hi {{1}}" }],
      },
    ];
    const routing = resolveBulkColumnSplitRouting({
      bulkRootId: "bulk-1",
      nodes,
      edges: makeEdges(),
      whatsAppTemplates: whatsAppTemplates as never,
    })!;
    const recipients =
      (
        nodes[0]!.data as {
          bulkRootConfig?: {
            uploadedRecipients?: Array<{
              phone?: string;
              fields?: Record<string, string>;
            }>;
          };
        }
      ).bulkRootConfig?.uploadedRecipients || [];

    const prepared = prepareBulkColumnSplitRecipients({
      recipients,
      routing,
      actionVariableConfigsByNodeId: {
        "tpl-gold": { "1": { mode: "custom", customValue: "Gold" } },
        "tpl-silver": { "1": { mode: "custom", customValue: "Silver" } },
      },
    });

    expect(prepared.ready).toHaveLength(2);
    expect(prepared.skippedElse).toBe(1);
    expect(prepared.unresolved).toHaveLength(0);
    expect(prepared.blockedActions).toHaveLength(0);
    expect(
      prepared.ready.map(item => item.recipient.templateName).sort()
    ).toEqual(["gold_offer", "silver_offer"]);
    expect(
      prepared.ready.map(item => item.recipient.templateCategory).sort()
    ).toEqual(["MARKETING", "UTILITY"]);
  });

  it("keeps no-split bulk resolution null", () => {
    const nodes = makeNodes().filter(node => node.id === "bulk-1");
    const edges: ScenarioGraphEdge[] = [
      {
        id: "e1",
        source: "bulk-1",
        target: "tpl-gold",
        sourceHandle: "right-source",
      },
    ] as ScenarioGraphEdge[];
    expect(
      resolveBulkColumnSplitRouting({
        bulkRootId: "bulk-1",
        nodes: [
          ...nodes,
          {
            id: "tpl-gold",
            position: { x: 0, y: 0 },
            data: {
              kind: "action",
              actionType: "whatsapp_template",
              actionWhatsAppTemplateName: "promo",
            },
          } as ScenarioCanvasNode,
        ],
        edges,
      })
    ).toBeNull();
  });

  it("surfaces distinct preview disabled reasons", () => {
    const nodes = makeNodes();
    const incomplete = structuredClone(nodes);
    (
      incomplete[1]!.data as {
        recipientColumnSplit: {
          paths: Array<{ rules: Array<{ column: string }> }>;
        };
      }
    ).recipientColumnSplit.paths[0]!.rules[0]!.column = "";

    const incompleteRouting = resolveBulkColumnSplitRouting({
      bulkRootId: "bulk-1",
      nodes: incomplete,
      edges: makeEdges(),
    })!;
    expect(
      buildBulkColumnSplitPreview({
        recipients: [],
        routing: incompleteRouting,
      }).disabledReason
    ).toBe("columnSplitConfigIncomplete");

    const noTemplateEdges: ScenarioGraphEdge[] = [
      {
        id: "e1",
        source: "bulk-1",
        target: "split-1",
        sourceHandle: "right-source",
      },
    ] as ScenarioGraphEdge[];
    const noTemplateRouting = resolveBulkColumnSplitRouting({
      bulkRootId: "bulk-1",
      nodes,
      edges: noTemplateEdges,
    })!;
    expect(
      buildBulkColumnSplitPreview({
        recipients: [],
        routing: noTemplateRouting,
      }).disabledReason
    ).toBe("columnSplitNoTemplate");
  });

  const approvedTemplates = [
    {
      id: "tpl-gold-live",
      name: "gold_offer",
      language: "en",
      status: "APPROVED",
      category: "MARKETING",
      components: [{ type: "BODY", text: "Hello {{1}}" }],
    },
    {
      id: "tpl-silver-live",
      name: "silver_offer",
      language: "en",
      status: "APPROVED",
      category: "UTILITY",
      components: [{ type: "BODY", text: "Hi {{1}}" }],
    },
  ];
  const silverRecipients = [
    {
      phone: "+10000000002",
      fields: { loyalty: "silver", region: "UZ" },
    },
  ];

  it("blocks Send for a blocked template even on a route with no rows", () => {
    // Only silver is in the live catalog → gold resolves as stale. The
    // server checks every connected route (approved_template_missing), so
    // gold blocks Send although no row lands on it.
    const routing = resolveBulkColumnSplitRouting({
      bulkRootId: "bulk-1",
      nodes: makeNodes(),
      edges: makeEdges(),
      whatsAppTemplates: [approvedTemplates[1]] as never,
    })!;
    const preview = buildBulkColumnSplitPreview({
      recipients: silverRecipients,
      routing,
    });
    expect(preview.routes.find(route => route.pathId === "gold")).toMatchObject(
      { recipientCount: 0, templateSendBlockReason: "stale" }
    );
    expect(preview.ready).toBe(false);
    expect(preview.disabledReason).toBe("columnSplitTemplateBlocked");

    const approved = resolveBulkColumnSplitRouting({
      bulkRootId: "bulk-1",
      nodes: makeNodes(),
      edges: makeEdges(),
      whatsAppTemplates: approvedTemplates as never,
    })!;
    expect(
      buildBulkColumnSplitPreview({
        recipients: silverRecipients,
        routing: approved,
      })
    ).toMatchObject({ ready: true, disabledReason: null });
  });

  it.each([
    [
      "a reply step",
      {
        id: "reply-1",
        position: { x: 400, y: 120 },
        data: { kind: "action", actionType: "reply", actionReplyText: "Hi" },
      },
    ],
    [
      "a logic step",
      {
        id: "reply-1",
        position: { x: 400, y: 120 },
        data: { kind: "logic", logicType: "condition" },
      },
    ],
  ])("blocks Send when a route with no rows connects to %s", (_label, step) => {
    // The server refuses the whole send for it (action_message_kind_mismatch
    // or column_split_route_action_invalid).
    const routing = resolveBulkColumnSplitRouting({
      bulkRootId: "bulk-1",
      nodes: [...makeNodes(), step as ScenarioCanvasNode],
      edges: [
        ...makeEdges(),
        {
          id: "e-else",
          source: "split-1",
          target: "reply-1",
          sourceHandle: "right-source-column-split-else",
        } as ScenarioGraphEdge,
      ],
      whatsAppTemplates: approvedTemplates as never,
    })!;
    expect(routing.elseRoute.connectsNonTemplateStep).toBe(true);
    expect(routing.routes.map(route => route.connectsNonTemplateStep)).toEqual([
      false,
      false,
    ]);

    const preview = buildBulkColumnSplitPreview({
      recipients: silverRecipients,
      routing,
    });
    expect(preview.elseCount).toBe(0);
    expect(preview.ready).toBe(false);
    expect(preview.disabledReason).toBe("bulkNodeUploadedRequiresTemplate");
  });

  describe("template catalog state", () => {
    const unloadedRouting = () =>
      resolveBulkColumnSplitRouting({
        bulkRootId: "bulk-1",
        nodes: makeNodes(),
        edges: makeEdges(),
        whatsAppTemplates: [],
      })!;

    it("waits for the catalog instead of calling templates stale before it loads", () => {
      const preview = buildBulkColumnSplitPreview({
        recipients: silverRecipients,
        routing: unloadedRouting(),
      });
      expect(preview.disabledReason).toBe("columnSplitTemplateBlocked");

      const applied = applyBulkColumnSplitTemplateCatalogState(preview, {
        loading: true,
        loaded: false,
        failed: false,
      });
      expect(applied.templateCatalogBlockReason).toBe("loading");
      expect(applied.waitsOnlyForCatalog).toBe(true);
      expect(applied.preview).toMatchObject({
        ready: false,
        disabledReason: "bulkNodeTemplateSendBlockedLoading",
      });
      expect(
        applied.preview.routes.map(route => route.templateSendBlockReason)
      ).toEqual([null, null, null]);
    });

    it("reports a failed first read as catalog_unavailable", () => {
      const applied = applyBulkColumnSplitTemplateCatalogState(
        buildBulkColumnSplitPreview({
          recipients: silverRecipients,
          routing: unloadedRouting(),
        }),
        { loading: false, loaded: false, failed: true }
      );
      expect(applied.templateCatalogBlockReason).toBe("catalog_unavailable");
      expect(applied.waitsOnlyForCatalog).toBe(true);
      expect(applied.preview).toMatchObject({
        ready: false,
        disabledReason: null,
      });
    });

    it("reports a saved catalog that lacks a connected template as catalog_unavailable", () => {
      const routing = resolveBulkColumnSplitRouting({
        bulkRootId: "bulk-1",
        nodes: makeNodes(),
        edges: makeEdges(),
        whatsAppTemplates: [approvedTemplates[1]] as never,
      })!;
      const applied = applyBulkColumnSplitTemplateCatalogState(
        buildBulkColumnSplitPreview({ recipients: silverRecipients, routing }),
        { loading: false, loaded: true, failed: true }
      );
      expect(applied.templateCatalogBlockReason).toBe("catalog_unavailable");
      expect(applied.preview.ready).toBe(false);
    });

    it("leaves a preview alone once the catalog has every connected template", () => {
      const routing = resolveBulkColumnSplitRouting({
        bulkRootId: "bulk-1",
        nodes: makeNodes(),
        edges: makeEdges(),
        whatsAppTemplates: approvedTemplates as never,
      })!;
      const preview = buildBulkColumnSplitPreview({
        recipients: silverRecipients,
        routing,
      });
      for (const catalog of [
        { loading: false, loaded: true, failed: false },
        // A saved catalog that has them approved doesn't block Send.
        { loading: false, loaded: true, failed: true },
      ]) {
        expect(
          applyBulkColumnSplitTemplateCatalogState(preview, catalog)
        ).toEqual({
          preview,
          templateCatalogBlockReason: null,
          waitsOnlyForCatalog: false,
        });
      }
    });

    it("keeps reasons the catalog can't explain", () => {
      const incomplete = structuredClone(makeNodes());
      (
        incomplete[1]!.data as {
          recipientColumnSplit: {
            paths: Array<{ rules: Array<{ column: string }> }>;
          };
        }
      ).recipientColumnSplit.paths[0]!.rules[0]!.column = "";
      const applied = applyBulkColumnSplitTemplateCatalogState(
        buildBulkColumnSplitPreview({
          recipients: silverRecipients,
          routing: resolveBulkColumnSplitRouting({
            bulkRootId: "bulk-1",
            nodes: incomplete,
            edges: makeEdges(),
            whatsAppTemplates: [],
          })!,
        }),
        { loading: true, loaded: false, failed: false }
      );
      expect(applied.preview.disabledReason).toBe(
        "columnSplitConfigIncomplete"
      );
      expect(applied.waitsOnlyForCatalog).toBe(false);

      const pending = makeNodes();
      (
        pending[2]!.data as { generatedTemplateDraft?: unknown }
      ).generatedTemplateDraft = {
        id: "draft-1",
        name: "gold_offer",
        language: "en",
        status: "pending",
      };
      const pendingApplied = applyBulkColumnSplitTemplateCatalogState(
        buildBulkColumnSplitPreview({
          recipients: silverRecipients,
          routing: resolveBulkColumnSplitRouting({
            bulkRootId: "bulk-1",
            nodes: pending,
            edges: makeEdges(),
            whatsAppTemplates: [],
          })!,
        }),
        { loading: true, loaded: false, failed: false }
      );
      expect(pendingApplied.preview.disabledReason).toBe(
        "columnSplitTemplateBlocked"
      );
      expect(pendingApplied.waitsOnlyForCatalog).toBe(false);
      expect(
        pendingApplied.preview.routes.find(route => route.pathId === "gold")
          ?.templateSendBlockReason
      ).toBe("pending_review");
    });
  });
});

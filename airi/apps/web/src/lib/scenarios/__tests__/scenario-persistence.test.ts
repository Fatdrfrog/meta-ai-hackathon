import { normalizeScenarioEntryPolicy } from "@/components/scenarios/types";
import {
  buildWhatsAppSessionChoiceSourceHandleId,
  buildWhatsAppTemplateButtonSourceHandleId,
} from "@icecore/scenario-contracts";
import {
  normalizeScenarioGraphForPersistence,
  normalizeScenarioModeForPersistence,
  normalizeScenarioNodesForPersistence,
} from "@/lib/scenarios/scenario-graph-persistence";
import { serializeScenario } from "@/lib/scenarios/scenario-serialization";
import { WHATSAPP_SERVICE_MESSAGE_INCOMPATIBLE_OWNER_CLEAR_PATCH } from "../whatsapp-service-message";
import {
  normalizeLinkedParentScenarioIds,
  serializeScenarioSummary,
  toScenarioSummary,
} from "../scenario-summary-serialization";

const baseDoc = {
  _id: "507f1f77bcf86cd799439011",
  workspaceId: "workspace-1",
  name: "Scenario",
  description: "",
  status: "active",
  mode: "conversation",
  timezone: null,
  priority: 0,
  presetId: null,
  presetVersion: null,
  segmentKey: null,
  linkedParentScenarioIds: [],
  nodes: [],
  edges: [],
  createdAt: new Date("2026-03-27T00:00:00.000Z"),
  updatedAt: new Date("2026-03-27T00:00:00.000Z"),
};

describe("explicit WhatsApp template bindings", () => {
  it("retains incomplete mappings in a saved draft and after reload", () => {
    const nodes = [
      {
        id: "order-update",
        data: {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "order_update",
          actionWhatsAppTemplateBindings: {
            version: 1,
            parameters: { "body:1": { source: "literal", value: "" } },
          },
        },
      },
    ];
    const persisted = normalizeScenarioNodesForPersistence(nodes);
    expect(persisted).toEqual(nodes);
    expect(
      serializeScenario({ ...baseDoc, status: "draft", nodes: persisted }).nodes
    ).toEqual(persisted);
  });

  it("clears template bindings when switching to a service message", () => {
    expect(
      WHATSAPP_SERVICE_MESSAGE_INCOMPATIBLE_OWNER_CLEAR_PATCH
    ).toHaveProperty("actionWhatsAppTemplateBindings", undefined);
  });
});

describe("template reply-button ids", () => {
  const buttonIds = {
    version: 1,
    nextId: 10,
    buttons: [{ id: 1, index: 0, text: "Premium" }],
  };
  const templateNode = (data: Record<string, unknown>) => ({
    id: "menu",
    data: {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "pick_plan",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Which plan do you want?" },
        {
          type: "BUTTONS",
          buttons: [{ type: "QUICK_REPLY", text: "Premium" }],
        },
      ],
      ...data,
    },
  });
  const persist = (node: ReturnType<typeof templateNode>) =>
    (
      normalizeScenarioNodesForPersistence([node]) as Array<{
        data: Record<string, unknown>;
      }>
    )[0].data;

  it("keeps a template step's button ids through save and reload", () => {
    const nodes = [
      templateNode({ actionWhatsAppTemplateButtonIds: buttonIds }),
    ];
    const persisted = normalizeScenarioNodesForPersistence(nodes);

    expect(persisted).toEqual(nodes);
    expect(
      serializeScenario({ ...baseDoc, status: "draft", nodes: persisted }).nodes
    ).toEqual(nodes);
  });

  it("normalizes readable ids and keeps a map it cannot read as it is", () => {
    expect(
      persist(
        templateNode({
          actionWhatsAppTemplateButtonIds: {
            version: 1,
            nextId: 2,
            buttons: [{ id: 1, index: 0, text: " Premium " }],
          },
        })
      ).actionWhatsAppTemplateButtonIds
    ).toEqual(buttonIds);
    const unreadable = { version: 2, buttons: "from a newer release" };
    expect(
      persist(templateNode({ actionWhatsAppTemplateButtonIds: unreadable }))
        .actionWhatsAppTemplateButtonIds
    ).toEqual(unreadable);
    expect(
      persist(templateNode({ actionWhatsAppTemplateButtonIds: null }))
    ).not.toHaveProperty("actionWhatsAppTemplateButtonIds");
  });

  it("drops the ids when the step stops being a template", () => {
    expect(
      persist(
        templateNode({
          actionType: "reply",
          actionReplyText: "Hello",
          actionWhatsAppTemplateButtonIds: buttonIds,
        })
      )
    ).not.toHaveProperty("actionWhatsAppTemplateButtonIds");
    expect(
      WHATSAPP_SERVICE_MESSAGE_INCOMPATIBLE_OWNER_CLEAR_PATCH
    ).toHaveProperty("actionWhatsAppTemplateButtonIds", undefined);
  });
});

describe("template saved form", () => {
  const savedForm = {
    version: 1,
    flowId: "2244981489363579",
    flowName: "demoshop_ai_case",
    answersKey: "demoshop_ai_case",
    digest: "a".repeat(64),
    coverage: "complete",
    endpoint: false,
    readAt: "2026-10-04T08:00:00.000Z",
    fields: [
      {
        responseKey: "_68d224",
        label: "Athlete's name",
        description: "Write every name",
        fieldType: "TextInput",
        required: true,
        screenIndex: 1,
        options: [],
      },
    ],
  };
  const templateNode = (data: Record<string, unknown>) => ({
    id: "medal",
    data: {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "medal_pick_1",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Pick your medal" },
        {
          type: "BUTTONS",
          buttons: [
            { type: "FLOW", text: "Choose", flow_id: 2244981489363579 },
          ],
        },
      ],
      ...data,
    },
  });
  const persist = (node: ReturnType<typeof templateNode>) =>
    (
      normalizeScenarioNodesForPersistence([node]) as Array<{
        data: Record<string, unknown>;
      }>
    )[0].data;

  it("keeps a template step's saved form through save and reload", () => {
    const nodes = [templateNode({ actionWhatsAppTemplateForm: savedForm })];
    const persisted = normalizeScenarioNodesForPersistence(nodes);

    expect(persisted).toEqual(nodes);
    expect(
      serializeScenario({ ...baseDoc, status: "draft", nodes: persisted }).nodes
    ).toEqual(nodes);
  });

  it("normalizes a readable form and keeps a form it cannot read as it is", () => {
    expect(
      persist(
        templateNode({
          actionWhatsAppTemplateForm: {
            ...savedForm,
            flowId: " 2244981489363579 ",
            fields: [
              ...savedForm.fields,
              { responseKey: "photo", fieldType: "PhotoPicker" },
            ],
          },
        })
      ).actionWhatsAppTemplateForm
    ).toEqual(savedForm);
    const unreadable = { version: 2, fields: "from a newer release" };
    expect(
      persist(templateNode({ actionWhatsAppTemplateForm: unreadable }))
        .actionWhatsAppTemplateForm
    ).toBe(unreadable);
    expect(
      persist(templateNode({ actionWhatsAppTemplateForm: null }))
    ).not.toHaveProperty("actionWhatsAppTemplateForm");
  });

  it("drops the saved form when the step stops being a template", () => {
    for (const data of [
      { actionType: "reply", actionReplyText: "Hello" },
      {
        actionType: "generative_ai",
        actionGenerativeAIConfig: {
          version: 1,
          mode: "text_to_image",
          prompt: "A medal",
        },
      },
    ]) {
      expect(
        persist(
          templateNode({ ...data, actionWhatsAppTemplateForm: savedForm })
        )
      ).not.toHaveProperty("actionWhatsAppTemplateForm");
    }
    expect(
      WHATSAPP_SERVICE_MESSAGE_INCOMPATIBLE_OWNER_CLEAR_PATCH
    ).toHaveProperty("actionWhatsAppTemplateForm", undefined);
    expect(
      persist(
        templateNode({
          actionWhatsAppTemplateForm: savedForm,
          actionWhatsAppServiceMessage: {
            version: 1,
            message: { kind: "text", body: { mode: "fixed", text: "Hi" } },
          },
        })
      )
    ).not.toHaveProperty("actionWhatsAppTemplateForm");
  });
});

describe("delayed CTA follow-up persistence", () => {
  const helpHandle = buildWhatsAppSessionChoiceSourceHandleId("wsc:menu:help");
  const buttonHandle = buildWhatsAppTemplateButtonSourceHandleId(0);
  const delayedOutcomes = {
    version: 1,
    noReply: { enabled: true, timeoutMinutes: 30 },
    branchDelays: [
      {
        sourceHandle: ` ${helpHandle} `,
        delayMinutes: 60,
        cancelIfPhrases: ["  Order   accepted ", "Order accepted"],
      },
      { sourceHandle: helpHandle, delayMinutes: 5 },
      { sourceHandle: buttonHandle, delayMinutes: 0 },
    ],
  };
  const normalizedDelays = [
    {
      sourceHandle: helpHandle,
      delayMinutes: 60,
      cancelIfPhrases: ["Order accepted"],
    },
  ];

  it("round-trips normalized delays on a regular action", () => {
    const [persisted] = normalizeScenarioNodesForPersistence([
      {
        id: "menu",
        data: {
          kind: "action",
          actionType: "reply",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "reply_buttons",
              body: { mode: "fixed", text: "Choose" },
              options: [{ id: "wsc:menu:help", label: "Help" }],
            },
          },
          actionOutcomes: delayedOutcomes,
        },
      },
    ]) as Array<{ data: Record<string, unknown> }>;

    expect(persisted.data.actionOutcomes).toEqual({
      version: 1,
      noReply: { enabled: true, timeoutMinutes: 30 },
      branchDelays: normalizedDelays,
    });
    expect(normalizeScenarioNodesForPersistence([persisted])).toEqual([
      persisted,
    ]);
    expect(
      serializeScenario({ ...baseDoc, nodes: [persisted] }).nodes[0]
    ).toMatchObject({
      data: { actionOutcomes: { branchDelays: normalizedDelays } },
    });
  });

  it.each(["generative_ai", "end_scenario"])(
    "still drops outcomes from %s actions",
    actionType => {
      const [persisted] = normalizeScenarioNodesForPersistence([
        {
          id: "action",
          data: { kind: "action", actionType, actionOutcomes: delayedOutcomes },
        },
      ]) as Array<{ data: Record<string, unknown> }>;

      expect(persisted.data).not.toHaveProperty("actionOutcomes");
    }
  );
});

describe("unfinished handoff notification targets", () => {
  it.each([
    { actionHandoffNotifyEmail: "name@" },
    { actionHandoffNotifyWhatsapp: "+" },
  ])("retains a partial target across persistence and reload: %j", target => {
    const nodes = [
      {
        id: "handoff",
        data: { kind: "action", actionType: "assign_human", ...target },
      },
    ];
    const persisted = normalizeScenarioNodesForPersistence(nodes);

    expect(persisted).toEqual(nodes);
    expect(
      serializeScenario({ ...baseDoc, status: "draft", nodes: persisted }).nodes
    ).toEqual(nodes);
  });

  it("continues normalizing complete handoff targets", () => {
    expect(
      normalizeScenarioNodesForPersistence([
        {
          id: "handoff",
          data: {
            kind: "action",
            actionType: "assign_human",
            actionHandoffNotifyEmail: " NAME@EXAMPLE.COM ",
            actionHandoffNotifyWhatsapp: "+7 (701) 123-45-67",
          },
        },
      ])
    ).toEqual([
      {
        id: "handoff",
        data: {
          kind: "action",
          actionType: "assign_human",
          actionHandoffNotifyEmail: "name@example.com",
          actionHandoffNotifyWhatsapp: "77011234567",
        },
      },
    ]);
  });
});

describe("scenario mode persistence", () => {
  it("removes a stale campaign mode from a client-message graph", () => {
    expect(
      normalizeScenarioModeForPersistence("bulk_campaign", [
        { data: { kind: "trigger" } },
        { data: { kind: "action" } },
      ])
    ).toBe("conversation");
  });

  it.each(["conversation", "bulk_campaign"])(
    "preserves %s for graphs that still contain a bulk root",
    mode => {
      expect(
        normalizeScenarioModeForPersistence(mode, [
          { data: { kind: "trigger" } },
          {
            data: {
              kind: "bulk",
              bulkRootConfig: { workflowKind: "bulk_campaign" },
            },
          },
        ])
      ).toBe(mode);
    }
  );

  it.each([
    { name: "empty graph", nodes: [] },
    { name: "action without a root", nodes: [{ data: { kind: "action" } }] },
  ])("preserves a campaign draft with $name", ({ nodes }) => {
    expect(normalizeScenarioModeForPersistence("bulk_campaign", nodes)).toBe(
      "bulk_campaign"
    );
  });

  it("uses the canonical default for an unspecified mode", () => {
    expect(normalizeScenarioModeForPersistence(undefined, [])).toBe(
      "conversation"
    );
  });
});

describe("scenario API serialization", () => {
  it.each([
    { nodes: {} },
    { nodes: [null] },
    { nodes: [{ id: "broken" }] },
    { edges: [null] },
  ])(
    "fails clearly for a malformed persisted graph instead of emitting an empty document: %j",
    graph => {
      expect(() => serializeScenario({ ...baseDoc, ...graph })).toThrow(
        "Invalid persisted scenario graph"
      );
    }
  );

  it("defaults an omitted entry policy to once per conversation", () => {
    expect(normalizeScenarioEntryPolicy(undefined)).toBe(
      "once_per_conversation"
    );
  });

  it("normalizes missing matchingRole to default in summaries", () => {
    expect(serializeScenarioSummary(baseDoc as never).matchingRole).toBe(
      "default"
    );
  });

  it("prefers projected node and edge counts over loading graph arrays", () => {
    const serialized = serializeScenarioSummary({
      ...baseDoc,
      nodeCount: 4,
      edgeCount: 7,
      nodes: [{ id: "trigger-1" }],
      edges: [],
    } as never);

    expect(serialized.nodeCount).toBe(4);
    expect(serialized.edgeCount).toBe(7);
  });

  it("serializes canonical scenario DTOs without top-level Flow ownership", () => {
    const serialized = serializeScenario({
      ...baseDoc,
      sourceType: "whatsapp_flow",
      flowConfig: { templateId: "legacy-flow" },
      matchingRole: "fallback",
    } as never);

    expect(serialized.matchingRole).toBe("fallback");
    expect(serialized).not.toHaveProperty("sourceType");
    expect(serialized).not.toHaveProperty("flowConfig");
  });

  it("canonicalizes retired trigger nodes while reading documents", () => {
    const serialized = serializeScenario({
      ...baseDoc,
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerType: "payment_detected",
            triggerConfig: {
              enabled: true,
              paymentDetection: { phrases: ["paid"] },
            },
          },
        },
      ],
    } as never);

    expect(serialized.nodes).toEqual([
      expect.objectContaining({
        id: "trigger-1",
        data: expect.objectContaining({
          kind: "trigger",
          triggerConfig: {
            enabled: false,
            keywordMatchMode: "contains",
            messageMatchMode: "any",
          },
        }),
      }),
    ]);
    expect(serialized.graphSchemaVersion).toBe(1);
  });

  it("serializes only the canonical entry policy", () => {
    const serialized = serializeScenario({
      ...baseDoc,
      entryPolicy: "repeatable",
      loopScenario: false,
      journeyPoolKey: "product_entry",
    } as never);

    expect(serialized.entryPolicy).toBe("repeatable");
    expect(serialized).not.toHaveProperty("loopScenario");
    expect(serialized).not.toHaveProperty("journeyPoolKey");
  });

  it("preserves nested server-owned Flow projections while serializing stored graphs", () => {
    const managedProvisioning = {
      operationId: "operation-1",
      sourceId: "source-1",
      contentRevision: 1,
      contentDigest: "a".repeat(64),
      flowId: "provider-flow-1",
      providerStatus: "PUBLISHED",
    };
    const serialized = serializeScenario({
      ...baseDoc,
      nodes: [
        {
          id: "action-1",
          data: {
            kind: "action",
            actionType: "whatsapp_template",
            actionFlowConfig: {
              templateId: "local-flow-1",
              ctaText: "Open",
              screens: [],
              managedProvisioning,
            },
          },
        },
        {
          id: "action-2",
          data: {
            kind: "action",
            actionType: "reply",
            actionWhatsAppServiceMessage: {
              version: 1,
              message: {
                kind: "flow",
                body: { mode: "fixed", text: "Open" },
                flowConfig: {
                  templateId: "local-flow-2",
                  ctaText: "Continue",
                  screens: [],
                  managedProvisioning,
                },
              },
            },
          },
        },
      ],
    } as never);

    expect(
      (
        serialized.nodes[0] as {
          data: {
            actionFlowConfig: {
              managedProvisioning: unknown;
            };
          };
        }
      ).data.actionFlowConfig.managedProvisioning
    ).toEqual(managedProvisioning);
    expect(
      (
        serialized.nodes[1] as {
          data: {
            actionWhatsAppServiceMessage: {
              message: {
                flowConfig: {
                  managedProvisioning: unknown;
                };
              };
            };
          };
        }
      ).data.actionWhatsAppServiceMessage.message.flowConfig.managedProvisioning
    ).toEqual(managedProvisioning);
  });

  it("keeps legacy loop-only documents repeatable without exposing the field", () => {
    const serialized = serializeScenario({
      ...baseDoc,
      loopScenario: true,
    } as never);

    expect(serialized.entryPolicy).toBe("repeatable");
    expect(serialized).not.toHaveProperty("loopScenario");
  });

  it("keeps list serialization aligned with document summaries", () => {
    const doc = {
      ...baseDoc,
      linkedParentScenarioIds: ["parent-1", "parent-2"],
    };
    expect(toScenarioSummary(doc as never)).toEqual(
      serializeScenarioSummary(doc as never)
    );
    expect(normalizeLinkedParentScenarioIds(["a", "", "  ", 1, "b"])).toEqual([
      "a",
      "b",
    ]);
    expect(normalizeLinkedParentScenarioIds(null)).toEqual([]);
  });
});

describe("scenario node persistence normalization", () => {
  it("round-trips a merchant image recipe with durable reference ownership", () => {
    const image = {
      provider: "google", sourceId: "11111111-1111-4111-8111-111111111111",
      modelId: "gemini-3.1-flash-image", aspectRatio: "21:9", includeInboundText: true,
      referenceImages: [{ url: "https://signed.example/preview", mediaType: "image", mimeType: "image/png", fileSize: 20, bucket: "media", path: "workspaces/w1/creative-assets/image/scenario-1/medal.png" }],
    };
    const [node] = normalizeScenarioNodesForPersistence([{ id: "medal", data: {
      kind: "action", actionType: "generative_ai",
      actionGenerativeAIConfig: { version: 1, mode: "text_to_image", prompt: "Keep shape. Use {{trigger.message.text}}.", image },
    } }]) as Array<{ data: Record<string, unknown> }>;
    expect(node.data.actionGenerativeAIConfig).toEqual({
      version: 1, mode: "text_to_image", prompt: "Keep shape. Use {{trigger.message.text}}.",
      image: { ...image, referenceImages: [{ ...image.referenceImages[0], url: "gcs://media/workspaces/w1/creative-assets/image/scenario-1/medal.png" }] },
    });
    const saved = serializeScenario({ ...baseDoc, nodes: [node], edges: [] });
    expect(saved.nodes).toEqual([node]);
  });
  it.each([
    ["a model removed from the catalog", { modelId: "gemini-retired-image" }],
    [
      "more references than the model accepts",
      {
        referenceImages: Array(4).fill({
          url: "gcs://media/workspaces/w1/creative-assets/image/scenario-1/medal.png",
          mediaType: "image",
          mimeType: "image/png",
          fileSize: 20,
          bucket: "media",
          path: "workspaces/w1/creative-assets/image/scenario-1/medal.png",
        }),
      },
    ],
  ])(
    "keeps the prompt and image settings of a draft with %s",
    (_label, change) => {
      const config = {
        version: 1,
        mode: "text_to_image",
        prompt: "Keep the holder shape. Name: {{input.name}}",
        image: {
          provider: "google",
          sourceId: "11111111-1111-4111-8111-111111111111",
          modelId: "gemini-3.1-flash-image",
          aspectRatio: "21:9",
          includeInboundText: false,
          referenceImages: [],
          ...change,
        },
      };
      const [node] = normalizeScenarioNodesForPersistence([
        {
          id: "medal",
          data: {
            kind: "action",
            actionType: "generative_ai",
            actionGenerativeAIConfig: config,
          },
        },
      ]) as Array<{ data: Record<string, unknown> }>;

      expect(node.data.actionGenerativeAIConfig).toEqual(config);
    }
  );

  it("preserves an unfinished Generative AI draft through serialization", () => {
    const config = { version: 1, mode: "image_to_video", prompt: "" };
    const serialized = serializeScenario({
      ...baseDoc,
      nodes: [
        {
          id: "generate",
          data: {
            kind: "action",
            actionType: "generative_ai",
            actionGenerativeAIConfig: config,
          },
        },
      ],
      edges: [],
    });
    expect(serialized.nodes).toEqual([
      {
        id: "generate",
        data: {
          kind: "action",
          actionType: "generative_ai",
          actionGenerativeAIConfig: config,
        },
      },
    ]);
  });

  it.each([
    {
      actionReplyChannel: "instagram",
      actionInstagramConfig: { kind: "button_template", buttons: [] },
    },
    { actionReplyChannel: "telegram", actionTelegramQuickReplies: [] },
  ])("preserves an empty channel builder draft: %j", draft => {
    expect(
      normalizeScenarioNodesForPersistence([
        {
          id: "reply",
          data: { kind: "action", actionType: "reply", ...draft },
        },
      ])
    ).toEqual([
      {
        id: "reply",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          ...draft,
        },
      },
    ]);
  });

  it("persists only the canonical Generative AI action contract", () => {
    const [node] = normalizeScenarioNodesForPersistence([
      {
        id: "generate-video",
        data: {
          kind: "action",
          actionType: "generative_ai",
          actionGenerativeAIConfig: {
            version: 1,
            mode: "text_to_video",
            prompt: "  Make a launch video\r\nwith neon light  ",
            provider: "client-controlled",
            model: "client-controlled",
            duration: 99,
            resolution: "4K",
          },
          actionReplyText: "stale reply",
          actionWhatsAppTemplateId: "stale-template",
        },
      },
    ]) as Array<{ data: Record<string, unknown> }>;

    expect(node.data).toMatchObject({
      actionType: "generative_ai",
      actionGenerativeAIConfig: {
        version: 1,
        mode: "text_to_video",
        prompt: "Make a launch video\nwith neon light",
      },
    });
    expect(node.data.actionGenerativeAIConfig).toEqual({
      version: 1,
      mode: "text_to_video",
      prompt: "Make a launch video\nwith neon light",
    });
    expect(node.data).not.toHaveProperty("actionReplyText");
    expect(node.data).not.toHaveProperty("actionWhatsAppTemplateId");
  });

  it.each([
    { version: 1, mode: "text_to_image", prompt: "Unsupported" },
    { version: 1, mode: "audio", prompt: "Unsupported" },
    { version: 2, mode: "text_to_video", prompt: "Future" },
  ])(
    "does not persist malformed or disabled Generative AI config %#",
    config => {
      const [node] = normalizeScenarioNodesForPersistence([
        {
          id: "generate-video",
          data: {
            kind: "action",
            actionType: "generative_ai",
            actionGenerativeAIConfig: config,
          },
        },
      ]) as Array<{ data: Record<string, unknown> }>;

      expect(node.data.actionType).toBe("generative_ai");
      expect(node.data).not.toHaveProperty("actionGenerativeAIConfig");
    }
  );

  it("removes Generative AI ownership from ordinary actions", () => {
    const [node] = normalizeScenarioNodesForPersistence([
      {
        id: "reply",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyText: "Hello",
          actionGenerativeAIConfig: {
            version: 1,
            mode: "text_to_video",
            prompt: "stale",
          },
        },
      },
    ]) as Array<{ data: Record<string, unknown> }>;

    expect(node.data.actionReplyText).toBe("Hello");
    expect(node.data).not.toHaveProperty("actionGenerativeAIConfig");
  });

  it("omits editor enrichment from canonical graph writes", () => {
    const [node] = normalizeScenarioNodesForPersistence([
      {
        id: "action-1",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyText: "Hello",
          uiNodeLabel: "Rendered label",
          uiActionType: "whatsapp_service_message",
          uiContextItems: [{ id: "snippet-1", label: "Fetched snippet" }],
          uiConnectedColumnSplitHandleIds: ["right-source-path_1"],
          actionPreviewText: "Rendered preview",
          actionPreviewImageUrl: "https://cdn.test/preview.png",
        },
      },
    ]) as Array<{ data: Record<string, unknown> }>;

    expect(node.data).toEqual({
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: "Hello",
    });
  });

  it("drops unknown top-level action keys instead of persisting them", () => {
    const [node] = normalizeScenarioNodesForPersistence([
      {
        id: "action-1",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyText: "Hello",
          actionOtpCode: "123456",
        },
      },
    ]) as Array<{ data: Record<string, unknown> }>;

    expect(node.data).toEqual({
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: "Hello",
    });
    expect(node.data).not.toHaveProperty("actionOtpCode");
  });

  it("omits persisted editor enrichment from canonical graph responses", () => {
    const serialized = serializeScenario({
      ...baseDoc,
      nodes: [
        {
          id: "action-1",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyText: "Hello",
            uiNodeLabel: "Rendered label",
            uiActionType: "whatsapp_service_message",
            uiContextItems: [{ id: "snippet-1", label: "Fetched snippet" }],
            uiConnectedColumnSplitHandleIds: ["right-source-path_1"],
            actionPreviewText: "Rendered preview",
            actionPreviewImageUrl: "https://cdn.test/preview.png",
          },
        },
      ],
    } as never);

    const serializedNode = serialized.nodes[0] as
      | { data: Record<string, unknown> }
      | undefined;
    expect(serializedNode?.data).toEqual({
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: "Hello",
    });
  });

  it("normalizes graph writes to the current version and canonical trigger nodes", () => {
    expect(
      normalizeScenarioGraphForPersistence({
        graphSchemaVersion: 1,
        nodes: [
          {
            id: "trigger-1",
            data: {
              kind: "trigger",
              triggerType: "customer_message_contains",
              triggerConfig: {
                enabled: true,
                channelFilter: [" whatsapp ", "whatsapp"],
                keywordPattern: "refund",
              },
            },
          },
        ],
        edges: [{ id: "edge-1", source: "trigger-1", target: "action-1" }],
      })
    ).toEqual({
      graphSchemaVersion: 1,
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerConfig: {
              enabled: true,
              messageMatchMode: "contains",
              keywordMatchMode: "contains",
              channelFilter: ["whatsapp"],
              keywordPattern: "refund",
            },
          },
        },
      ],
      edges: [{ id: "edge-1", source: "trigger-1", target: "action-1" }],
    });
  });

  it("keeps the node-only compatibility wrapper aligned with the graph owner", () => {
    const nodes = [
      {
        id: "trigger-1",
        data: {
          kind: "trigger",
          triggerType: "payment_detected",
          triggerConfig: { enabled: true },
        },
      },
    ];

    expect(normalizeScenarioNodesForPersistence(nodes)).toEqual(
      normalizeScenarioGraphForPersistence({ nodes, edges: [] }).nodes
    );
  });

  it("persists legacy top-level triggers as client-message triggers without retired fields", () => {
    const [node] = normalizeScenarioNodesForPersistence([
      {
        id: "trigger-1",
        data: {
          kind: "trigger",
          triggerType: "business_hours_window",
          triggerConfig: {
            enabled: true,
            channelFilter: ["whatsapp"],
            keywordPattern: "keep me",
            businessHoursTimezone: "Asia/Almaty",
            businessHoursDays: [1, 2, 3],
            businessHoursStartMinute: 540,
            businessHoursEndMinute: 1080,
            classificationCategories: ["sales"],
            paymentDetection: { phrases: ["paid"] },
          },
        },
      },
    ]) as Array<{ data: Record<string, unknown> }>;

    expect(node.data).not.toHaveProperty("triggerType");
    const triggerConfig = node.data.triggerConfig as Record<string, unknown>;
    expect(triggerConfig).toEqual(
      expect.objectContaining({
        enabled: false,
        channelFilter: ["whatsapp"],
        keywordPattern: "keep me",
        messageMatchMode: "any",
      })
    );
    expect(triggerConfig).not.toHaveProperty("businessHoursTimezone");
    expect(triggerConfig).not.toHaveProperty("businessHoursDays");
    expect(triggerConfig).not.toHaveProperty("businessHoursStartMinute");
    expect(triggerConfig).not.toHaveProperty("businessHoursEndMinute");
    expect(triggerConfig).not.toHaveProperty("classificationCategories");
    expect(triggerConfig).not.toHaveProperty("paymentDetection");
  });

  it.each([
    {
      version: 1,
      message: { kind: "text", body: { mode: "fixed", text: "Canonical" } },
    },
    { version: 7, message: { kind: "future_format" } },
    null,
  ])(
    "preserves raw canonical payloads and clears incompatible owners",
    value => {
      const staleOwners = Object.fromEntries(
        Object.keys(
          WHATSAPP_SERVICE_MESSAGE_INCOMPATIBLE_OWNER_CLEAR_PATCH
        ).map(key => [key, `stale:${key}`])
      );
      const [node] = normalizeScenarioNodesForPersistence([
        {
          id: "action-1",
          data: {
            kind: "action",
            actionType: "whatsapp_template",
            ...staleOwners,
            actionWhatsAppServiceMessage: value,
          },
        },
      ]) as Array<{ data: Record<string, unknown> }>;

      expect(node.data.actionType).toBe("reply");
      expect(node.data.actionWhatsAppServiceMessage).toEqual(value);
      for (const key of Object.keys(
        WHATSAPP_SERVICE_MESSAGE_INCOMPATIBLE_OWNER_CLEAR_PATCH
      )) {
        expect(node.data).not.toHaveProperty(key);
      }
    }
  );

  it("persists only current WhatsApp fields for unresolved action owners", () => {
    const [node] = normalizeScenarioNodesForPersistence([
      {
        id: "action-1",
        data: {
          kind: "action",
          actionType: "unsupported_owner",
          actionReplyText: "stale reply",
          actionFlowConfig: { templateId: "stale-flow" },
          actionWhatsAppUnknownOwner: { stale: true },
          actionWhatsAppTemplateId: "stale-template",
        },
      },
    ]) as Array<{ data: Record<string, unknown> }>;

    expect(node.data).not.toHaveProperty("actionType");
    expect(node.data).not.toHaveProperty("actionReplyText");
    expect(node.data).not.toHaveProperty("actionFlowConfig");
    expect(node.data).not.toHaveProperty("actionWhatsAppUnknownOwner");
    expect(node.data).not.toHaveProperty("actionWhatsAppTemplateId");
  });

  it("keeps template-linked Flows owned by WhatsApp template actions", () => {
    const actionFlowConfig = { templateId: "template-flow", screens: [] };
    const [node] = normalizeScenarioNodesForPersistence([
      {
        id: "template-action",
        data: {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateId: "template-1",
          actionFlowConfig,
          actionReplyText: "stale reply",
        },
      },
    ]) as Array<{ data: Record<string, unknown> }>;

    expect(node.data).toMatchObject({
      actionType: "whatsapp_template",
      actionWhatsAppTemplateId: "template-1",
      actionFlowConfig,
    });
    expect(node.data).not.toHaveProperty("actionReplyText");
  });

  it("preserves ordinary Telegram and Instagram reply normalization", () => {
    const [telegram, instagram] = normalizeScenarioNodesForPersistence([
      {
        id: "telegram",
        data: {
          kind: "action",
          actionType: "reply",
          actionTelegramQuickReplies: [[{ text: "Yes", payload: "yes" }]],
        },
      },
      {
        id: "instagram",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyChannel: "instagram",
          actionInstagramConfig: {
            kind: "quick_replies",
            quickReplies: [{ title: "Pricing", payload: "pricing" }],
          },
        },
      },
    ]) as Array<{ data: Record<string, unknown> }>;

    expect(telegram.data.actionReplyChannel).toBe("telegram");
    expect(instagram.data.actionInstagramConfig).toEqual({
      kind: "quick_replies",
      quickReplies: [{ title: "Pricing", payload: "pricing" }],
    });
  });
});

import { compileScenarioGraph } from "@icecore/airi-runtime/scenario-graph";
import {
  buildWhatsAppTemplateButtonPayload,
  getPostActionConditionHandleId,
  getScenarioActionOutcomeVirtualNodeId,
  SCENARIO_TRIGGER_EVENT_KIND,
} from "@icecore/scenario-contracts";
import { validateScenarioGraph } from "@/lib/scenarios/graph-validation";
import { hasNewLegacyActionRoutingAssignments } from "@/lib/scenarios/legacy-action-routing";
import { resolveScenarioDispatchTransition } from "@/lib/airi/scenario/scenario-post-action-routing";
import { evaluateScenarioFlow } from "@/lib/airi/scenario/scenario-interactive-replies";
import { projectActiveClientMessageFilters } from "@/lib/scenarios/client-message-trigger-criteria";
import {
  matchesIncomingMessageTrigger,
  projectScenarioIngressContext,
} from "@/lib/scenarios/incoming-message-trigger-matcher";
import {
  buildRevenuePlaybookSeed,
  isRevenuePlaybookPresetId,
  isRevenuePlaybookTemplateSupported,
  RevenuePlaybookValidationError,
  type RevenuePlaybookConfig,
} from "./scenario-revenue-playbooks";

const config: RevenuePlaybookConfig = {
  goal: "unpaid_recovery",
  name: "Payment follow-up",
  openingText:
    "Use your agreed payment instructions. Our team confirms payment.",
  reminderText: "Still interested? Reply if you need help.",
  reminderMinutes: 60,
  successText: "Our team confirmed your payment. Thank you!",
  handoffText: "A team member will help you.",
  triggerKeyword: "order 24",
};

const bulkConfig: RevenuePlaybookConfig = {
  ...config,
  goal: "repeat_purchase",
  sourceId: "source-1",
  recipients: ["+7 701 123 4567", "87011234567"],
  templateReplyButtonIndex: 1,
  template: {
    id: "template-1",
    name: "repeat_offer",
    language: "ru",
    status: "APPROVED",
    category: "MARKETING",
    components: [
      { type: "BODY", text: "Would you like to reorder?" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "No thanks" },
          { type: "QUICK_REPLY", text: "Show offer" },
        ],
      },
    ],
  },
};

type Seed = ReturnType<typeof buildRevenuePlaybookSeed>;
function roleNode(seed: Seed, role: string) {
  return seed.initialFlow.nodes.find(node => node.id.endsWith(`-${role}`))!;
}

describe("revenue playbook seeds", () => {
  it("creates a deterministic, runnable unpaid recovery graph without legacy routing", () => {
    const seed = buildRevenuePlaybookSeed(config);
    const anotherSeed = buildRevenuePlaybookSeed(config);
    expect(seed.initialFlow.nodes.map(node => node.data)).toEqual(
      anotherSeed.initialFlow.nodes.map(node => node.data)
    );
    expect(
      new Set(
        [...seed.initialFlow.nodes, ...anotherSeed.initialFlow.nodes].map(
          node => node.id
        )
      ).size
    ).toBe(seed.initialFlow.nodes.length * 2);
    expect(isRevenuePlaybookPresetId(seed.presetId)).toBe(true);
    expect(seed.presetVersion).toBe("1");
    expect(seed.segmentKey).toBe("sales_qualified");
    expect(
      validateScenarioGraph(seed.initialFlow.nodes, seed.initialFlow.edges, {
        mode: "runnable",
      })
    ).toBeNull();
    expect(
      hasNewLegacyActionRoutingAssignments({
        previousNodes: [],
        previousEdges: [],
        nextNodes: seed.initialFlow.nodes,
        nextEdges: seed.initialFlow.edges,
      })
    ).toBe(false);
    expect(
      seed.initialFlow.nodes.find(node => node.data.kind === "trigger")?.data
        .triggerConfig
    ).toMatchObject({
      channelFilter: ["whatsapp"],
      messageMatchMode: "exact",
      keywordPattern: config.triggerKeyword,
    });
    expect(
      seed.initialFlow.nodes.some(node => node.data.kind === "logic")
    ).toBe(false);
  });

  it("compiles the payment outcome into the exact wait consumed by confirmed-sale tracking", () => {
    const seed = buildRevenuePlaybookSeed(config);
    const graph = compileScenarioGraph(
      seed.initialFlow.nodes,
      seed.initialFlow.edges
    );
    const paymentAction = graph.nodesById.get(
      roleNode(seed, "revenue-offer").id
    )!;
    const transition = resolveScenarioDispatchTransition({
      graph,
      selectedAction: paymentAction,
      selectedActionType: "reply",
      conversation: { _id: "conversation" } as never,
      channel: "whatsapp",
    });
    expect(graph.diagnostics).toEqual([]);
    expect(transition.pendingConditionNodeId).toBe(
      getScenarioActionOutcomeVirtualNodeId(paymentAction.id)
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: transition.pendingConditionNodeId,
        sourceHandle: getPostActionConditionHandleId("payment_detected"),
        target: roleNode(seed, "revenue-success").id,
      })
    );
    expect(
      graph.nodesById.get(transition.pendingConditionNodeId!)?.data
    ).toMatchObject({ kind: "logic", logicType: "post_action_condition" });
  });

  it("matches the configured unpaid keyword exactly through the canonical trigger matcher", () => {
    const seed = buildRevenuePlaybookSeed(config);
    const trigger = seed.initialFlow.nodes.find(
      node => node.data.kind === "trigger"
    )!;
    const criteria = projectActiveClientMessageFilters(
      trigger.data.triggerConfig
    );
    const matches = (messageText: string) =>
      matchesIncomingMessageTrigger(
        criteria,
        projectScenarioIngressContext({
          eventKind: SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
          channel: "whatsapp",
          messageText,
        })
      );
    expect(matches("ORDER 24")).toBe(true);
    expect(matches("Please use order 24")).toBe(false);
    expect(matches("order 240")).toBe(false);
  });

  it("creates ad qualification followed by a booking link with fixed messages", () => {
    const seed = buildRevenuePlaybookSeed({
      ...config,
      goal: "ad_consultation",
      qualificationQuestion: "What service do you need?",
      bookingUrl: "https://example.com/book",
      bookingButtonLabel: "Book a time",
    });
    expect(seed.segmentKey).toBe("lead_generation");
    expect(
      seed.initialFlow.nodes.find(node => node.data.kind === "trigger")?.data
        .triggerConfig
    ).toMatchObject({
      channelFilter: ["whatsapp"],
      whatsappReferralSourceTypes: ["ad"],
      messageMatchMode: "any",
    });
    expect(
      roleNode(seed, "revenue-qualification")?.data.actionWhatsAppServiceMessage
        ?.message
    ).toMatchObject({
      kind: "text",
      body: { mode: "fixed", text: "What service do you need?" },
    });
    expect(
      roleNode(seed, "revenue-offer")?.data.actionWhatsAppServiceMessage
        ?.message
    ).toMatchObject({
      kind: "cta_url",
      body: { mode: "fixed", text: config.openingText },
      urlSource: { kind: "fixed", url: "https://example.com/book" },
    });
    expect(
      validateScenarioGraph(seed.initialFlow.nodes, seed.initialFlow.edges, {
        mode: "runnable",
      })
    ).toBeNull();
  });

  it("offers a single reminder and leaves confirmed payment connected after that reminder", () => {
    const seed = buildRevenuePlaybookSeed(config);
    const timedActions = seed.initialFlow.nodes.filter(
      node => node.data.actionOutcomes?.noReply?.enabled
    );
    expect(timedActions.map(node => node.id)).toEqual([
      roleNode(seed, "revenue-offer").id,
    ]);
    const reminder = roleNode(seed, "revenue-reminder");
    expect(reminder.data.actionOutcomes).toEqual({
      version: 1,
      anyReply: { enabled: true },
      paymentDetected: { enabled: true },
    });
    expect(roleNode(seed, "revenue-handoff")?.data).toMatchObject({
      actionType: "assign_human",
      actionInstruction: config.handoffText,
    });
  });

  it.each(["repeat_purchase", "service_reactivation"] as const)(
    "builds %s from explicit recipients and an approved template",
    goal => {
      const seed = buildRevenuePlaybookSeed({
        ...bulkConfig,
        goal,
        bookingUrl: "https://example.com/book",
        bookingButtonLabel: "Book",
      });
      expect(
        validateScenarioGraph(seed.initialFlow.nodes, seed.initialFlow.edges, {
          mode: "runnable",
        })
      ).toBeNull();
      const root = seed.initialFlow.nodes.find(
        node => node.data.kind === "bulk"
      )!;
      expect(root.data.bulkRootConfig).toMatchObject({
        recipientAudienceSource: "uploaded",
        sourceIds: ["source-1"],
        uploadedRecipients: [{ phone: "77011234567", sourceId: "source-1" }],
        sendMode: "immediate",
      });
      expect(root.data.bulkRootConfig).not.toHaveProperty("scheduleConfig");
      expect(
        seed.initialFlow.nodes.some(
          node => node.data.kind === "trigger" || node.data.actionRunConditions
        )
      ).toBe(false);
      expect(
        roleNode(seed, "revenue-template")?.data.actionOutcomes
      ).toBeUndefined();
      expect(
        hasNewLegacyActionRoutingAssignments({
          previousNodes: [],
          previousEdges: [],
          nextNodes: seed.initialFlow.nodes,
          nextEdges: seed.initialFlow.edges,
        })
      ).toBe(false);
    }
  );

  it.each([
    [1, "revenue-offer"],
    [0, "revenue-handoff"],
  ] as const)(
    "routes template reply button %s to %s using the existing runtime",
    (buttonIndex, targetId) => {
      const seed = buildRevenuePlaybookSeed(bulkConfig);
      const graph = compileScenarioGraph(
        seed.initialFlow.nodes,
        seed.initialFlow.edges
      );
      const result = evaluateScenarioFlow({
        graph,
        conversation: { _id: "conversation" } as never,
        channel: "whatsapp",
        preferredActionNodeId: roleNode(seed, "revenue-template").id,
        triggerEventKind: SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
        quickReplyPayload: buildWhatsAppTemplateButtonPayload(
          roleNode(seed, "revenue-template").id,
          buttonIndex
        ),
      });
      expect(result?.selectedAction.id).toBe(roleNode(seed, targetId).id);
      expect(result?.pathNodeIds).toContain(
        roleNode(seed, "revenue-audience").id
      );
    }
  );

  it("does not share template mutations with the merchant selection or later drafts", () => {
    const seed = buildRevenuePlaybookSeed(bulkConfig);
    const mutated = roleNode(seed, "revenue-template").data
      .actionWhatsAppTemplateComponents![0];
    if (mutated.type === "BODY") mutated.text = "Changed";
    expect(bulkConfig.template?.components?.[0]).toMatchObject({
      text: "Would you like to reorder?",
    });
    expect(
      roleNode(buildRevenuePlaybookSeed(bulkConfig), "revenue-template")?.data
        .actionWhatsAppTemplateComponents?.[0]
    ).toMatchObject({ text: "Would you like to reorder?" });
  });

  it.each([
    [{ type: "BODY", text: "Hello {{1}}" }],
    [{ type: "BODY", text: "Hello {{first_name}}" }],
    [
      { type: "HEADER", format: "IMAGE" },
      { type: "BODY", text: "Offer" },
    ],
    [
      { type: "BODY", text: "Offer" },
      { type: "CAROUSEL", cards: [] },
    ],
    [
      { type: "BODY", text: "Offer" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "URL", text: "Open", url: "https://example.com/{{1}}" },
        ],
      },
    ],
    [
      { type: "BODY", text: "Offer" },
      {
        type: "BUTTONS",
        buttons: [{ type: "FLOW", text: "Open", flow_id: "flow-1" }],
      },
    ],
  ])("excludes templates needing extra send inputs: %j", (...components) => {
    const template = {
      ...bulkConfig.template!,
      components: [...components, bulkConfig.template!.components![1]],
    } as NonNullable<RevenuePlaybookConfig["template"]>;
    expect(isRevenuePlaybookTemplateSupported(template)).toBe(false);
    expect(() => buildRevenuePlaybookSeed({ ...bulkConfig, template })).toThrow(
      RevenuePlaybookValidationError
    );
  });

  it("supports approved static template content with selectable quick replies", () => {
    expect(isRevenuePlaybookTemplateSupported(bulkConfig.template!)).toBe(true);
    expect(
      isRevenuePlaybookTemplateSupported({
        ...bulkConfig.template!,
        status: "PENDING",
      })
    ).toBe(false);
  });

  it.each([
    { field: "sourceId", patch: { sourceId: "" } },
    { field: "recipients", patch: { recipients: [] } },
    { field: "recipients", patch: { recipients: ["invalid"] } },
    { field: "template", patch: { template: undefined } },
    {
      field: "template",
      patch: { template: { ...bulkConfig.template!, status: "PENDING" } },
    },
    {
      field: "templateReplyButtonIndex",
      patch: { templateReplyButtonIndex: undefined },
    },
    {
      field: "templateReplyButtonIndex",
      patch: { templateReplyButtonIndex: 2 },
    },
    {
      field: "template",
      patch: {
        template: {
          ...bulkConfig.template!,
          components: [{ type: "BODY" as const, text: "No buttons" }],
        },
      },
    },
  ])("rejects incomplete bulk $field", ({ field, patch }) => {
    expect(() => buildRevenuePlaybookSeed({ ...bulkConfig, ...patch })).toThrow(
      RevenuePlaybookValidationError
    );
    try {
      buildRevenuePlaybookSeed({ ...bulkConfig, ...patch });
    } catch (error) {
      expect(error).toMatchObject({ field });
    }
  });

  it.each([
    { field: "name", patch: { name: " " } },
    { field: "openingText", patch: { openingText: "x".repeat(4097) } },
    { field: "triggerKeyword", patch: { triggerKeyword: "" } },
    { field: "reminderMinutes", patch: { reminderMinutes: 0 } },
    { field: "reminderMinutes", patch: { reminderMinutes: 1441 } },
    { field: "reminderMinutes", patch: { reminderMinutes: 1.5 } },
    { field: "sourceId", patch: { sourceId: "source-1" } },
    {
      field: "bookingUrl",
      patch: {
        goal: "ad_consultation" as const,
        qualificationQuestion: "Question?",
        bookingUrl: "javascript:alert(1)",
        bookingButtonLabel: "Book",
      },
    },
  ])(
    "rejects invalid $field rather than creating a misleading graph",
    ({ field, patch }) => {
      expect(() => buildRevenuePlaybookSeed({ ...config, ...patch })).toThrow(
        RevenuePlaybookValidationError
      );
      try {
        buildRevenuePlaybookSeed({ ...config, ...patch });
      } catch (error) {
        expect(error).toMatchObject({ field });
      }
    }
  );

  it("recognizes only the registered revenue playbook IDs", () => {
    expect(isRevenuePlaybookPresetId("scenario-onboarding-demo")).toBe(false);
    expect(isRevenuePlaybookPresetId("revenue-playbook-invented")).toBe(false);
    expect(isRevenuePlaybookPresetId(null)).toBe(false);
  });
});

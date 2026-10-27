import { buildScenarioGeneratorGraph } from "./graph-builder";
import { validateScenarioGraph } from "@/lib/scenarios/graph-validation";
import { getPostActionConditionHandleId } from "@icecore/scenario-contracts";

const READABLE_HORIZONTAL_GAP = 140;
const READABLE_VERTICAL_GAP = 80;
const BULK_NODE_WIDTH = 440;
const ACTION_NODE_HEIGHT = 300;

describe("buildScenarioGeneratorGraph", () => {
  it("creates an immediate bulk graph with a bulk root and cohort action branches", () => {
    const graph = buildScenarioGeneratorGraph({
      prompt: "Launch a spring retention offer",
      workflowKind: "bulk_campaign",
      sendMode: "immediate",
      channels: ["whatsapp", "email"],
      campaignName: "Spring retention",
      recipientSourceSummary: "Manual select: 12 recipients",
      cohorts: [
        { id: "vip", label: "VIP buyers", count: 5 },
        { id: "cold", label: "Cold leads", count: 7 },
      ],
    });

    expect(graph.nodes[0].data.kind).toBe("bulk");
    expect(
      graph.nodes.filter(node => node.data.kind === "trigger")
    ).toHaveLength(0);
    expect(graph.nodes.filter(node => node.data.kind === "action").length).toBe(
      2
    );
    expect(graph.nodes.some(node => node.type === "scenarioNode")).toBe(false);
    expect(
      graph.nodes.some(
        node =>
          node.data.kind === "action" &&
          node.data.bulkRecipientBranchId === "vip" &&
          node.data.bulkRecipientCount === 5
      )
    ).toBe(true);

    const bulkRoot = graph.nodes.find(node => node.data.kind === "bulk");
    const actionNodes = graph.nodes
      .filter(node => node.data.kind === "action")
      .sort((left, right) => left.position.y - right.position.y);

    expect(
      (actionNodes[0]?.position.x ?? 0) -
        ((bulkRoot?.position.x ?? 0) + BULK_NODE_WIDTH)
    ).toBeGreaterThanOrEqual(READABLE_HORIZONTAL_GAP);
    expect(
      actionNodes[1].position.y -
        (actionNodes[0].position.y + ACTION_NODE_HEIGHT)
    ).toBeGreaterThanOrEqual(READABLE_VERTICAL_GAP);
  });

  it("creates a follow-up workflow with a canonical incoming-message trigger root", () => {
    const graph = buildScenarioGeneratorGraph({
      prompt: "Follow up with users who stopped replying",
      workflowKind: "follow_up_workflow",
      sendMode: "trigger",
      channels: ["whatsapp"],
      campaignName: "No reply follow-up",
      recipientSourceSummary: "Triggered audience",
      cohorts: [{ id: "default", label: "Default audience", count: 0 }],
    });

    expect(graph.nodes[0].data).toMatchObject({
      kind: "trigger",
      triggerConfig: {
        enabled: true,
        messageMatchMode: "any",
        keywordMatchMode: "contains",
        channelFilter: ["whatsapp"],
      },
    });
    expect(graph.nodes[0].data).not.toHaveProperty("triggerType");
    expect(graph.nodes.filter(node => node.data.kind === "bulk")).toHaveLength(
      0
    );
  });

  it("uses LLM supplied action nodes and fields instead of fixed branch actions", () => {
    const uploadedAsset = {
      id: "asset-1",
      kind: "image" as const,
      source: "uploaded" as const,
      url: "https://cdn.example.com/spring.jpg",
      mimeType: "image/jpeg",
      fileName: "spring.jpg",
      status: "complete" as const,
    };

    const graph = buildScenarioGeneratorGraph({
      prompt: "Launch a spring retention offer",
      workflowKind: "bulk_campaign",
      sendMode: "immediate",
      channels: ["whatsapp"],
      campaignName: "Spring retention",
      recipientSourceSummary: "Manual select: 5 recipients",
      cohorts: [{ id: "vip", label: "VIP buyers", count: 5 }],
      generatedBranches: [
        {
          cohortId: "vip",
          actions: [
            {
              id: "welcome",
              label: "Welcome offer",
              text: "Hi {{name}}, your spring VIP offer is ready.",
              cta: {
                type: "link",
                label: "Open offer",
                url: "https://shop.example.com/spring",
              },
              media: {
                assetUrls: ["https://cdn.example.com/spring.jpg"],
              },
            },
            {
              id: "reminder",
              label: "Reminder",
              text: "Last reminder before the spring offer expires.",
              cta: { type: "quick_reply", label: "Remind me" },
              media: { assetUrls: [] },
            },
          ],
        },
      ],
      assets: [uploadedAsset],
    } as never);

    const actionNodes = graph.nodes.filter(node => node.data.kind === "action");

    expect(actionNodes.map(node => node.id)).toEqual([
      "node-vip-welcome",
      "node-vip-reminder",
    ]);
    const followUpGate = graph.nodes.find(
      node =>
        node.data.kind === "logic" &&
        node.data.logicType === "post_action_condition"
    );
    expect(followUpGate?.data).toMatchObject({
      logicType: "post_action_condition",
      conditionBranches: expect.any(Array),
    });
    expect(followUpGate?.data).not.toHaveProperty("uiNodeLabel");
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "node-vip-welcome",
          target: followUpGate?.id,
        }),
        expect.objectContaining({
          source: followUpGate?.id,
          target: "node-vip-reminder",
          sourceHandle: getPostActionConditionHandleId("no_reply_timeout"),
        }),
      ])
    );
    expect(actionNodes[0]?.data).toMatchObject({
      actionReplyText: "Hi {{name}}, your spring VIP offer is ready.",
      actionReplyCtaType: "link",
      actionReplyCtaLabel: "Open offer",
      actionLinkUrls: ["https://shop.example.com/spring"],
      actionImageUrls: ["https://cdn.example.com/spring.jpg"],
      actionMediaAssets: [uploadedAsset],
    });
    expect(actionNodes[1]?.data).toMatchObject({
      actionReplyText: "Last reminder before the spring offer expires.",
      actionReplyCtaType: "none",
      actionReplyCtaLabel: "Remind me",
      actionLinkUrls: [],
      actionImageUrls: [],
      actionMediaAssets: [],
    });
  });

  it("builds useful lifecycle workflow template graphs", () => {
    const graph = buildScenarioGeneratorGraph({
      prompt: "Use the lead generation template",
      workflowKind: "follow_up_workflow",
      sendMode: "trigger",
      channels: ["whatsapp"],
      campaignName: "Lead Generation Sequence",
      recipientSourceSummary: "Triggered audience",
      cohorts: [{ id: "lead_generation", label: "Lead Generation", count: 0 }],
      presetSeed: {
        id: "segment_lead_generation_funnel",
        version: "2.0.0",
        segmentKey: "lead_generation",
        title: "Lead Generation Sequence",
        description: "Capture new inbound leads and qualify them.",
        segmentLabel: "Lead Generation",
      },
    });

    expect(validateScenarioGraph(graph.nodes, graph.edges)).toBeNull();

    const trigger = graph.nodes.find(node => node.data.kind === "trigger");
    const context = graph.nodes.find(node => node.data.kind === "context");
    const condition = graph.nodes.find(
      node =>
        node.data.kind === "logic" &&
        node.data.logicType === "post_action_condition"
    );
    const audience = graph.nodes.find(
      node =>
        node.data.kind === "logic" && node.data.logicType === "audience_filter"
    );
    const actionNodes = graph.nodes.filter(node => node.data.kind === "action");

    expect(trigger?.data).toMatchObject({
      triggerConfig: {
        enabled: true,
        messageMatchMode: "any",
        keywordMatchMode: "contains",
        channelFilter: ["whatsapp"],
      },
    });
    expect(trigger?.data).not.toHaveProperty("triggerType");
    expect(audience?.data).toMatchObject({
      audienceMode: "funnel_stage",
      audienceFunnelStage: "lead_generation",
    });
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: trigger?.id,
          target: audience?.id,
        }),
        expect.objectContaining({
          source: audience?.id,
          target: context?.id,
        }),
      ])
    );
    expect(
      context?.data.contextSources?.map(source => source.optionId)
    ).toEqual([
      "conversation_timeline",
      "customer_profile",
      "knowledge_base_articles",
      "answer_snippets",
    ]);
    expect(actionNodes).toHaveLength(3);
    expect(
      actionNodes.every(
        node => node.data.actionWhatsAppServiceMessage?.version === 1
      )
    ).toBe(true);
    expect(
      actionNodes.every(
        node =>
          node.data.actionReplyChannel === undefined &&
          node.data.actionReplyMode === undefined &&
          node.data.actionReplyText === undefined &&
          node.data.actionReplyInstruction === undefined
      )
    ).toBe(true);
    expect(condition?.data.conditionBranches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "no_reply_timeout",
          timeoutMinutes: 30,
        }),
      ])
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: condition?.id,
          sourceHandle: getPostActionConditionHandleId("user_replied"),
        }),
        expect.objectContaining({
          source: condition?.id,
          sourceHandle: getPostActionConditionHandleId("no_reply_timeout"),
        }),
      ])
    );
  });

  it("builds human escalation templates as handoff graphs", () => {
    const graph = buildScenarioGeneratorGraph({
      prompt: "Escalate objections to the team",
      workflowKind: "follow_up_workflow",
      sendMode: "trigger",
      channels: ["whatsapp"],
      campaignName: "Human Escalation",
      recipientSourceSummary: "Triggered audience",
      cohorts: [],
      presetSeed: {
        id: "segment_human_escalation_pack",
        version: "2.0.0",
        segmentKey: "human_escalation",
        title: "Human Escalation Pack",
        description: "Route objections and human requests to the team.",
        segmentLabel: "Human Escalation",
      },
    });

    expect(validateScenarioGraph(graph.nodes, graph.edges)).toBeNull();

    const trigger = graph.nodes.find(node => node.data.kind === "trigger");
    const actionNodes = graph.nodes.filter(node => node.data.kind === "action");

    expect(trigger?.data).toMatchObject({
      triggerConfig: {
        enabled: true,
        messageMatchMode: "contains",
        keywordMatchMode: "regex",
        keywordPattern: expect.stringContaining("human"),
        channelFilter: ["whatsapp"],
      },
    });
    expect(trigger?.data).not.toHaveProperty("triggerType");
    expect(actionNodes).toHaveLength(1);
    expect(actionNodes[0]?.data).toMatchObject({
      actionType: "assign_human",
      actionInstruction: expect.stringContaining("Escalate"),
    });
    expect(actionNodes[0]?.data).not.toHaveProperty("uiNodeLabel");
  });
});

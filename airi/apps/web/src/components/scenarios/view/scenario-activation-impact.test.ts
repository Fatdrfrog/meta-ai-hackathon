import {
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  buildWhatsAppTemplateButtonSourceHandleId,
} from "@icecore/scenario-contracts";
import type {
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioSummary,
  TranslateFn,
} from "../types";
import {
  buildScenarioActivationImpact,
  buildTemplateButtonDriftActivationIssues,
  buildTemplateFlowActivationIssues,
  collectActivationBlockedNodes,
  collectScenarioTemplateFlowTargets,
} from "./scenario-activation-impact";
import { buildGuidedScenarioSeed } from "./scenario-guided-create";

const t: TranslateFn = key => key;
const tWithValues: TranslateFn = (key, values) =>
  values ? `${key}:${JSON.stringify(values)}` : key;

describe("activation blockers found before the server", () => {
  function unfinishedStarter() {
    const { nodes, edges } = buildGuidedScenarioSeed({
      kind: "keyword",
      t,
    }).initialFlow;
    return {
      edges,
      nodes: nodes.map(node => {
        const data = node.data as ScenarioFlowNode["data"] & {
          kind?: string;
          triggerConfig?: Record<string, unknown>;
          actionWhatsAppServiceMessage?: {
            version: 1;
            message: { kind: string; body: unknown };
          };
        };
        if (data.kind === "trigger") {
          return {
            ...node,
            data: {
              ...data,
              triggerConfig: { ...data.triggerConfig, keywordPattern: "" },
            },
          };
        }
        if (data.kind === "action" && data.actionWhatsAppServiceMessage) {
          const message = data.actionWhatsAppServiceMessage;
          return {
            ...node,
            data: {
              ...data,
              actionWhatsAppServiceMessage: {
                ...message,
                message: {
                  ...message.message,
                  body: { mode: "fixed", text: "" },
                },
              },
            },
          };
        }
        return node;
      }) as ScenarioFlowNode[],
    };
  }

  it("names the empty keyword and the empty message by block", () => {
    const graph = unfinishedStarter();
    const blocked = collectActivationBlockedNodes(
      graph.nodes as Parameters<typeof collectActivationBlockedNodes>[0]
    );

    expect(blocked.map(item => [item.kind, item.code])).toEqual([
      ["trigger", "messageTriggerIncomplete"],
      ["action", "whatsappServiceMessageInvalid"],
    ]);
  });

  it("lists each blocker with a block label and never a raw node id", () => {
    const graph = unfinishedStarter();
    const impact = buildScenarioActivationImpact({
      scenario: scenario(),
      scenarios: [scenario()],
      graph,
      t: tWithValues,
    });
    const blockers = impact.issues.filter(issue => issue.severity === "error");

    expect(blockers.map(issue => issue.block?.label)).toEqual([
      'activationImpactBlockLabel:{"block":"badgeTrigger"}',
      'activationImpactBlockLabel:{"block":"messageSection"}',
    ]);
    for (const issue of blockers) {
      expect(issue.description).toBe(
        issue.block?.label.includes("badgeTrigger")
          ? "messageTriggerIncomplete"
          : "whatsappServiceMessageInvalid"
      );
      for (const node of graph.nodes) {
        expect(issue.title).not.toContain(node.id);
        expect(issue.description).not.toContain(node.id);
        expect(issue.block?.label).not.toContain(node.id);
      }
    }
  });
});

function scenario(overrides: Partial<ScenarioSummary> = {}): ScenarioSummary {
  return {
    _id: "scenario-1",
    name: "Welcome",
    description: "",
    status: "draft",
    mode: "conversation",
    priority: 0,
    presetId: null,
    presetVersion: null,
    segmentKey: null,
    matchingRole: "default",
    entryPolicy: "once_per_conversation",
    linkedParentScenarioIds: [],
    nodeCount: 1,
    edgeCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildScenarioActivationImpact", () => {
  it("does not advertise a persisted fallback role as effective runtime behavior", () => {
    const fallbackScenario = scenario({
      matchingRole: "fallback",
    });

    expect(
      buildScenarioActivationImpact({
        scenario: fallbackScenario,
        scenarios: [fallbackScenario],
        t,
      }).journeyDescription
    ).toBe("activationImpactJourneyStarts");
  });
});

describe("template Flow activation warnings", () => {
  const FLOW_ID = "2244981489363579";
  const flowButtons = (navigateScreen: string) => [
    {
      type: "BUTTONS" as const,
      buttons: [
        {
          type: "FLOW" as const,
          text: "Таңдау",
          flow_id: FLOW_ID,
          flow_action: "navigate" as const,
          navigate_screen: navigateScreen,
        },
      ],
    },
  ];
  const templateNode = (
    id: string,
    data: Record<string, unknown>
  ): ScenarioFlowNode =>
    ({
      id,
      type: "actionNode",
      position: { x: 0, y: 0 },
      data: { kind: "action", actionType: "whatsapp_template", ...data },
    }) as unknown as ScenarioFlowNode;
  const facts = {
    [FLOW_ID]: {
      flowId: FLOW_ID,
      state: "found" as const,
      name: "Message templates_medal_pick_1_MARKETING_9b1bc",
      status: "PUBLISHED",
      screenIds: ["SURVEY_FORM"],
      checkedAt: "2026-09-28T12:00:00.000Z",
    },
  };
  const tTemplates = (key: string, values?: Record<string, string>) =>
    `${key}:${values?.screen ?? ""}`;

  it("checks the live template and warns once per template", () => {
    const nodes = [
      templateNode("a", {
        actionWhatsAppTemplateName: "medal_pick_1",
        actionWhatsAppTemplateLanguage: "kk",
        // A stale node copy that still pointed at a screen the Flow had.
        actionWhatsAppTemplateComponents: flowButtons("SURVEY_FORM"),
      }),
      templateNode("b", {
        actionWhatsAppTemplateName: "medal_pick_1",
        actionWhatsAppTemplateLanguage: "kk",
        actionWhatsAppTemplateComponents: flowButtons("SURVEY_FORM"),
      }),
      templateNode("c", {
        actionWhatsAppTemplateName: "pick_lang",
        actionWhatsAppTemplateLanguage: "kk",
        actionWhatsAppTemplateComponents: [{ type: "BODY", text: "Hi" }],
      }),
      {
        id: "reply",
        type: "actionNode",
        position: { x: 0, y: 0 },
        data: { kind: "action", actionType: "reply" },
      } as unknown as ScenarioFlowNode,
    ];

    const targets = collectScenarioTemplateFlowTargets({
      nodes,
      whatsAppTemplates: [
        {
          name: "medal_pick_1",
          language: "kk",
          status: "APPROVED",
          components: flowButtons("QUESTION_ONE"),
        },
      ],
    });
    const issues = buildTemplateFlowActivationIssues({
      targets,
      factsByFlowId: facts,
      t: (key, values) => `${key}:${values?.template ?? ""}`,
      tTemplates,
    });

    expect(targets).toHaveLength(1);
    expect(issues).toEqual([
      {
        id: "template-flow-medal_pick_1:kk-0-flow_screen_missing",
        severity: "warning",
        title: "activationImpactTemplateFlowTitle:medal_pick_1",
        description: "flowHealth.screenMissing:QUESTION_ONE",
      },
    ]);
  });

  it("falls back to the node's saved copy when the catalog hasn't loaded", () => {
    const targets = collectScenarioTemplateFlowTargets({
      nodes: [
        templateNode("a", {
          actionWhatsAppTemplateName: "medal_pick_1",
          actionWhatsAppTemplateLanguage: "kk",
          actionWhatsAppTemplateComponents: flowButtons("QUESTION_ONE"),
        }),
      ],
      whatsAppTemplates: [],
    });

    expect(
      buildTemplateFlowActivationIssues({
        targets,
        factsByFlowId: facts,
        t,
        tTemplates,
      })
    ).toHaveLength(1);
  });

  it("adds nothing when the Flow opens or couldn't be checked", () => {
    const targets = collectScenarioTemplateFlowTargets({
      nodes: [
        templateNode("a", {
          actionWhatsAppTemplateName: "medal_pick_1",
          actionWhatsAppTemplateLanguage: "kk",
          actionWhatsAppTemplateComponents: flowButtons("SURVEY_FORM"),
        }),
      ],
      whatsAppTemplates: [],
    });

    expect(
      buildTemplateFlowActivationIssues({
        targets,
        factsByFlowId: facts,
        t,
        tTemplates,
      })
    ).toEqual([]);
    expect(
      buildTemplateFlowActivationIssues({
        targets,
        factsByFlowId: {
          [FLOW_ID]: {
            flowId: FLOW_ID,
            state: "unavailable",
            checkedAt: "2026-09-28T12:00:00.000Z",
          },
        },
        t,
        tTemplates,
      })
    ).toEqual([]);
  });
});

describe("template reply-button activation warnings", () => {
  const replyButtons = (...texts: string[]) => [
    { type: "BODY" as const, text: "Which plan do you want?" },
    {
      type: "BUTTONS" as const,
      buttons: texts.map(text => ({ type: "QUICK_REPLY" as const, text })),
    },
  ];
  const planStep = (id: string, ...texts: string[]): ScenarioFlowNode =>
    ({
      id,
      type: "actionNode",
      position: { x: 0, y: 0 },
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "pick_plan",
        actionWhatsAppTemplateLanguage: "en",
        actionWhatsAppTemplateComponents: replyButtons(...texts),
      },
    }) as unknown as ScenarioFlowNode;
  const approved = (...texts: string[]) => [
    {
      name: "pick_plan",
      language: "en",
      status: "APPROVED",
      components: replyButtons(...texts),
    },
  ];
  const tWithValues: TranslateFn = (key, values) =>
    values ? `${key}:${values.template ?? values.label}` : key;
  /** Routes from both of a step's buttons. */
  const routesFrom = (...stepIds: string[]): ScenarioFlowEdge[] =>
    stepIds.flatMap(stepId =>
      [0, 1].map(id => ({
        id: `${stepId}-${id}`,
        source: stepId,
        sourceHandle: buildWhatsAppTemplateButtonSourceHandleId(id),
        target: `${stepId}-follow-up-${id}`,
      }))
    );

  it("warns once per template and difference, and not about a move", () => {
    const issues = buildTemplateButtonDriftActivationIssues({
      graph: {
        nodes: [
          planStep("a", "Basic", "Premium"),
          planStep("b", "Basic", "Premium"),
        ],
        edges: routesFrom("a", "b"),
      },
      whatsAppTemplates: approved("Premium"),
      t: tWithValues,
    });

    // Premium moved to the front; its route still runs.
    expect(issues).toEqual([
      {
        id: "template-buttons-pick_plan:en-whatsappTemplateButtonDriftRemoved:Basic",
        severity: "warning",
        title: "activationImpactTemplateButtonsTitle:pick_plan",
        description: "whatsappTemplateButtonDriftRemoved:Basic",
      },
    ]);
  });

  it("adds nothing without routes, or when the approved template matches or isn't loaded", () => {
    const nodes = [planStep("a", "Basic", "Premium")];

    expect(
      buildTemplateButtonDriftActivationIssues({
        graph: { nodes, edges: [] },
        whatsAppTemplates: approved("Premium"),
        t,
      })
    ).toEqual([]);
    expect(
      buildTemplateButtonDriftActivationIssues({
        graph: { nodes, edges: routesFrom("a") },
        whatsAppTemplates: approved("Basic", "Premium"),
        t,
      })
    ).toEqual([]);
    expect(
      buildTemplateButtonDriftActivationIssues({
        graph: { nodes, edges: routesFrom("a") },
        whatsAppTemplates: [],
        t,
      })
    ).toEqual([]);
  });

  it("warns when the approved template drops the form a Form submitted route waits for", () => {
    const medal = {
      id: "medal",
      type: "actionNode",
      position: { x: 0, y: 0 },
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "pick_plan",
        actionWhatsAppTemplateLanguage: "en",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Which plan do you want?" },
          {
            type: "BUTTONS",
            buttons: [
              { type: "FLOW", text: "Open form", flow_id: "1571793974235171" },
            ],
          },
        ],
      },
    } as unknown as ScenarioFlowNode;

    expect(
      buildTemplateButtonDriftActivationIssues({
        graph: {
          nodes: [medal],
          edges: [
            {
              id: "medal-form",
              source: "medal",
              sourceHandle: ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
              target: "carousel",
            },
          ],
        },
        whatsAppTemplates: approved("Таңдау"),
        t: tWithValues,
      })
    ).toEqual([
      {
        id: "template-buttons-pick_plan:en-whatsappTemplateButtonDriftFormRemoved:Open form",
        severity: "warning",
        title: "activationImpactTemplateButtonsTitle:pick_plan",
        description: "whatsappTemplateButtonDriftFormRemoved:Open form",
      },
    ]);
  });

  it("lists the warnings with the activation impact of the scenario in the editor", () => {
    const impact = buildScenarioActivationImpact({
      scenario: scenario(),
      scenarios: [scenario()],
      graph: {
        nodes: [planStep("a", "Basic", "Premium")],
        edges: routesFrom("a"),
      },
      whatsAppTemplates: approved("Basic", "Premium", "Gold"),
      t: tWithValues,
    });

    expect(impact.issues).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        description: "whatsappTemplateButtonDriftAdded:Gold",
      })
    );
  });
});

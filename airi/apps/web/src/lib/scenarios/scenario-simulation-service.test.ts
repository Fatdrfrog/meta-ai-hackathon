import { simulateScenarioStep } from "./scenario-simulation-service";
import { scenarioSimulationEventSchema } from "./scenario-simulation-types";
const mockChatCompletion = jest.fn();
jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) =>
    mockChatCompletion(...args),
  getLightTextModel: () => "preview-test-model",
}));
import {
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  buildScenarioActionOutcomeHandleId,
  buildWhatsAppSessionChoiceSourceHandleId,
  type ScenarioGraphNode,
} from "@icecore/scenario-contracts";

const action = (id: string, text: string, extra = {}): ScenarioGraphNode => ({
  id,
  data: {
    kind: "action",
    actionType: "reply",
    actionWhatsAppServiceMessage: {
      version: 1,
      message: { kind: "text", body: { mode: "fixed", text } },
    },
    ...extra,
  },
});
function fixture() {
  return {
    nodes: [
      {
        id: "entry",
        data: { kind: "trigger", triggerConfig: { enabled: true } },
      } as ScenarioGraphNode,
      action("menu", "Choose", {
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Choose" },
            options: [{ id: "wsc:menu:help", label: "Help" }],
          },
        },
        actionOutcomes: {
          version: 1,
          anyReply: { enabled: true },
          noReply: { enabled: true, timeoutMinutes: 10 },
          answerMatches: [{ id: "yes", mode: "exact", text: "yes" }],
        },
      }),
      action("help", "How can I help?"),
      action("typed", "You wrote a message"),
      action("yes", "Confirmed"),
      action("later", "Still there?"),
    ],
    edges: [
      { id: "entry-menu", source: "entry", target: "menu" },
      {
        id: "help-path",
        source: "menu",
        target: "help",
        sourceHandle: buildWhatsAppSessionChoiceSourceHandleId("wsc:menu:help"),
      },
      {
        id: "typed-path",
        source: "menu",
        target: "typed",
        sourceHandle: buildScenarioActionOutcomeHandleId("any_reply"),
      },
      {
        id: "yes-path",
        source: "menu",
        target: "yes",
        sourceHandle: buildScenarioActionOutcomeHandleId({
          type: "answer",
          ruleId: "yes",
        }),
      },
      {
        id: "later-path",
        source: "menu",
        target: "later",
        sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
      },
    ],
  };
}
const start = (graph = fixture()) =>
  simulateScenarioStep({ graph, event: { kind: "start" } });

describe("customer scenario simulation uses runtime routing", () => {
  it.each([
    [
      { type: "classification", category: "active" },
      { classificationCategory: "active" },
      true,
    ],
    [
      { type: "classification", category: "active" },
      { classificationCategory: "lost" },
      false,
    ],
    [
      { type: "funnel_stage", stage: "active" },
      { funnelStage: "active", classificationCategory: "onboarding" },
      true,
    ],
    [
      { type: "funnel_stage", stage: "active" },
      { funnelStage: "onboarding", classificationCategory: "active" },
      false,
    ],
    [
      { type: "internal_label", label: "VIP" },
      { internalLabels: ["VIP"] },
      true,
    ],
    [{ type: "has_purchase_history" }, { hasPurchaseHistory: true }, true],
    [{ type: "has_purchase_history" }, { hasPurchaseHistory: false }, false],
  ] as const)(
    "evaluates customer condition %j using context %j",
    async (condition, context, passes) => {
      const graph = fixture();
      graph.nodes[1].data.actionRunConditions = {
        version: 1,
        match: "all",
        conditions: [{ id: "context-condition", ...condition }],
      };
      const result = await simulateScenarioStep({
        graph,
        event: { kind: "start" },
        context: {
          ...context,
          internalLabels:
            "internalLabels" in context
              ? [...context.internalLabels]
              : undefined,
        },
      });
      expect(result.message?.actionNodeId ?? null).toBe(passes ? "menu" : null);
    }
  );

  it("treats a started customer conversation as recently active", async () => {
    const graph = fixture();
    graph.nodes[1].data.actionRunConditions = {
      version: 1,
      match: "all",
      conditions: [{ id: "inactive", type: "last_seen_days", minimumDays: 1 }],
    };
    const result = await start(graph);
    expect(result.message).toBeNull();
    expect(result.reason).toBe("no_match");
  });

  it.each([1, 2])(
    "evaluates %i-day inactivity against advanced conversation time",
    async minimumDays => {
      const graph = fixture();
      graph.nodes[1].data.actionOutcomes = {
        version: 1,
        noReply: { enabled: true, timeoutMinutes: 1440 },
      };
      graph.edges = graph.edges.filter(edge =>
        ["entry-menu", "help-path", "later-path"].includes(edge.id)
      );
      graph.nodes.find(node => node.id === "later")!.data.actionRunConditions =
        {
          version: 1,
          match: "all",
          conditions: [{ id: "inactive", type: "last_seen_days", minimumDays }],
        };
      const first = await start(graph);
      const result = await simulateScenarioStep({
        graph,
        state: first.state,
        event: { kind: "advance", minutes: 1440 },
      });
      expect(result.message?.actionNodeId ?? null).toBe(
        minimumDays === 1 ? "later" : null
      );
    }
  );

  it("accepts bounded Flow multiselect values and rejects oversized submissions", () => {
    const values = { interests: ["support", "sales"], name: "Amina" };
    expect(
      scenarioSimulationEventSchema.parse({ kind: "flow", values })
    ).toEqual({ kind: "flow", values });
    expect(
      scenarioSimulationEventSchema.safeParse({
        kind: "flow",
        values: { interests: Array(101).fill("sales") },
      }).success
    ).toBe(false);
    expect(
      scenarioSimulationEventSchema.safeParse({
        kind: "flow",
        values: Object.fromEntries(
          Array.from({ length: 101 }, (_, i) => [`field-${i}`, "answer"])
        ),
      }).success
    ).toBe(false);
  });
  beforeEach(() => {
    mockChatCompletion
      .mockReset()
      .mockResolvedValue({ content: '{"matches":[]}' });
  });

  it.each(["exact", "intent"] as const)(
    "keeps a plain message wait after an unmatched %s rule without a fallback",
    async mode => {
      const graph = fixture();
      graph.nodes[1] = action("menu", "Tell me", {
        actionOutcomes: {
          version: 1,
          answerMatches: [{ id: "yes", mode, text: "affirmative answer" }],
          noReply: { enabled: true, timeoutMinutes: 10 },
        },
      });
      graph.edges = graph.edges.filter(
        e => !["typed-path", "help-path"].includes(e.id)
      );
      const first = await start(graph);
      const result = await simulateScenarioStep({
        graph,
        state: first.state,
        event: { kind: "message", text: "unrelated question" },
      });
      expect(result.state.status).toBe("waiting");
      expect(result.state.pendingConditionNodeId).toBe(
        first.state.pendingConditionNodeId
      );
      expect(result.message).toBeNull();
      expect(mockChatCompletion).toHaveBeenCalledTimes(
        mode === "intent" ? 1 : 0
      );
    }
  );

  it("keeps a plain message's No reply wait when the customer types and Any reply is off", async () => {
    const graph = fixture();
    graph.nodes[1] = action("menu", "Tell me", {
      actionOutcomes: {
        version: 1,
        noReply: { enabled: true, timeoutMinutes: 10 },
      },
    });
    graph.edges = graph.edges.filter(
      e => !["typed-path", "help-path", "yes-path"].includes(e.id)
    );
    const first = await start(graph);
    const result = await simulateScenarioStep({
      graph,
      state: first.state,
      event: { kind: "message", text: "Is it in stock?" },
    });
    expect(result.state.status).toBe("waiting");
    expect(result.state.pendingConditionNodeId).toBe(
      first.state.pendingConditionNodeId
    );
    expect(result.message).toBeNull();
  });

  it("uses the real intent matcher ahead of the ordinary reply fallback", async () => {
    const graph = fixture();
    graph.nodes[1].data.actionOutcomes = {
      version: 1,
      anyReply: { enabled: true },
      noReply: { enabled: true, timeoutMinutes: 10 },
      answerMatches: [{ id: "yes", mode: "intent", text: "wants to buy" }],
    };
    mockChatCompletion.mockResolvedValue({
      content: '{"matches":[{"id":"yes","confidence":0.95}]}',
    });
    const first = await start(graph);
    const result = await simulateScenarioStep({
      graph,
      state: first.state,
      event: { kind: "message", text: "I would like to purchase" },
    });
    expect(result.state.actionNodeId).toBe("yes");
    expect(result.pathEdgeIds).toEqual(["yes-path"]);
  });

  it("completes a claimed ordinary reply whose configured outcome has no target", async () => {
    const graph = fixture();
    graph.edges = graph.edges.filter(e => e.id !== "typed-path");
    const first = await start(graph);
    const result = await simulateScenarioStep({
      graph,
      state: first.state,
      event: { kind: "message", text: "other answer" },
    });
    expect(result.state.status).toBe("completed");
    expect(result.state.pendingConditionNodeId).toBeNull();
    expect(result.state.dueAt).toBeNull();
    expect(result.message).toBeNull();
  });

  it("keeps a human handoff quiet while its configured timer can follow up", async () => {
    const graph = fixture();
    graph.nodes[2] = {
      id: "help",
      data: {
        kind: "action",
        actionType: "assign_human",
        actionOutcomes: {
          version: 1,
          anyReply: { enabled: true },
          noReply: { enabled: true, timeoutMinutes: 10 },
        },
      },
    };
    graph.edges.push(
      {
        id: "handoff-timer",
        source: "help",
        target: "later",
        sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
      },
      {
        id: "handoff-reply",
        source: "help",
        target: "typed",
        sourceHandle: buildScenarioActionOutcomeHandleId("any_reply"),
      }
    );
    const first = await start(graph);
    const handoff = await simulateScenarioStep({
      graph,
      state: first.state,
      event: { kind: "choice", payload: "wsc:menu:help" },
    });
    const later = await simulateScenarioStep({
      graph,
      state: handoff.state,
      event: { kind: "advance", minutes: 5 },
    });
    const quiet = await simulateScenarioStep({
      graph,
      state: later.state,
      event: { kind: "message", text: "Hello?" },
    });
    expect(quiet.state.status).toBe("handoff");
    expect(quiet.state.dueAt).toBe(900_000);
    expect(quiet.message).toBeNull();
    const followup = await simulateScenarioStep({
      graph,
      state: quiet.state,
      event: { kind: "advance", minutes: 10 },
    });
    expect(followup.message?.bodyText).toBe("Still there?");
    expect(followup.pathEdgeIds).toEqual(["handoff-timer"]);
    expect(followup.state.handoffActive).toBe(true);
  });

  it.each(["message", "advance", "choice"] as const)(
    "highlights only the selected %s route when destinations are shared",
    async kind => {
      const graph = fixture();
      for (const edge of graph.edges)
        if (["typed-path", "later-path"].includes(edge.id))
          edge.target = "help";
      const first = await start(graph);
      const event =
        kind === "message"
          ? { kind: "message" as const, text: "other" }
          : kind === "advance"
            ? { kind: "advance" as const, minutes: 10 }
            : { kind: "choice" as const, payload: "wsc:menu:help" };
      const result = await simulateScenarioStep({
        graph,
        state: first.state,
        event,
      });
      expect(result.pathEdgeIds).toEqual([
        kind === "message"
          ? "typed-path"
          : kind === "advance"
            ? "later-path"
            : "help-path",
      ]);
    }
  );

  it("cancels a timer when the customer uses a configured stop phrase", async () => {
    const graph = fixture();
    graph.nodes[1].data.actionOutcomes = {
      version: 1,
      noReply: {
        enabled: true,
        timeoutMinutes: 10,
        cancelIfPhrases: ["please stop"],
      },
    };
    graph.edges = graph.edges.filter(
      e => !["typed-path", "yes-path"].includes(e.id)
    );
    const first = await start(graph);
    const stopped = await simulateScenarioStep({
      graph,
      state: first.state,
      event: { kind: "message", text: "PLEASE STOP reminders" },
    });
    const due = await simulateScenarioStep({
      graph,
      state: stopped.state,
      event: { kind: "advance", minutes: 10 },
    });
    expect(due.reason).toBe("cancelled");
    expect(due.state.status).toBe("completed");
    expect(due.message).toBeNull();
  });

  it("rejects a changed graph even when every node keeps the same ID", async () => {
    const graph = fixture();
    const first = await start(graph);
    graph.nodes[1].data.actionOutcomes!.noReply!.timeoutMinutes = 30;
    await expect(
      simulateScenarioStep({
        graph,
        state: first.state,
        event: { kind: "advance", minutes: 10 },
      })
    ).rejects.toThrow("The scenario or preview changed. Restart the preview.");
  });

  it.each(["pending_source", "future_wait", "forged_deadline"])(
    "rejects inconsistent preview state: %s",
    async kind => {
      const graph = fixture();
      const first = await start(graph);
      const state = { ...first.state };
      if (kind === "pending_source") state.pendingSourceActionNodeId = "help";
      if (kind === "future_wait") state.waitStartedAt = 60_000;
      if (kind === "forged_deadline") state.dueAt = 1;
      await expect(
        simulateScenarioStep({
          graph,
          state,
          event: { kind: "advance", minutes: 1 },
        })
      ).rejects.toThrow(
        "The preview state is inconsistent. Restart the preview."
      );
    }
  );
  it("rejects a timer borrowed from another action in the same graph", async () => {
    const graph = fixture();
    graph.nodes[2].data.actionOutcomes = {
      version: 1,
      noReply: { enabled: true, timeoutMinutes: 10 },
    };
    graph.edges.push({
      id: "other-timer",
      source: "help",
      target: "later",
      sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
    });
    const first = await start(graph);
    const other = await simulateScenarioStep({
      graph,
      state: first.state,
      event: { kind: "choice", payload: "wsc:menu:help" },
    });
    await expect(
      simulateScenarioStep({
        graph,
        state: {
          ...first.state,
          pendingConditionNodeId: other.state.pendingConditionNodeId,
        },
        event: { kind: "advance", minutes: 10 },
      })
    ).rejects.toThrow(
      "The preview state is inconsistent. Restart the preview."
    );
  });
  it("rejects a step without current preview state", async () => {
    await expect(
      simulateScenarioStep({
        graph: fixture(),
        event: { kind: "message", text: "Hello" },
      })
    ).rejects.toThrow("Restart the preview before taking another step.");
  });
  it("starts at the first message and retains its active wait", async () => {
    const result = await start();
    expect(result.state.status).toBe("waiting");
    expect(result.state.actionNodeId).toBe("menu");
    expect(result.message?.bodyText).toBe("Choose");
    expect(result.pathEdgeIds).toEqual(["entry-menu"]);
    expect(result.state.dueAt).toBe(600_000);
  });
  it("routes a button before the ordinary-message fallback", async () => {
    const first = await start();
    const result = await simulateScenarioStep({
      graph: fixture(),
      state: first.state,
      event: { kind: "choice", payload: "wsc:menu:help" },
    });
    expect(result.state.actionNodeId).toBe("help");
    expect(result.message?.bodyText).toBe("How can I help?");
    expect(result.pathEdgeIds).toContain("help-path");
    expect(result.pathEdgeIds).not.toContain("typed-path");
  });
  it("matches an exact answer before the ordinary-message fallback", async () => {
    const first = await start();
    const result = await simulateScenarioStep({
      graph: fixture(),
      state: first.state,
      event: { kind: "message", text: "yes please" },
    });
    expect(result.state.actionNodeId).toBe("yes");
    expect(result.pathEdgeIds).toContain("yes-path");
  });
  it("preserves the wait on an unmatched button without restarting", async () => {
    const first = await start();
    const result = await simulateScenarioStep({
      graph: fixture(),
      state: first.state,
      event: { kind: "choice", payload: "wsc:another:missing" },
    });
    expect(result.state.actionNodeId).toBe("menu");
    expect(result.state.status).toBe("waiting");
    expect(result.message).toBeNull();
  });
  it("keeps the no-reply timer after a button with no connected branch", async () => {
    const graph = fixture();
    graph.nodes[1].data.actionWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Choose" },
        options: [
          { id: "wsc:menu:help", label: "Help" },
          { id: "wsc:menu:pricing", label: "Pricing" },
        ],
      },
    };
    const first = await start(graph);
    const tapped = await simulateScenarioStep({
      graph,
      state: first.state,
      event: { kind: "choice", payload: "wsc:menu:pricing" },
    });
    expect(tapped.reason).toBe("no_match");
    expect(tapped.state.pendingConditionNodeId).toBe(
      first.state.pendingConditionNodeId
    );
    const due = await simulateScenarioStep({
      graph,
      state: tapped.state,
      event: { kind: "advance", minutes: 10 },
    });
    expect(due.state.actionNodeId).toBe("later");
  });
  it.each([
    ["wsc:menu:help", "help"],
    ["wsc:menu:pricing", null],
  ] as const)(
    "handles the older button %s after the timer sent a reminder",
    async (payload, routedActionNodeId) => {
      const graph = fixture();
      graph.nodes.find(node => node.id === "later")!.data.actionOutcomes = {
        version: 1,
        noReply: { enabled: true, timeoutMinutes: 10 },
      };
      graph.nodes.push(action("last-call", "Last call"));
      graph.edges.push({
        id: "last-call-path",
        source: "later",
        target: "last-call",
        sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
      });
      const first = await start(graph);
      const reminded = await simulateScenarioStep({
        graph,
        state: first.state,
        event: { kind: "advance", minutes: 10 },
      });
      expect(reminded.state.pendingSourceActionNodeId).toBe("later");
      const tapped = await simulateScenarioStep({
        graph,
        state: reminded.state,
        event: { kind: "choice", payload },
      });
      if (routedActionNodeId) {
        expect(tapped.state.actionNodeId).toBe(routedActionNodeId);
        expect(tapped.message?.bodyText).toBe("How can I help?");
        return;
      }
      expect(tapped.reason).toBe("no_match");
      expect(tapped.state.pendingConditionNodeId).toBe(
        reminded.state.pendingConditionNodeId
      );
      const due = await simulateScenarioStep({
        graph,
        state: tapped.state,
        event: { kind: "advance", minutes: 10 },
      });
      expect(due.state.actionNodeId).toBe("last-call");
    }
  );
  it.each([true, false])(
    "routes a Flow without choice fields like any other reply (Any reply %s)",
    async anyReply => {
      const graph = fixture();
      graph.nodes[1] = action("menu", "Tell us about you", {
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "flow",
            body: { mode: "fixed", text: "Tell us about you" },
            flowConfig: {
              templateId: "flow-1",
              ctaText: "Open",
              screens: [
                {
                  id: "about",
                  title: "About you",
                  fields: [
                    { id: "name", label: "Name", fieldType: "TextInput" },
                  ],
                },
              ],
            },
          },
        },
        actionOutcomes: {
          version: 1,
          ...(anyReply ? { anyReply: { enabled: true } } : {}),
          noReply: { enabled: true, timeoutMinutes: 10 },
        },
      });
      graph.edges = graph.edges.filter(edge =>
        [
          "entry-menu",
          "later-path",
          ...(anyReply ? ["typed-path"] : []),
        ].includes(edge.id)
      );
      const first = await start(graph);
      const submitted = await simulateScenarioStep({
        graph,
        state: first.state,
        event: { kind: "flow", values: { name: "Amina" } },
      });
      if (anyReply) {
        expect(submitted.state.actionNodeId).toBe("typed");
        expect(submitted.pathEdgeIds).toEqual(["typed-path"]);
        return;
      }
      expect(submitted.reason).toBe("no_match");
      expect(submitted.state.pendingConditionNodeId).toBe(
        first.state.pendingConditionNodeId
      );
      const due = await simulateScenarioStep({
        graph,
        state: submitted.state,
        event: { kind: "advance", minutes: 10 },
      });
      expect(due.state.actionNodeId).toBe("later");
    }
  );
  it("advances time without firing early, then follows the timeout path", async () => {
    const first = await start();
    const early = await simulateScenarioStep({
      graph: fixture(),
      state: first.state,
      event: { kind: "advance", minutes: 9 },
    });
    expect(early.message).toBeNull();
    const due = await simulateScenarioStep({
      graph: fixture(),
      state: early.state,
      event: { kind: "advance", minutes: 1 },
    });
    expect(due.state.actionNodeId).toBe("later");
    expect(due.pathEdgeIds).toContain("later-path");
  });
  it("moves an ignored-message timeout to the latest conversation activity", async () => {
    const graph = fixture();
    graph.nodes[1].data.actionOutcomes = {
      version: 1,
      noReply: { enabled: true, timeoutMinutes: 10 },
    };
    graph.edges = graph.edges.filter(
      e => !["yes-path", "typed-path"].includes(e.id)
    );
    const first = await start(graph);
    const later = await simulateScenarioStep({
      graph,
      state: first.state,
      event: { kind: "advance", minutes: 5 },
    });
    const ignored = await simulateScenarioStep({
      graph,
      state: later.state,
      event: { kind: "message", text: "Hello" },
    });
    expect(ignored.state.actionNodeId).toBe("menu");
    expect(ignored.state.dueAt).toBe(900_000);
    const early = await simulateScenarioStep({
      graph,
      state: ignored.state,
      event: { kind: "advance", minutes: 5 },
    });
    expect(early.message).toBeNull();
    expect(early.state.status).toBe("waiting");
  });
  it("follows a menu self-loop once per click", async () => {
    const graph = fixture();
    graph.edges[1].target = "menu";
    const first = await start(graph);
    const again = await simulateScenarioStep({
      graph,
      state: first.state,
      event: { kind: "choice", payload: "wsc:menu:help" },
    });
    expect(again.state.actionNodeId).toBe("menu");
    expect(again.message?.bodyText).toBe("Choose");
    expect(again.state.status).toBe("waiting");
  });
  it("ends explicitly without a customer-facing message", async () => {
    const graph = fixture();
    graph.nodes[2] = {
      id: "help",
      data: { kind: "action", actionType: "end_scenario" },
    } as ScenarioGraphNode;
    const first = await start(graph);
    const result = await simulateScenarioStep({
      graph,
      state: first.state,
      event: { kind: "choice", payload: "wsc:menu:help" },
    });
    expect(result.state.status).toBe("completed");
    expect(result.state.dueAt).toBeNull();
    expect(result.message).toBeNull();
  });
  it("stops at a template even when its form has a Form submitted route", async () => {
    const template = {
      id: "template",
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "demoshop_test",
        actionWhatsAppTemplateLanguage: "ru",
        actionWhatsAppTemplateComponents: [
          {
            type: "BUTTONS",
            buttons: [
              { type: "FLOW", text: "Open form", flow_id: 1571793974235171 },
            ],
          },
        ],
      },
    } as ScenarioGraphNode;
    const result = await simulateScenarioStep({
      graph: {
        nodes: [fixture().nodes[0], template, action("thanks", "Thanks")],
        edges: [
          { id: "entry-template", source: "entry", target: "template" },
          {
            id: "form-path",
            source: "template",
            target: "thanks",
            sourceHandle: ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
          },
        ],
      },
      event: { kind: "start" },
    });
    expect(result.reason).toBe("unsupported_action");
    expect(result.state.status).toBe("blocked");
    expect(result.message).toBeNull();
  });
});

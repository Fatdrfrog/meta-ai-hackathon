import { evaluateScenarioFlow } from "@/lib/airi/scenario/scenario-interactive-replies";
import {
  resolveScenarioDispatchTransition,
  resolveScenarioLocationRouteTarget,
} from "@/lib/airi/scenario/scenario-post-action-routing";
import {
  compileScenarioGraph,
  type ScenarioRuntimeNode,
} from "@icecore/airi-runtime/scenario-graph";
import {
  buildPostActionLocationRouteHandleId,
  buildScenarioActionOutcomeHandleId,
  getScenarioActionOutcomeVirtualNodeId,
  POST_ACTION_LOCATION_ANY_OFFICE_HANDLE_ID,
  POST_ACTION_LOCATION_OUTSIDE_HANDLE_ID,
  SCENARIO_TRIGGER_EVENT_KIND,
  type ScenarioBusinessLocation,
  type ScenarioLocationRouteDecision,
  type ScenarioRuntimeEventKind,
} from "@icecore/scenario-contracts";

function node(id: string, data: Record<string, unknown>): ScenarioRuntimeNode {
  return { id, data: data as ScenarioRuntimeNode["data"] };
}

const office: ScenarioBusinessLocation = {
  key: "abay",
  name: "Abay",
  country: "KZ",
  city: "Almaty",
  cityKey: "almaty",
  tags: [],
  latitude: 43.238949,
  longitude: 76.889709,
  sortOrder: 0,
};

const decisions = {
  kz: { outcome: "route", routeId: "kz", office, distanceMeters: 2100 },
  uz: { outcome: "route", routeId: "uz", office, distanceMeters: 2100 },
  anyOffice: { outcome: "any_office", office, distanceMeters: 2100 },
  outside: { outcome: "outside", office, distanceMeters: 640_000 },
  noOffice: { outcome: "no_office" },
} satisfies Record<string, ScenarioLocationRouteDecision>;

type LocationOutcome = "kz" | "uz" | "location_any_office" | "location_outside";

const outcomeHandle = (outcome: LocationOutcome) =>
  outcome === "kz" || outcome === "uz"
    ? buildScenarioActionOutcomeHandleId({
        type: "location_route",
        routeId: outcome,
      })
    : buildScenarioActionOutcomeHandleId(outcome);

// trigger -> ask (Request location) --route--> target, plus a No reply
// reminder. "uz" is a route the merchant hasn't connected yet.
function locationGraph(
  targets: Partial<Record<LocationOutcome, string>>,
  extraNodes: ScenarioRuntimeNode[] = [],
  extraEdges: Array<{ source: string; target: string }> = []
) {
  return compileScenarioGraph(
    [
      node("trigger", { kind: "trigger", triggerConfig: { enabled: true } }),
      node("ask", {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "whatsapp",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "location_request",
            body: { mode: "fixed", text: "Where are you?" },
          },
        },
        actionOutcomes: {
          version: 2,
          noReply: { enabled: true, timeoutMinutes: 30 },
          locationRoutes: {
            routes: [
              {
                id: "kz",
                label: "Kazakhstan",
                match: { by: "country", values: ["KZ"] },
              },
              { id: "uz", match: { by: "country", values: ["UZ"] } },
            ],
            outside: { maxDistanceKm: 100 },
          },
        },
      }),
      node("reminder", { kind: "action", actionType: "reply" }),
      node("kz-office", { kind: "action", actionType: "reply" }),
      node("any-office", { kind: "action", actionType: "reply" }),
      node("far-away", { kind: "action", actionType: "reply" }),
      ...extraNodes,
    ],
    [
      { source: "trigger", target: "ask" },
      {
        source: "ask",
        sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
        target: "reminder",
      },
      ...Object.entries(targets).map(([outcome, target]) => ({
        source: "ask",
        sourceHandle: outcomeHandle(outcome as LocationOutcome),
        target,
      })),
      ...extraEdges,
    ]
  );
}

const connected = {
  kz: "kz-office",
  location_any_office: "any-office",
  location_outside: "far-away",
} satisfies Partial<Record<LocationOutcome, string>>;

const conditionNodeId = getScenarioActionOutcomeVirtualNodeId("ask");

function resolveTarget(
  graph: ReturnType<typeof compileScenarioGraph>,
  decision: ScenarioLocationRouteDecision,
  conversation: Record<string, unknown> = {}
) {
  return resolveScenarioLocationRouteTarget({
    graph,
    conditionNodeId,
    decision,
    conversation: { _id: "conversation-1", ...conversation } as never,
    channel: "whatsapp",
  });
}

describe("resolveScenarioLocationRouteTarget", () => {
  it("waits on the step's compiled outcome node", () => {
    const graph = locationGraph(connected);

    expect(graph.diagnostics).toEqual([]);
    expect(
      resolveScenarioDispatchTransition({
        graph,
        selectedAction: graph.nodesById.get("ask")!,
        selectedActionType: "reply",
        conversation: { _id: "conversation-1" } as never,
        channel: "whatsapp",
      })
    ).toMatchObject({
      pendingConditionNodeId: conditionNodeId,
      pendingSourceActionNodeId: "ask",
    });
  });

  it("routes a group to its own step", () => {
    expect(resolveTarget(locationGraph(connected), decisions.kz)).toMatchObject(
      {
        decision: decisions.kz,
        status: "routed",
        sourceHandle: buildPostActionLocationRouteHandleId("kz"),
        nextActionNode: expect.objectContaining({ id: "kz-office" }),
      }
    );
  });

  it("sends a group with no connection down Any other office, as Any other office", () => {
    const { decision } = resolveTarget(locationGraph(connected), decisions.uz);
    expect(resolveTarget(locationGraph(connected), decisions.uz)).toMatchObject(
      {
        status: "routed",
        sourceHandle: POST_ACTION_LOCATION_ANY_OFFICE_HANDLE_ID,
        nextActionNode: expect.objectContaining({ id: "any-office" }),
      }
    );
    expect(decision).toEqual({
      outcome: "any_office",
      office: decisions.uz.outcome === "route" ? decisions.uz.office : null,
      distanceMeters:
        decisions.uz.outcome === "route" ? decisions.uz.distanceMeters : null,
    });
  });

  it.each([
    [
      "any_office",
      decisions.anyOffice,
      POST_ACTION_LOCATION_ANY_OFFICE_HANDLE_ID,
      "any-office",
    ],
    [
      "outside",
      decisions.outside,
      POST_ACTION_LOCATION_OUTSIDE_HANDLE_ID,
      "far-away",
    ],
  ] as const)(
    "routes %s to its fixed route",
    (_, decision, sourceHandle, target) => {
      expect(resolveTarget(locationGraph(connected), decision)).toMatchObject({
        status: "routed",
        sourceHandle,
        nextActionNode: expect.objectContaining({ id: target }),
      });
    }
  );

  it("routes nothing without an office", () => {
    expect(
      resolveTarget(locationGraph(connected), decisions.noOffice)
    ).toMatchObject({ status: "unroutable", reason: "no_office" });
  });

  it.each([
    ["an unconnected group", decisions.uz],
    ["Any other office", decisions.anyOffice],
  ])(
    "leaves %s unroutable while Any other office has no step",
    (_, decision) => {
      const graph = locationGraph({
        kz: "kz-office",
        location_outside: "far-away",
      });

      expect(resolveTarget(graph, decision)).toMatchObject({
        status: "unroutable",
        reason: "not_connected",
      });
    }
  );

  it("leaves the cutoff unroutable while it has no step", () => {
    const graph = locationGraph({
      kz: "kz-office",
      location_any_office: "any-office",
    });

    expect(resolveTarget(graph, decisions.outside)).toMatchObject({
      status: "unroutable",
      reason: "not_connected",
    });
  });

  it.each([
    ["audience", { audienceMode: "internalLabel", internalLabel: "vip" }],
    [
      "Only if",
      {
        actionRunConditions: {
          version: 1,
          match: "all",
          conditions: [{ id: "label", type: "internal_label", label: "vip" }],
        },
      },
    ],
  ])(
    "keeps a group whose step the %s filter skips off other routes",
    (_, filter) => {
      const graph = locationGraph({ ...connected, kz: "vip-office" }, [
        node("vip-office", { kind: "action", actionType: "reply", ...filter }),
      ]);

      expect(graph.diagnostics).toEqual([]);
      expect(resolveTarget(graph, decisions.kz)).toMatchObject({
        status: "unroutable",
        reason: "filtered",
      });
      expect(
        resolveTarget(graph, decisions.kz, { internal_labels: ["vip"] })
      ).toMatchObject({
        status: "routed",
        nextActionNode: { id: "vip-office" },
      });
    }
  );

  it("doesn't open a linked scenario", () => {
    const graph = locationGraph({ ...connected, kz: "linked" }, [
      node("linked", {
        kind: "scenario_link",
        linkedScenarioId: "child-scenario",
      }),
    ]);

    expect(resolveTarget(graph, decisions.kz)).toMatchObject({
      status: "unroutable",
      reason: "scenario_link",
    });
  });

  it("follows a logic step to the first step it reaches", () => {
    const graph = locationGraph(
      { ...connected, kz: "filter" },
      [
        node("filter", { kind: "logic", logicType: "audience_filter" }),
        node("after-filter", { kind: "action", actionType: "reply" }),
      ],
      [{ source: "filter", target: "after-filter" }]
    );

    expect(graph.diagnostics).toEqual([]);
    expect(resolveTarget(graph, decisions.kz)).toMatchObject({
      status: "routed",
      sourceHandle: buildPostActionLocationRouteHandleId("kz"),
      nextActionNode: expect.objectContaining({ id: "after-filter" }),
    });
  });

  it("leaves a logic step that reaches no step unroutable", () => {
    const graph = locationGraph({ ...connected, kz: "filter" }, [
      node("filter", { kind: "logic", logicType: "audience_filter" }),
    ]);

    expect(resolveTarget(graph, decisions.kz)).toMatchObject({
      status: "unroutable",
      reason: "no_reachable_step",
    });
  });

  it("leaves a step it can't run unroutable", () => {
    const graph = locationGraph({ ...connected, kz: "future-step" }, [
      node("future-step", { kind: "action", actionType: "future_action" }),
    ]);

    expect(graph.diagnostics).toEqual([]);
    expect(resolveTarget(graph, decisions.kz)).toMatchObject({
      status: "unroutable",
      reason: "no_reachable_step",
    });
  });

  it("fails closed on a graph with blocking diagnostics", () => {
    const graph = compileScenarioGraph(
      [
        node("ask", {
          kind: "action",
          actionType: "reply",
          actionOutcomes: {
            version: 2,
            locationRoutes: {
              routes: [
                { id: "kz", match: { by: "country", values: ["KZ"] } },
                { id: "kz", match: { by: "country", values: ["UZ"] } },
              ],
            },
          },
        }),
        node("kz-office", { kind: "action", actionType: "reply" }),
      ],
      [
        {
          source: "ask",
          sourceHandle: outcomeHandle("kz"),
          target: "kz-office",
        },
      ]
    );

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({ code: "duplicate_action_location_route_id" }),
    ]);
    expect(resolveTarget(graph, decisions.kz)).toMatchObject({
      status: "unroutable",
    });
  });
});

describe("claimed location continuations", () => {
  const continueTo = (
    graph: ReturnType<typeof compileScenarioGraph>,
    target: string,
    triggerEventKind: ScenarioRuntimeEventKind,
    continuationSourceActionNodeId?: string
  ) =>
    evaluateScenarioFlow({
      graph,
      conversation: { _id: "conversation-1" } as never,
      channel: "whatsapp",
      preferredActionNodeId: target,
      requiredActionNodeId: target,
      continuationSourceActionNodeId,
      matchedTriggerNodeId: "trigger",
      triggerEventKind,
    });

  it.each([
    ["a group", decisions.kz, "kz-office"],
    ["an unconnected group", decisions.uz, "any-office"],
    ["the cutoff", decisions.outside, "far-away"],
  ])("continues %s to the step it routed to", (_, decision, target) => {
    const graph = locationGraph(connected);
    const routed = resolveTarget(graph, decision);

    expect(routed).toMatchObject({ nextActionNode: { id: target } });
    for (const continuationSource of ["ask", undefined]) {
      expect(
        continueTo(
          graph,
          target,
          SCENARIO_TRIGGER_EVENT_KIND.postActionUserReply,
          continuationSource
        )?.pathNodeIds
      ).toEqual(["trigger", "ask", conditionNodeId, target]);
    }
  });

  it("keeps location routes closed to typed text", () => {
    const graph = locationGraph(connected);

    for (const target of Object.values(connected)) {
      expect(
        continueTo(
          graph,
          target,
          SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
          "ask"
        )
      ).toBeNull();
    }
  });

  it("still continues a timer to No reply", () => {
    const graph = locationGraph(connected);

    expect(
      continueTo(
        graph,
        "reminder",
        SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout,
        "ask"
      )?.pathNodeIds
    ).toEqual(["trigger", "ask", conditionNodeId, "reminder"]);
  });
});

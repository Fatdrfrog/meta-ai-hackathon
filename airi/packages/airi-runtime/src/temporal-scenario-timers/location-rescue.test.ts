import assert from "node:assert/strict";
import test from "node:test";
import type {
  AiriConversationTimerDescriptor,
  AiriConversationTurnSignal,
} from "@icecore/temporal";
import {
  buildScenarioActionLocationRouteOutcomeHandleId,
  buildScenarioActionOutcomeHandleId,
  getScenarioActionOutcomeVirtualNodeId,
  recordScenarioRoutedLocation,
} from "@icecore/scenario-contracts";
import { isScenarioLocationRescueMessageId } from "../scenario-location-turn";
import type { ScenarioSharedLocationMessage } from "../scenario-runtime-dependencies";
import type { AiriScenarioTimerDependencies } from "./dependencies";
import { planAiriConversationTimer } from "./plan/index";
import { buildAiriConversationTimerTurn } from "./prepare/index";
import { timerHost, waitingConversation, withAutoReplyEnv } from "./testing";
import type { ScenarioRecord } from "./types";

const WAIT_ID = getScenarioActionOutcomeVirtualNodeId("ask");
const WAIT_STARTED_AT = "2026-05-01T00:00:00.000Z";
const SHARED_AT = "2026-05-01T00:10:00.000Z";
// A minute after the share.
const RESCUE_DUE_AT = "2026-05-01T00:11:00.000Z";
// An hour of quiet after the share, the latest message.
const NO_REPLY_DUE_AT = "2026-05-01T01:10:00.000Z";
const NO_REPLY_TURN_ID = `scenario-timeout:post_action_no_reply_timeout:scenario-1:${WAIT_STARTED_AT}`;

const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected host effect");
};

const plannedTurn: AiriConversationTurnSignal = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  messageId: "message-text",
  channel: "whatsapp",
};

const share: ScenarioSharedLocationMessage = {
  messageId: "message-pin",
  date: new Date(SHARED_AT),
  latitude: 43.2567,
  longitude: 76.9286,
  hasReplyContext: false,
  text: "[Location] Abay Ave 10, Almaty",
};

// Compiled graphs are cached by scenario ID and revision.
let revision = 0;

/** A Request location step with a Kazakhstan route and an hour's No reply. */
function locationScenario(
  options: { noReply?: boolean; locationRoutes?: boolean } = {},
): ScenarioRecord {
  const noReply = options.noReply ?? true;
  const withRoutes = options.locationRoutes ?? true;
  const step = (id: string, text: string) => ({
    id,
    data: {
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: text,
    },
  });
  return {
    _id: "scenario-1",
    name: "Nearest office",
    updatedAt: new Date(Date.UTC(2026, 3, 30, 0, 0, 0, ++revision)),
    nodes: [
      { id: "trigger", data: { kind: "trigger" } },
      {
        id: "ask",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          actionReplyText: "Share your location",
          actionOutcomes: {
            version: withRoutes ? 2 : 1,
            ...(noReply
              ? {
                  noReply: {
                    enabled: true,
                    timeoutMinutes: 60,
                    cancelIfPhrases: ["stop"],
                  },
                }
              : {}),
            ...(withRoutes
              ? {
                  locationRoutes: {
                    routes: [
                      { id: "kz", match: { by: "country", values: ["KZ"] } },
                    ],
                  },
                }
              : {}),
          },
        },
      },
      step("kz-step", "Your nearest office"),
      step("remind-step", "Please share your location"),
    ],
    edges: [
      { source: "trigger", target: "ask" },
      ...(withRoutes
        ? [
            {
              source: "ask",
              sourceHandle:
                buildScenarioActionLocationRouteOutcomeHandleId("kz"),
              target: "kz-step",
            },
          ]
        : []),
      ...(noReply
        ? [
            {
              source: "ask",
              sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
              target: "remind-step",
            },
          ]
        : []),
    ],
  };
}

const waitingState = (extra: Record<string, unknown> = {}) => ({
  lockedScenarioId: "scenario-1",
  lockedScenarioName: "Nearest office",
  currentActionNodeId: "ask",
  pendingConditionNodeId: WAIT_ID,
  pendingSourceActionNodeId: "ask",
  pendingStartedAt: WAIT_STARTED_AT,
  pendingLastOutboundMessageId: "message-out-1",
  ...extra,
});

function locationHost(
  options: {
    scenario?: ScenarioRecord;
    scenarioState?: Record<string, unknown>;
    lookups?: Array<
      Parameters<
        NonNullable<AiriScenarioTimerDependencies["findLatestInboundLocation"]>
      >[0]
    >;
    share?: ScenarioSharedLocationMessage | null;
  } & Partial<AiriScenarioTimerDependencies> = {},
): AiriScenarioTimerDependencies {
  const {
    scenario,
    scenarioState,
    lookups,
    share: found,
    ...overrides
  } = options;
  return timerHost({
    loadConversation: async () =>
      waitingConversation({
        airi_scenario_state: scenarioState ?? waitingState(),
      }),
    loadScenario: async () => scenario ?? locationScenario(),
    // The share is the latest message of the wait.
    findLatestMessageAfter: async () => ({ date: SHARED_AT }),
    findLatestInboundLocation: async (scope) => {
      lookups?.push(scope);
      return found === undefined ? share : found;
    },
    ...overrides,
  });
}

function plan(dependencies: AiriScenarioTimerDependencies) {
  return withAutoReplyEnv(undefined, () =>
    planAiriConversationTimer({ turn: plannedTurn }, dependencies),
  );
}

function fire(
  timer: AiriConversationTimerDescriptor,
  dependencies: AiriScenarioTimerDependencies,
) {
  return withAutoReplyEnv(undefined, () =>
    buildAiriConversationTimerTurn(timer, dependencies),
  );
}

function expectedTimer(
  overrides: Partial<AiriConversationTimerDescriptor>,
): AiriConversationTimerDescriptor {
  return {
    kind: "post_action_no_reply_timeout",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    channel: "whatsapp",
    sourceId: "source-1",
    scenarioId: "scenario-1",
    scenarioName: "Nearest office",
    dueAt: NO_REPLY_DUE_AT,
    triggerNodeId: null,
    conditionNodeId: WAIT_ID,
    sourceActionNodeId: "ask",
    linkedConditionId: null,
    waitStartedAt: WAIT_STARTED_AT,
    pendingLastOutboundMessageId: "message-out-1",
    lastInboundMessageId: null,
    lastInboundAt: SHARED_AT,
    lastInboundText: null,
    ...overrides,
  };
}

const rescueTimer = () =>
  expectedTimer({ dueAt: RESCUE_DUE_AT, lastInboundMessageId: "message-pin" });

test("a location step's wait routes a share no turn decided a minute after it arrived", async () => {
  const lookups: NonNullable<Parameters<typeof locationHost>[0]>["lookups"] =
    [];
  const result = await plan(locationHost({ lookups }));

  assert.deepEqual(result.timer, rescueTimer());
  assert.equal(result.reason, "pending_post_action_condition");
  assert.equal(lookups.length, 1);
  assert.deepEqual(
    { ...lookups[0], until: undefined },
    {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      // Meta's whole-second stamps may put a share just before its wait.
      since: new Date("2026-04-30T23:59:58.000Z"),
      until: undefined,
      excludeMessageIds: [],
    },
  );
  assert.ok(lookups[0]!.until instanceof Date);
});

test("the No reply turn routes the share when it is due no later than the rescue", async () => {
  const scenario = locationScenario();
  const ask = (scenario.nodes as Array<{ id: string; data: any }>).find(
    (node) => node.id === "ask",
  )!;
  ask.data.actionOutcomes.noReply.timeoutMinutes = 1;

  const result = await plan(locationHost({ scenario }));

  // Both fall due a minute after the share; No reply also routes it.
  assert.deepEqual(result.timer, expectedTimer({ dueAt: RESCUE_DUE_AT }));
});

test("the wait's No reply timer stays as it was without location routes or the lookup port", async () => {
  const withoutRoutes = await plan(
    locationHost({
      scenario: locationScenario({ locationRoutes: false }),
      findLatestInboundLocation: unexpected,
    }),
  );
  assert.deepEqual(withoutRoutes.timer, expectedTimer({}));

  const withoutPort = await plan(
    locationHost({ findLatestInboundLocation: undefined }),
  );
  assert.deepEqual(withoutPort.timer, expectedTimer({}));

  const noShare = await plan(locationHost({ share: null }));
  assert.deepEqual(noShare.timer, expectedTimer({}));
});

test("shares the scenario decided bound the rescue's lookup", async () => {
  const lookups: NonNullable<Parameters<typeof locationHost>[0]>["lookups"] =
    [];
  const scenarioState = recordScenarioRoutedLocation(waitingState(), {
    scenarioId: "scenario-1",
    entry: {
      sourceActionNodeId: "ask",
      inboundMessageId: "message-decided",
      sharedAt: "2026-05-01T00:05:00.000Z",
      decidedAt: "2026-05-01T00:05:01.000Z",
      source: "turn",
      outcome: "unrouted",
      reason: "not_connected",
    },
  }) as Record<string, unknown>;

  const result = await plan(
    locationHost({ scenarioState, lookups, share: null }),
  );

  assert.deepEqual(result.timer, expectedTimer({}));
  assert.deepEqual(
    lookups.map(({ since, excludeMessageIds }) => ({
      since,
      excludeMessageIds,
    })),
    [
      {
        since: new Date("2026-05-01T00:05:00.000Z"),
        excludeMessageIds: ["message-decided"],
      },
    ],
  );
});

test("a location step without No reply plans a rescue only while a share is undecided", async () => {
  const scenario = locationScenario({ noReply: false });

  const rescue = await plan(locationHost({ scenario }));
  assert.deepEqual(
    rescue.timer,
    expectedTimer({
      dueAt: RESCUE_DUE_AT,
      lastInboundMessageId: "message-pin",
      // Without No reply the wait's quiet period is never read.
      lastInboundAt: null,
    }),
  );

  const idle = await plan(locationHost({ scenario, share: null }));
  assert.equal(idle.timer, null);
  assert.equal(idle.reason, "no_timer");
});

test("a fired rescue becomes its own turn after the step was sent, without stop words", async () => {
  const turns: Array<{ messageId: string; timer: unknown }> = [];
  const result = await fire(
    rescueTimer(),
    locationHost({
      findPendingOutbound: async () => ({ delivery: { status: "sent" } }),
      findTextMessagesAfter: unexpected,
      completeLockedScenarioAndPersist: unexpected,
      buildTimerTurnSignal: async ({ messageId, timer }) => {
        turns.push({ messageId, timer });
        return { ...plannedTurn, messageId };
      },
    }),
  );

  assert.equal(result.reason, "timer_turn_ready");
  const rescueTurnId = `${NO_REPLY_TURN_ID}:location-rescue:message-pin`;
  assert.deepEqual(turns, [{ messageId: rescueTurnId, timer: rescueTimer() }]);
  assert.equal(result.turn?.messageId, rescueTurnId);
  assert.equal(isScenarioLocationRescueMessageId(rescueTurnId), true);
});

test("a rescue whose share was settled hands over to the wait's No reply timer", async () => {
  const result = await fire(
    rescueTimer(),
    locationHost({
      share: null,
      findPendingOutbound: async () => ({ delivery: { status: "sent" } }),
      findTextMessagesAfter: unexpected,
      completeLockedScenarioAndPersist: unexpected,
      buildTimerTurnSignal: unexpected,
    }),
  );

  assert.equal(result.turn, null);
  assert.equal(result.reason, "location_rescue_settled");
  // It fires through the No reply checks when it falls due.
  assert.deepEqual(result.timer, expectedTimer({}));
});

test("a settled rescue on a wait without No reply leaves no timer", async () => {
  const result = await fire(
    expectedTimer({
      dueAt: RESCUE_DUE_AT,
      lastInboundMessageId: "message-pin",
      lastInboundAt: null,
    }),
    locationHost({
      scenario: locationScenario({ noReply: false }),
      share: null,
      buildTimerTurnSignal: unexpected,
    }),
  );

  assert.equal(result.turn, null);
  assert.equal(result.timer, undefined);
  assert.equal(result.reason, "post_action_timer_invalidated");
});

test("a newer share moves a fired rescue to a minute after it", async () => {
  const newer = { ...share, messageId: "message-pin-2" };
  newer.date = new Date(Date.now() + 5 * 60_000);
  const result = await fire(
    rescueTimer(),
    locationHost({
      share: newer,
      findLatestMessageAfter: async () => ({ date: newer.date }),
      buildTimerTurnSignal: unexpected,
    }),
  );

  assert.equal(result.turn, null);
  assert.equal(result.reason, "newer_message_rescheduled");
  assert.equal(result.timer?.lastInboundMessageId, "message-pin-2");
  assert.equal(
    result.timer?.dueAt,
    new Date(newer.date.getTime() + 60_000).toISOString(),
  );
});

test("the No reply timer of a location step keeps its checks and its turn id", async () => {
  const scans: unknown[] = [];
  const turns: string[] = [];
  const result = await fire(
    expectedTimer({}),
    locationHost({
      // The share was routed by its own turn since the timer was armed.
      share: null,
      findPendingOutbound: async () => ({ delivery: { status: "delivered" } }),
      findTextMessagesAfter: async (input) => {
        scans.push(input);
        return [{ text: "where is it?" }];
      },
      buildTimerTurnSignal: async ({ messageId }) => {
        turns.push(messageId);
        return { ...plannedTurn, messageId };
      },
    }),
  );

  assert.equal(result.reason, "timer_turn_ready");
  assert.equal(scans.length, 1);
  assert.deepEqual(turns, [NO_REPLY_TURN_ID]);
  assert.equal(isScenarioLocationRescueMessageId(NO_REPLY_TURN_ID), false);
});

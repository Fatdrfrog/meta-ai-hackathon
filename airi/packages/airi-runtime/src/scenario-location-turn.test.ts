import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  measureScenarioLocationDistanceMeters,
  normalizeScenarioRoutedLocationEntry,
  readScenarioRoutedLocations,
  type ScenarioActionLocationRoutes,
  type ScenarioBusinessLocation,
  type ScenarioRoutedLocationEntry,
} from "@icecore/scenario-contracts";
import type { ScenarioSharedLocationMessage } from "./scenario-runtime-dependencies";
import {
  bucketScenarioLocationDistance,
  buildScenarioLocationRescueMessageId,
  buildScenarioRoutedLocationEntry,
  findUndecidedScenarioLocationShare,
  isScenarioLocationRescueMessageId,
  readPendingScenarioLocationShare,
  readTurnSharedLocation,
  removeSharedLocationText,
  withRoutedScenarioLocation,
} from "./scenario-location-turn";
import { normalizeConversationScenarioState } from "./scenario-state";

const WAIT_STARTED_AT = new Date("2026-10-05T10:00:00.000Z");
const SHARED_AT = new Date("2026-10-05T10:01:00.000Z");
const NOW = new Date("2026-10-05T10:05:00.000Z");
const DECIDED_AT = new Date("2026-10-05T10:01:01.000Z");

const ABAY: ScenarioBusinessLocation = {
  key: "abay",
  name: "Abay",
  country: "KZ",
  city: "Almaty",
  cityKey: "almaty",
  address: "Abay Ave 10",
  phone: "+7 700 000 0000",
  tags: ["mall"],
  latitude: 43.238949,
  longitude: 76.889709,
  sortOrder: 0,
};

const CHILANZAR: ScenarioBusinessLocation = {
  key: "chilanzar",
  name: "Chilanzar",
  country: "UZ",
  city: "Tashkent",
  cityKey: "tashkent",
  tags: [],
  latitude: 41.2995,
  longitude: 69.2401,
  sortOrder: 1,
};

const ROUTING: ScenarioActionLocationRoutes = {
  routes: [{ id: "loc_kz", match: { by: "country", values: ["KZ"] } }],
  outside: { maxDistanceKm: 100 },
};

// About 1.5 km from Abay.
const PIN = { latitude: 43.25, longitude: 76.9 };

function inboundPin(overrides: Record<string, unknown> = {}) {
  return {
    _id: "message-pin",
    direction: "inbound",
    date: SHARED_AT,
    content: "[Location] Abay Ave",
    whatsappLocation: { ...PIN, name: "Abay Ave", address: null },
    ...overrides,
  };
}

function lookupShare(
  overrides: Partial<ScenarioSharedLocationMessage> = {},
): ScenarioSharedLocationMessage {
  return {
    messageId: "message-lost",
    date: new Date("2026-10-05T10:00:30.000Z"),
    ...PIN,
    hasReplyContext: false,
    ...overrides,
  };
}

function ledgerEntry(
  overrides: Partial<ScenarioRoutedLocationEntry> = {},
): ScenarioRoutedLocationEntry {
  return {
    sourceActionNodeId: "ask-location",
    inboundMessageId: "message-earlier",
    sharedAt: "2026-10-05T10:00:10.000Z",
    decidedAt: "2026-10-05T10:00:11.000Z",
    source: "turn",
    outcome: "any_office",
    ...overrides,
  };
}

function stateWithLedger(
  entries: ScenarioRoutedLocationEntry[],
  scenarioId = "scenario-1",
) {
  return {
    lockedScenarioId: "scenario-1",
    currentActionNodeId: "ask-location",
    routedLocations: { scenarioId, entries },
  };
}

type PendingParams = Parameters<typeof readPendingScenarioLocationShare>[0];

function pendingParams(overrides: Partial<PendingParams> = {}): PendingParams {
  return {
    ports: {
      loadBusinessLocations: async () => [ABAY, CHILANZAR],
      findLatestInboundLocation: async () => null,
    },
    workspaceId: "ws",
    conversationId: "conv-1",
    scenarioState: { lockedScenarioId: "scenario-1" },
    scenarioId: "scenario-1",
    waitStartedAt: WAIT_STARTED_AT,
    routing: ROUTING,
    newMessage: inboundPin(),
    isTimerTurn: false,
    now: NOW,
    ...overrides,
  };
}

function recordingPorts(params: {
  offices?: ScenarioBusinessLocation[];
  lookupResult?: ScenarioSharedLocationMessage | null;
}) {
  const lookups: unknown[] = [];
  const catalogReads: unknown[] = [];
  return {
    lookups,
    catalogReads,
    ports: {
      async loadBusinessLocations(scope: { workspaceId: string }) {
        catalogReads.push(scope);
        return params.offices ?? [ABAY, CHILANZAR];
      },
      async findLatestInboundLocation(scope: {
        workspaceId: string;
        conversationId: string;
        since: Date;
        until: Date;
        excludeMessageIds: string[];
      }) {
        lookups.push(scope);
        return params.lookupResult ?? null;
      },
    },
  };
}

describe("readTurnSharedLocation", () => {
  it("reads the stored coordinates of an inbound share", () => {
    assert.deepEqual(readTurnSharedLocation(inboundPin()), {
      messageId: "message-pin",
      date: SHARED_AT,
      ...PIN,
      hasReplyContext: false,
    });
    const share = readTurnSharedLocation(
      inboundPin({
        _id: { toString: () => "65f000000000000000000001" },
        date: SHARED_AT.toISOString(),
        whatsappLocation: { latitude: 43.2500004, longitude: 76.9 },
      }),
    );
    assert.equal(share?.messageId, "65f000000000000000000001");
    assert.equal(share?.date.getTime(), SHARED_AT.getTime());
    assert.equal(share?.latitude, 43.25);
  });

  it("ignores outbound messages and shares without usable numeric coordinates", () => {
    for (const message of [
      null,
      undefined,
      "[Location] 43.25, 76.9",
      inboundPin({ direction: "outbound" }),
      inboundPin({ direction: undefined }),
      inboundPin({ whatsappLocation: undefined }),
      inboundPin({
        whatsappLocation: {
          latitude: null,
          longitude: null,
          name: null,
          address: null,
        },
      }),
      inboundPin({
        whatsappLocation: { latitude: "43.25", longitude: "76.9" },
      }),
      inboundPin({ whatsappLocation: { latitude: 0, longitude: 0 } }),
      inboundPin({ whatsappLocation: { latitude: 91, longitude: 76.9 } }),
      inboundPin({ _id: undefined }),
      inboundPin({ date: undefined }),
      inboundPin({ date: "not a date" }),
    ]) {
      assert.equal(readTurnSharedLocation(message), null);
    }
  });

  it("notes whether the share cited a message", () => {
    assert.equal(
      readTurnSharedLocation(
        inboundPin({ whatsappMeta: { replyToWhatsAppMessageId: "wamid.ask" } }),
      )?.hasReplyContext,
      true,
    );
    for (const whatsappMeta of [
      null,
      {},
      { replyToWhatsAppMessageId: "  " },
      { replyToWhatsAppMessageId: 42 },
    ]) {
      assert.equal(
        readTurnSharedLocation(inboundPin({ whatsappMeta }))?.hasReplyContext,
        false,
      );
    }
  });
});

describe("shared location text", () => {
  it("keeps the share's display text, trimmed, when it has one", () => {
    assert.equal(
      readTurnSharedLocation(inboundPin({ text: " [Location] Abay Ave 10 " }))
        ?.text,
      "[Location] Abay Ave 10",
    );
    assert.equal(
      readTurnSharedLocation(inboundPin({ text: "  " }))?.text,
      undefined,
    );
  });

  it("removes only the share's own line from merged words", () => {
    const share = "[Location] Abay Ave 10, Almaty";
    assert.equal(removeSharedLocationText(`${share}\nвот`, share), "вот");
    assert.equal(
      removeSharedLocationText(`Where is it?\n ${share} `, ` ${share}`),
      "Where is it?",
    );
    assert.equal(removeSharedLocationText(share, share), "");
    assert.equal(
      removeSharedLocationText("[Location] another place", share),
      "[Location] another place",
    );
    assert.equal(removeSharedLocationText(" вот ", undefined), "вот");
  });
});

describe("readPendingScenarioLocationShare", () => {
  it("decides nothing without the Offices catalog port", async () => {
    let lookups = 0;
    for (const newMessage of [
      inboundPin(),
      { _id: "m", direction: "inbound" },
    ]) {
      assert.deepEqual(
        await readPendingScenarioLocationShare(
          pendingParams({
            newMessage,
            ports: {
              findLatestInboundLocation: async () => {
                lookups += 1;
                return lookupShare();
              },
            },
          }),
        ),
        { kind: "none" },
      );
    }
    assert.equal(lookups, 0);
  });

  it("routes the turn's own share to the nearest office from the catalog", async () => {
    const { ports, lookups, catalogReads } = recordingPorts({});
    const pending = await readPendingScenarioLocationShare(
      pendingParams({ ports }),
    );
    assert.deepEqual(pending, {
      kind: "decided",
      share: {
        messageId: "message-pin",
        date: SHARED_AT,
        ...PIN,
        hasReplyContext: false,
      },
      source: "turn",
      decision: {
        outcome: "route",
        routeId: "loc_kz",
        office: ABAY,
        distanceMeters: measureScenarioLocationDistanceMeters(PIN, ABAY),
      },
    });
    assert.deepEqual(catalogReads, [{ workspaceId: "ws" }]);
    assert.deepEqual(lookups, []);
  });

  it("decides with whichever offices the catalog returns", async () => {
    const decide = async (
      offices: ScenarioBusinessLocation[],
      routing: ScenarioActionLocationRoutes = ROUTING,
    ) => {
      const pending = await readPendingScenarioLocationShare(
        pendingParams({ ports: recordingPorts({ offices }).ports, routing }),
      );
      assert.equal(pending.kind, "decided");
      return pending.kind === "decided" ? pending.decision : null;
    };
    const tashkentDistance = measureScenarioLocationDistanceMeters(
      PIN,
      CHILANZAR,
    );
    assert.ok(tashkentDistance > 100_000);
    assert.deepEqual(await decide([CHILANZAR]), {
      outcome: "outside",
      office: CHILANZAR,
      distanceMeters: tashkentDistance,
    });
    assert.deepEqual(await decide([CHILANZAR], { routes: ROUTING.routes }), {
      outcome: "any_office",
      office: CHILANZAR,
      distanceMeters: tashkentDistance,
    });
    assert.deepEqual(await decide([]), {
      outcome: "outside",
      office: null,
      distanceMeters: null,
    });
    assert.deepEqual(await decide([], { routes: [] }), {
      outcome: "no_office",
    });
  });

  it("drops the turn's own share once it was decided", async () => {
    const { ports, lookups, catalogReads } = recordingPorts({});
    // Decided as the same message, at the same time: only the id marks it.
    const scenarioState = stateWithLedger([
      ledgerEntry({
        inboundMessageId: "message-pin",
        sharedAt: SHARED_AT.toISOString(),
      }),
    ]);
    assert.deepEqual(
      await readPendingScenarioLocationShare(
        pendingParams({ ports, scenarioState }),
      ),
      { kind: "stale_turn_share", messageId: "message-pin" },
    );
    assert.deepEqual(catalogReads, []);
    assert.deepEqual(lookups, []);
  });

  it("drops a turn share older than the newest decided share", async () => {
    const { ports, catalogReads } = recordingPorts({});
    assert.deepEqual(
      await readPendingScenarioLocationShare(
        pendingParams({
          ports,
          scenarioState: stateWithLedger([
            ledgerEntry({ sharedAt: "2026-10-05T10:02:00.000Z" }),
          ]),
        }),
      ),
      { kind: "stale_turn_share", messageId: "message-pin" },
    );
    assert.deepEqual(catalogReads, []);
  });

  it("reads another scenario's decisions as no decisions", async () => {
    const pending = await readPendingScenarioLocationShare(
      pendingParams({
        scenarioState: stateWithLedger(
          [
            ledgerEntry({
              inboundMessageId: "message-pin",
              sharedAt: "2026-10-05T10:02:00.000Z",
            }),
          ],
          "scenario-2",
        ),
      }),
    );
    assert.equal(pending.kind, "decided");
  });

  it("drops a turn share from before the wait, allowing the clock skew", async () => {
    const earliest = new Date(WAIT_STARTED_AT.getTime() - 2_000);
    assert.deepEqual(
      await readPendingScenarioLocationShare(
        pendingParams({
          newMessage: inboundPin({ date: new Date(earliest.getTime() - 1) }),
        }),
      ),
      { kind: "stale_turn_share", messageId: "message-pin" },
    );
    const atSkew = await readPendingScenarioLocationShare(
      pendingParams({ newMessage: inboundPin({ date: earliest }) }),
    );
    assert.equal(atSkew.kind, "decided");
    assert.equal(
      atSkew.kind === "decided" ? atSkew.share.date.getTime() : null,
      earliest.getTime(),
    );
    const isoWaitStart = await readPendingScenarioLocationShare(
      pendingParams({
        waitStartedAt: WAIT_STARTED_AT.toISOString(),
        newMessage: inboundPin({ date: new Date(earliest.getTime() - 1) }),
      }),
    );
    assert.equal(isoWaitStart.kind, "stale_turn_share");
  });

  it("looks up a share left behind when the customer's turn has none", async () => {
    const { ports, lookups } = recordingPorts({ lookupResult: lookupShare() });
    const typedAt = new Date("2026-10-05T10:03:00.000Z");
    const pending = await readPendingScenarioLocationShare(
      pendingParams({
        ports,
        scenarioState: stateWithLedger([ledgerEntry()]),
        newMessage: {
          _id: "message-text",
          direction: "inbound",
          date: typedAt,
          content: "вот",
        },
      }),
    );
    assert.deepEqual(lookups, [
      {
        workspaceId: "ws",
        conversationId: "conv-1",
        // The newest decided share is later than the wait start less skew.
        since: new Date("2026-10-05T10:00:10.000Z"),
        until: typedAt,
        excludeMessageIds: ["message-earlier"],
      },
    ]);
    assert.equal(pending.kind, "decided");
    if (pending.kind !== "decided") return;
    assert.equal(pending.source, "lookup");
    assert.deepEqual(pending.share, lookupShare());
    assert.equal(pending.decision.outcome, "route");
  });

  it("looks up until now for a customer turn without a date", async () => {
    const { ports, lookups } = recordingPorts({ lookupResult: lookupShare() });
    await readPendingScenarioLocationShare(
      pendingParams({
        ports,
        newMessage: { _id: "message-text", direction: "inbound" },
      }),
    );
    assert.deepEqual(lookups, [
      {
        workspaceId: "ws",
        conversationId: "conv-1",
        since: new Date(WAIT_STARTED_AT.getTime() - 2_000),
        until: NOW,
        excludeMessageIds: [],
      },
    ]);
  });

  it("looks up until now on a timer turn, never reading the turn's message", async () => {
    const { ports, lookups } = recordingPorts({ lookupResult: lookupShare() });
    const pending = await readPendingScenarioLocationShare(
      pendingParams({
        ports,
        isTimerTurn: true,
        // A timer turn may carry the last inbound message as its anchor.
        newMessage: inboundPin(),
      }),
    );
    assert.deepEqual(lookups, [
      {
        workspaceId: "ws",
        conversationId: "conv-1",
        since: new Date(WAIT_STARTED_AT.getTime() - 2_000),
        until: NOW,
        excludeMessageIds: [],
      },
    ]);
    assert.equal(pending.kind, "decided");
    if (pending.kind !== "decided") return;
    assert.equal(pending.source, "timer");
    assert.equal(pending.share.messageId, "message-lost");
  });

  it("decides nothing when no share is found", async () => {
    const textTurn = { _id: "message-text", direction: "inbound", date: NOW };
    const absent = recordingPorts({});
    assert.deepEqual(
      await readPendingScenarioLocationShare(
        pendingParams({
          newMessage: textTurn,
          ports: { loadBusinessLocations: absent.ports.loadBusinessLocations },
        }),
      ),
      { kind: "none" },
    );
    const empty = recordingPorts({ lookupResult: null });
    for (const isTimerTurn of [false, true]) {
      assert.deepEqual(
        await readPendingScenarioLocationShare(
          pendingParams({
            newMessage: textTurn,
            ports: empty.ports,
            isTimerTurn,
          }),
        ),
        { kind: "none" },
      );
    }
    assert.equal(empty.lookups.length, 2);
    assert.deepEqual(absent.catalogReads, []);
    assert.deepEqual(empty.catalogReads, []);
  });

  it("looks nothing up without the wait's start, yet decides the turn's own share", async () => {
    for (const waitStartedAt of [null, undefined, "not a date"]) {
      const { ports, lookups } = recordingPorts({
        lookupResult: lookupShare(),
      });
      assert.deepEqual(
        await readPendingScenarioLocationShare(
          pendingParams({
            ports,
            waitStartedAt,
            newMessage: {
              _id: "message-text",
              direction: "inbound",
              date: NOW,
            },
          }),
        ),
        { kind: "none" },
      );
      assert.deepEqual(
        await readPendingScenarioLocationShare(
          pendingParams({ ports, waitStartedAt, isTimerTurn: true }),
        ),
        { kind: "none" },
      );
      assert.deepEqual(lookups, []);

      const turn = await readPendingScenarioLocationShare(
        pendingParams({ ports, waitStartedAt }),
      );
      assert.equal(turn.kind, "decided");
      assert.equal(turn.kind === "decided" ? turn.source : null, "turn");
    }
  });

  it("leaves port failures to the caller, so the turn is retried", async () => {
    await assert.rejects(
      readPendingScenarioLocationShare(
        pendingParams({
          ports: {
            loadBusinessLocations: async () => {
              throw new Error("catalog unavailable");
            },
          },
        }),
      ),
      /catalog unavailable/,
    );
    await assert.rejects(
      readPendingScenarioLocationShare(
        pendingParams({
          newMessage: { _id: "message-text", direction: "inbound", date: NOW },
          ports: {
            loadBusinessLocations: async () => [ABAY],
            findLatestInboundLocation: async () => {
              throw new Error("messages unavailable");
            },
          },
        }),
      ),
      /messages unavailable/,
    );
  });
});

describe("findUndecidedScenarioLocationShare", () => {
  it("looks up from the newest decided share, skipping every decided one", async () => {
    const { ports, lookups } = recordingPorts({ lookupResult: lookupShare() });

    const share = await findUndecidedScenarioLocationShare({
      findLatestInboundLocation: ports.findLatestInboundLocation,
      workspaceId: "ws",
      conversationId: "conv-1",
      scenarioState: stateWithLedger([ledgerEntry()]),
      scenarioId: "scenario-1",
      waitStartedAt: WAIT_STARTED_AT.toISOString(),
      until: NOW,
    });

    assert.deepEqual(share, lookupShare());
    assert.deepEqual(lookups, [
      {
        workspaceId: "ws",
        conversationId: "conv-1",
        since: new Date("2026-10-05T10:00:10.000Z"),
        until: NOW,
        excludeMessageIds: ["message-earlier"],
      },
    ]);
  });

  it("looks nothing up without the wait's start", async () => {
    const { ports, lookups } = recordingPorts({ lookupResult: lookupShare() });

    assert.equal(
      await findUndecidedScenarioLocationShare({
        findLatestInboundLocation: ports.findLatestInboundLocation,
        workspaceId: "ws",
        conversationId: "conv-1",
        scenarioState: {},
        scenarioId: "scenario-1",
        waitStartedAt: null,
        until: NOW,
      }),
      null,
    );
    assert.deepEqual(lookups, []);
  });
});

describe("location rescue turn ids", () => {
  const noReplyTurnId =
    "scenario-timeout:post_action_no_reply_timeout:scenario-1:2026-10-05T10:00:00.000Z";

  it("tells a rescue's turn apart from the wait's No reply turn", () => {
    const rescueTurnId = buildScenarioLocationRescueMessageId(
      noReplyTurnId,
      "message-pin",
    );

    assert.equal(rescueTurnId, `${noReplyTurnId}:location-rescue:message-pin`);
    assert.equal(isScenarioLocationRescueMessageId(rescueTurnId), true);
    assert.equal(isScenarioLocationRescueMessageId(noReplyTurnId), false);
  });

  it("never takes a customer's message for a rescue", () => {
    for (const value of [
      "message-pin:location-rescue:message-pin",
      "wamid.location-rescue:1",
      null,
      undefined,
      42,
    ]) {
      assert.equal(isScenarioLocationRescueMessageId(value), false);
    }
  });
});

describe("buildScenarioRoutedLocationEntry", () => {
  const share = lookupShare({ messageId: "message-pin", date: SHARED_AT });
  const distanceMeters = 1_480;
  const abaySnapshot = {
    key: "abay",
    name: "Abay",
    country: "KZ",
    city: "Almaty",
    cityKey: "almaty",
    address: "Abay Ave 10",
    phone: "+7 700 000 0000",
    tags: ["mall"],
    latitude: 43.238949,
    longitude: 76.889709,
  };
  const base = {
    sourceActionNodeId: "ask-location",
    inboundMessageId: "message-pin",
    sharedAt: "2026-10-05T10:01:00.000Z",
    decidedAt: "2026-10-05T10:01:01.000Z",
  };

  function build(
    decision: Parameters<
      typeof buildScenarioRoutedLocationEntry
    >[0]["decision"],
    extra: {
      source?: "turn" | "lookup" | "timer";
      unroutedReason?: string | null;
    } = {},
  ) {
    const entry = buildScenarioRoutedLocationEntry({
      sourceActionNodeId: "ask-location",
      share,
      source: extra.source ?? "turn",
      decision,
      unroutedReason: extra.unroutedReason,
      decidedAt: DECIDED_AT,
    });
    // The ledger reads back every entry as built, and never holds the
    // customer's own coordinates.
    assert.deepEqual(normalizeScenarioRoutedLocationEntry(entry), entry);
    assert.equal(JSON.stringify(entry).includes(String(PIN.latitude)), false);
    return entry;
  }

  it("records a route with the office as it was chosen", () => {
    assert.deepEqual(
      build({
        outcome: "route",
        routeId: "loc_kz",
        office: ABAY,
        distanceMeters,
      }),
      {
        ...base,
        source: "turn",
        outcome: "route",
        routeId: "loc_kz",
        office: abaySnapshot,
        distanceMeters,
      },
    );
  });

  it("records Any other office and the cutoff route", () => {
    assert.deepEqual(
      build(
        { outcome: "any_office", office: ABAY, distanceMeters },
        { source: "lookup" },
      ),
      {
        ...base,
        source: "lookup",
        outcome: "any_office",
        office: abaySnapshot,
        distanceMeters,
      },
    );
    assert.deepEqual(
      build(
        { outcome: "outside", office: ABAY, distanceMeters: 640_000 },
        { source: "timer" },
      ),
      {
        ...base,
        source: "timer",
        outcome: "outside",
        office: abaySnapshot,
        distanceMeters: 640_000,
      },
    );
    assert.deepEqual(
      build({ outcome: "outside", office: null, distanceMeters: null }),
      { ...base, source: "turn", outcome: "outside" },
    );
  });

  it("records a share no office could take as unrouted", () => {
    assert.deepEqual(build({ outcome: "no_office" }), {
      ...base,
      source: "turn",
      outcome: "unrouted",
      reason: "no_office",
    });
    assert.deepEqual(
      build({ outcome: "no_office" }, { unroutedReason: "target_unavailable" }),
      {
        ...base,
        source: "turn",
        outcome: "unrouted",
        reason: "target_unavailable",
      },
    );
  });

  it("keeps the office but drops the route of a share that sends nothing", () => {
    assert.deepEqual(
      build(
        { outcome: "route", routeId: "loc_kz", office: ABAY, distanceMeters },
        { unroutedReason: "step_not_built" },
      ),
      {
        ...base,
        source: "turn",
        outcome: "unrouted",
        office: abaySnapshot,
        distanceMeters,
        reason: "step_not_built",
      },
    );
    assert.deepEqual(
      build(
        { outcome: "outside", office: ABAY, distanceMeters: 640_000 },
        { source: "timer", unroutedReason: "target_unavailable" },
      ),
      {
        ...base,
        source: "timer",
        outcome: "unrouted",
        office: abaySnapshot,
        distanceMeters: 640_000,
        reason: "target_unavailable",
      },
    );
  });
});

describe("withRoutedScenarioLocation", () => {
  const entry = ledgerEntry({
    inboundMessageId: "message-pin",
    sharedAt: SHARED_AT.toISOString(),
    outcome: "route",
    routeId: "loc_kz",
  });

  it("records the decision for the scenario that holds the conversation", () => {
    const state = withRoutedScenarioLocation(
      { lockedScenarioId: "scenario-1", currentActionNodeId: "ask-location" },
      "scenario-1",
      entry,
    );
    assert.deepEqual(readScenarioRoutedLocations(state, "scenario-1"), [entry]);
    assert.equal(
      (state as { currentActionNodeId?: string }).currentActionNodeId,
      "ask-location",
    );
    // A retried turn records the same share once.
    assert.deepEqual(
      readScenarioRoutedLocations(
        withRoutedScenarioLocation(state, "scenario-1", entry),
        "scenario-1",
      ),
      [entry],
    );
  });

  it("records it once no scenario holds the conversation", () => {
    for (const lockedScenarioId of [
      null,
      undefined,
      "",
      "  ",
      " scenario-1 ",
    ]) {
      assert.deepEqual(
        readScenarioRoutedLocations(
          withRoutedScenarioLocation({ lockedScenarioId }, "scenario-1", entry),
          "scenario-1",
        ),
        [entry],
      );
    }
    assert.deepEqual(
      readScenarioRoutedLocations(
        withRoutedScenarioLocation(undefined, "scenario-1", entry),
        "scenario-1",
      ),
      [entry],
    );
  });

  it("leaves another locked scenario's state untouched", () => {
    const held = stateWithLedger([ledgerEntry()], "scenario-2");
    const lockedByOther = { ...held, lockedScenarioId: "scenario-2" };
    assert.equal(
      withRoutedScenarioLocation(lockedByOther, "scenario-1", entry),
      lockedByOther,
    );
    assert.equal(
      readScenarioRoutedLocations(lockedByOther, "scenario-2").length,
      1,
    );
  });

  it("returns the state unchanged without a decision or a scenario", () => {
    const state = { lockedScenarioId: "scenario-1" };
    assert.equal(withRoutedScenarioLocation(state, "scenario-1", null), state);
    assert.equal(withRoutedScenarioLocation(state, null, entry), state);
    assert.equal(withRoutedScenarioLocation(state, undefined, entry), state);
    assert.equal(withRoutedScenarioLocation(state, "", entry), state);
  });
});

describe("bucketScenarioLocationDistance", () => {
  it("reports distances in buckets at their boundaries", () => {
    for (const [distanceMeters, bucket] of [
      [null, null],
      [undefined, null],
      [0, "<1"],
      [999, "<1"],
      [1_000, "1-5"],
      [4_999, "1-5"],
      [5_000, "5-20"],
      [19_999, "5-20"],
      [20_000, "20-50"],
      [49_999, "20-50"],
      [50_000, "50-100"],
      [99_999, "50-100"],
      [100_000, ">100"],
      [640_000, ">100"],
    ] as const) {
      assert.equal(bucketScenarioLocationDistance(distanceMeters), bucket);
    }
  });
});

describe("routed locations in conversation scenario state", () => {
  it("keeps the routed locations a turn recorded", () => {
    const recorded = withRoutedScenarioLocation(
      { lockedScenarioId: "scenario-1", currentActionNodeId: "ask-location" },
      "scenario-1",
      buildScenarioRoutedLocationEntry({
        sourceActionNodeId: "ask-location",
        share: lookupShare({ messageId: "message-pin", date: SHARED_AT }),
        source: "turn",
        decision: {
          outcome: "route",
          routeId: "loc_kz",
          office: ABAY,
          distanceMeters: 1_480,
        },
        decidedAt: DECIDED_AT,
      }),
    );
    const normalized = normalizeConversationScenarioState(recorded);
    assert.deepEqual(
      normalized?.routedLocations,
      (recorded as { routedLocations?: unknown }).routedLocations,
    );
    assert.equal(normalized?.routedLocations?.entries[0]?.office?.key, "abay");
  });

  it("drops an unreadable ledger", () => {
    for (const routedLocations of [
      undefined,
      null,
      { scenarioId: "scenario-1", entries: [] },
      { scenarioId: "", entries: [ledgerEntry()] },
      { scenarioId: "scenario-1", entries: [{ inboundMessageId: "m" }] },
    ]) {
      assert.equal(
        normalizeConversationScenarioState({
          lockedScenarioId: "scenario-1",
          routedLocations,
        })?.routedLocations,
        null,
      );
    }
  });
});

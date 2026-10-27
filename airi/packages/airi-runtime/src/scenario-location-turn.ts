import {
  normalizeScenarioSharedLocationPoint,
  readScenarioLocationLookupBounds,
  recordScenarioRoutedLocation,
  resolveScenarioLocationRoute,
  toScenarioRoutedLocationOffice,
  type ScenarioActionLocationRoutes,
  type ScenarioLocationDecisionSource,
  type ScenarioLocationRouteDecision,
  type ScenarioRoutedLocationEntry,
} from "@icecore/scenario-contracts";
import type {
  ScenarioRuntimeDependencies,
  ScenarioSharedLocationMessage,
} from "./scenario-runtime-dependencies";

type MessageLike = {
  _id?: unknown;
  date?: unknown;
  direction?: unknown;
  text?: unknown;
  whatsappLocation?: unknown;
  whatsappMeta?: { replyToWhatsAppMessageId?: unknown } | null;
};

function readMessageDate(value: unknown): Date | null {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

/**
 * The location this turn's own inbound message shared, read from the stored
 * coordinates. The `[Location] …` text is a display string and is never
 * parsed.
 */
export function readTurnSharedLocation(
  message: unknown,
): ScenarioSharedLocationMessage | null {
  if (!message || typeof message !== "object") return null;
  const value = message as MessageLike;
  if (value.direction !== "inbound") return null;
  const point = normalizeScenarioSharedLocationPoint(value.whatsappLocation);
  const messageId =
    value._id === null || value._id === undefined ? "" : String(value._id);
  const date = readMessageDate(value.date);
  if (!point || !messageId || !date) return null;
  const replyTo = value.whatsappMeta?.replyToWhatsAppMessageId;
  return {
    messageId,
    date,
    ...point,
    hasReplyContext: typeof replyTo === "string" && replyTo.trim().length > 0,
    ...(typeof value.text === "string" && value.text.trim()
      ? { text: value.text.trim() }
      : {}),
  };
}

/**
 * The customer's words without the display text of a share that a merged
 * turn carries, so a share is never read as typed text.
 */
export function removeSharedLocationText(
  input: string,
  shareText: string | null | undefined,
): string {
  const share = shareText?.trim();
  if (!share) return input.trim();
  return input
    .split("\n")
    .filter((line) => line.trim() !== share)
    .join("\n")
    .trim();
}

/**
 * The newest share since the wait started that the scenario hasn't decided,
 * unless an outbound message already followed it. Turns and the rescue timer
 * look it up the same way.
 */
export async function findUndecidedScenarioLocationShare(params: {
  findLatestInboundLocation: NonNullable<
    ScenarioRuntimeDependencies<unknown>["findLatestInboundLocation"]
  >;
  workspaceId: string;
  conversationId: string;
  scenarioState: unknown;
  scenarioId: string;
  /** The wait's stored start, as a date or ISO string. */
  waitStartedAt: Date | string | null | undefined;
  until: Date;
}): Promise<ScenarioSharedLocationMessage | null> {
  const bounds = readScenarioLocationLookupBounds(params.scenarioState, {
    scenarioId: params.scenarioId,
    waitStartedAt: readMessageDate(params.waitStartedAt),
  });
  if (!bounds.since) return null;
  return params.findLatestInboundLocation({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    since: bounds.since,
    until: params.until,
    excludeMessageIds: bounds.consumedMessageIds,
  });
}

const LOCATION_RESCUE_MESSAGE_ID_MARKER = ":location-rescue:";

/**
 * The turn id of a rescue timer. It differs from the wait's No reply turn,
 * so neither turn, nor what it sends, is taken for the other.
 */
export function buildScenarioLocationRescueMessageId(
  timerMessageId: string,
  shareMessageId: string,
): string {
  return `${timerMessageId}${LOCATION_RESCUE_MESSAGE_ID_MARKER}${shareMessageId}`;
}

/** A rescue timer's turn only routes a share; it never sends a reminder. */
export function isScenarioLocationRescueMessageId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.startsWith("scenario-timeout:") &&
    value.includes(LOCATION_RESCUE_MESSAGE_ID_MARKER)
  );
}

export type PendingScenarioLocationShare =
  /** No undecided share: the event is handled as before. */
  | { kind: "none" }
  /**
   * The turn's own share was already decided, or a newer share was: it is
   * dropped silently, never handled as typed text.
   */
  | { kind: "stale_turn_share"; messageId: string }
  | {
      kind: "decided";
      share: ScenarioSharedLocationMessage;
      source: ScenarioLocationDecisionSource;
      decision: ScenarioLocationRouteDecision;
    };

/**
 * The undecided share a location wait should route, and the route it takes.
 * The turn's own share comes first; otherwise the newest share since the
 * wait started, which a merged or superseded turn may have left behind.
 * Without the catalog port the feature is off and nothing is decided.
 * Port failures throw, so the turn is retried rather than misrouted.
 */
export async function readPendingScenarioLocationShare(params: {
  ports: Pick<
    ScenarioRuntimeDependencies<unknown>,
    "findLatestInboundLocation" | "loadBusinessLocations"
  >;
  workspaceId: string;
  conversationId: string;
  scenarioState: unknown;
  scenarioId: string;
  /** The wait's stored start, as a date or ISO string. */
  waitStartedAt: Date | string | null | undefined;
  routing: ScenarioActionLocationRoutes;
  newMessage: unknown;
  isTimerTurn: boolean;
  now: Date;
}): Promise<PendingScenarioLocationShare> {
  const loadBusinessLocations = params.ports.loadBusinessLocations;
  if (!loadBusinessLocations) return { kind: "none" };

  const bounds = readScenarioLocationLookupBounds(params.scenarioState, {
    scenarioId: params.scenarioId,
    waitStartedAt: readMessageDate(params.waitStartedAt),
  });
  const consumed = new Set(bounds.consumedMessageIds);
  const turnShare = params.isTimerTurn
    ? null
    : readTurnSharedLocation(params.newMessage);

  let share: ScenarioSharedLocationMessage | null = null;
  let source: ScenarioLocationDecisionSource = "turn";
  if (turnShare) {
    if (
      consumed.has(turnShare.messageId) ||
      (bounds.since && turnShare.date.getTime() < bounds.since.getTime())
    ) {
      return { kind: "stale_turn_share", messageId: turnShare.messageId };
    }
    share = turnShare;
  } else if (params.ports.findLatestInboundLocation) {
    share = await findUndecidedScenarioLocationShare({
      findLatestInboundLocation: params.ports.findLatestInboundLocation,
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      scenarioState: params.scenarioState,
      scenarioId: params.scenarioId,
      waitStartedAt: params.waitStartedAt,
      until: params.isTimerTurn
        ? params.now
        : (readMessageDate(
            (params.newMessage as MessageLike | null | undefined)?.date,
          ) ?? params.now),
    });
    source = params.isTimerTurn ? "timer" : "lookup";
  }
  if (!share) return { kind: "none" };

  const offices = await loadBusinessLocations({
    workspaceId: params.workspaceId,
  });
  return {
    kind: "decided",
    share,
    source,
    decision: resolveScenarioLocationRoute({
      routing: params.routing,
      offices,
      point: { latitude: share.latitude, longitude: share.longitude },
    }),
  };
}

/** The ledger entry for a decided share. */
export function buildScenarioRoutedLocationEntry(params: {
  sourceActionNodeId: string;
  share: ScenarioSharedLocationMessage;
  source: ScenarioLocationDecisionSource;
  decision: ScenarioLocationRouteDecision;
  /** Set when the share sends nothing. */
  unroutedReason?: string | null;
  decidedAt: Date;
}): ScenarioRoutedLocationEntry {
  const decision = params.decision;
  const office = decision.outcome === "no_office" ? null : decision.office;
  const distanceMeters =
    decision.outcome === "no_office" ? null : decision.distanceMeters;
  const unroutedReason =
    params.unroutedReason ||
    (decision.outcome === "no_office" ? "no_office" : null);
  return {
    sourceActionNodeId: params.sourceActionNodeId,
    inboundMessageId: params.share.messageId,
    sharedAt: params.share.date.toISOString(),
    decidedAt: params.decidedAt.toISOString(),
    source: params.source,
    outcome:
      unroutedReason || decision.outcome === "no_office"
        ? "unrouted"
        : decision.outcome,
    ...(!unroutedReason && decision.outcome === "route"
      ? { routeId: decision.routeId }
      : {}),
    ...(office ? { office: toScenarioRoutedLocationOffice(office) } : {}),
    ...(typeof distanceMeters === "number" ? { distanceMeters } : {}),
    ...(unroutedReason ? { reason: unroutedReason } : {}),
  };
}

/**
 * Scenario state with a decided share recorded. While another scenario
 * holds the conversation its ledger stays, as with forms and picks.
 */
export function withRoutedScenarioLocation(
  state: unknown,
  scenarioId: string | null | undefined,
  entry: ScenarioRoutedLocationEntry | null,
): unknown {
  if (!entry || !scenarioId) return state;
  const lockedScenarioId =
    state && typeof state === "object"
      ? (state as { lockedScenarioId?: unknown }).lockedScenarioId
      : null;
  if (
    typeof lockedScenarioId === "string" &&
    lockedScenarioId.trim() &&
    lockedScenarioId.trim() !== scenarioId
  ) {
    return state;
  }
  return recordScenarioRoutedLocation(state, { scenarioId, entry });
}

/** Distance buckets for logs, so coordinates never reach them. */
export function bucketScenarioLocationDistance(
  distanceMeters: number | null | undefined,
): string | null {
  if (typeof distanceMeters !== "number") return null;
  const km = distanceMeters / 1000;
  if (km < 1) return "<1";
  if (km < 5) return "1-5";
  if (km < 20) return "5-20";
  if (km < 50) return "20-50";
  if (km < 100) return "50-100";
  return ">100";
}

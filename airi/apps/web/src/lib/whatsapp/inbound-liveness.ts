import { normalizeWhatsAppAccountIdentifiers } from "@icecore/shared/lib/whatsapp/account-identifiers";

/**
 * Decides whether a WhatsApp number has gone quiet in a way its own history
 * says it never does. Control-plane checks (token, webhook subscription, Meta
 * health) can all stay green while Meta stops delivering a number's messages,
 * so this looks only at the inbound activity that actually arrived.
 *
 * The silence is compared with the same stretch of the day on earlier days,
 * so a number that is quiet every night is not flagged at night. It must also
 * outlast the number's longest gap in the weeks before it, so a number that
 * goes quiet every weekend is not flagged on Sunday.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type WhatsAppInboundLivenessConfig = {
  /** Shorter silences are never flagged. */
  minSilenceMs: number;
  /** Earlier days the silence is compared with. */
  referenceDays: number;
  /** Fewer usable earlier days means there is no baseline yet. */
  minReferenceDays: number;
  /** Share of earlier days that had activity in the same stretch. */
  minActiveShare: number;
  /** Typical activity in that stretch on earlier days. */
  minMedianEvents: number;
  /** A history shorter than this many days needs stronger activity. */
  shortBaselineDays: number;
  /** Typical activity required while the history is short. */
  shortBaselineMinMedianEvents: number;
  /** Longest stretch of the day compared. */
  maxWindowMs: number;
  /**
   * History before the silence whose longest gap between inbound messages
   * the silence must exceed. 0 turns the rule off.
   */
  gapHistoryMs: number;
};

export const WHATSAPP_INBOUND_LIVENESS_DEFAULTS: WhatsAppInboundLivenessConfig =
  {
    // Tuned on production receipts from 2026-10-01 to 10-17: these settings
    // catch the 98 h outage of source 7448749f and the 42-49 h gaps of the
    // 10-01 and 10-10 incidents, and ignore ordinary nightly and weekend lulls.
    minSilenceMs: 20 * HOUR_MS,
    referenceDays: 14,
    minReferenceDays: 2,
    minActiveShare: 0.9,
    minMedianEvents: 3,
    shortBaselineDays: 7,
    shortBaselineMinMedianEvents: 20,
    maxWindowMs: DAY_MS,
    // The same-stretch comparison alone flagged two workspaces on
    // 2026-10-18 for weekend lulls that both numbers have every week; the
    // reference days are mostly weekdays. Replayed hourly over production
    // receipts from 09-20 to 10-18, five weeks of gap history cut 12 episodes
    // to 4 and still caught two real outages (10-01, 10-12); four
    // weeks kept one workspace flagged, as its 31 h weekend gap was 29 days old.
    gapHistoryMs: 35 * DAY_MS,
  };

export type WhatsAppInboundLivenessVerdict =
  | { state: "ok"; lastInboundAt: Date }
  | {
      state: "silent";
      lastInboundAt: Date;
      referenceDays: number;
      activeReferenceDays: number;
      medianEvents: number;
      /** Longest earlier gap the silence outlasted (0 when the rule is off). */
      longestGapMs: number;
    }
  | { state: "insufficient_baseline"; lastInboundAt: Date | null };

/** A silence this check flagged, which must not set the bar for the next one. */
export type WhatsAppInboundOutage = { fromMs: number; toMs: number };

/** Index of the first time at or after `value` in ascending `times`. */
function lowerBound(times: readonly number[], value: number) {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (times[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Longest gap between the first `end` times inside [windowStart, last time].
 * When the window start cuts through a gap and earlier history is loaded,
 * that gap counts from the window start. A gap at least half covered by a
 * recorded outage is not ordinary for the number and does not count.
 */
function longestGapMs(
  times: readonly number[],
  end: number,
  windowStart: number,
  monitoredSince: number,
  outages: readonly WhatsAppInboundOutage[]
) {
  const gap = (from: number, to: number) =>
    outages.some(
      outage =>
        2 * (Math.min(to, outage.toMs) - Math.max(from, outage.fromMs)) >=
        to - from
    )
      ? 0
      : to - from;
  const start = Math.max(windowStart, monitoredSince);
  const first = lowerBound(times, start);
  if (first >= end) return 0;
  let longest =
    first > 0 && windowStart >= monitoredSince ? gap(start, times[first]) : 0;
  for (let index = first + 1; index < end; index += 1) {
    longest = Math.max(longest, gap(times[index - 1], times[index]));
  }
  return longest;
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * @param inboundTimes Epoch milliseconds of customer messages and Business
 *   app echoes, in ascending order. Times after `now` are ignored.
 * @param monitoredSince Earliest time the history is trusted for this source
 *   (its creation, or the start of the loaded history).
 * @param outages Earlier silences of this number that were outages.
 */
export function evaluateWhatsAppInboundLiveness({
  inboundTimes,
  now,
  monitoredSince,
  outages = [],
  config = WHATSAPP_INBOUND_LIVENESS_DEFAULTS,
}: {
  inboundTimes: readonly number[];
  now: Date;
  monitoredSince: Date;
  outages?: readonly WhatsAppInboundOutage[];
  config?: WhatsAppInboundLivenessConfig;
}): WhatsAppInboundLivenessVerdict {
  const nowMs = now.getTime();
  const visible = lowerBound(inboundTimes, nowMs + 1);
  const lastMs = visible > 0 ? inboundTimes[visible - 1] : undefined;
  if (lastMs === undefined) {
    return { state: "insufficient_baseline", lastInboundAt: null };
  }
  const lastInboundAt = new Date(lastMs);
  const silenceMs = nowMs - lastMs;
  if (silenceMs < config.minSilenceMs) return { state: "ok", lastInboundAt };

  // A silence no longer than gaps this number already had is ordinary for it.
  const longestEarlierGapMs =
    config.gapHistoryMs > 0
      ? longestGapMs(
          inboundTimes,
          visible,
          lastMs - config.gapHistoryMs,
          monitoredSince.getTime(),
          outages
        )
      : 0;
  if (silenceMs <= longestEarlierGapMs) return { state: "ok", lastInboundAt };

  // Compare with days that ended before the silence began, so a long outage
  // never becomes its own baseline.
  const windowMs = Math.min(silenceMs, config.maxWindowMs);
  const firstDay = Math.max(1, Math.ceil(silenceMs / DAY_MS));
  const counts: number[] = [];
  for (let day = firstDay; counts.length < config.referenceDays; day += 1) {
    const end = nowMs - day * DAY_MS;
    const start = end - windowMs;
    if (start < monitoredSince.getTime()) break;
    counts.push(
      lowerBound(inboundTimes, end) - lowerBound(inboundTimes, start)
    );
  }

  if (counts.length < config.minReferenceDays) {
    return { state: "insufficient_baseline", lastInboundAt };
  }
  const activeReferenceDays = counts.filter(count => count > 0).length;
  const medianEvents = median(counts);
  const minMedianEvents =
    counts.length < config.shortBaselineDays
      ? config.shortBaselineMinMedianEvents
      : config.minMedianEvents;
  const silent =
    activeReferenceDays / counts.length >= config.minActiveShare &&
    medianEvents >= minMedianEvents;

  return silent
    ? {
        state: "silent",
        lastInboundAt,
        referenceDays: counts.length,
        activeReferenceDays,
        medianEvents,
        longestGapMs: longestEarlierGapMs,
      }
    : { state: "ok", lastInboundAt };
}

/**
 * The platform-wide check runs the same detector on every monitored number's
 * receipts together. When all of them go quiet at a time they usually do
 * not, the gap is on our side (webhook route or ingestion), and no customer
 * is told to reconnect. Production receipts never went 4 h unusually quiet
 * from 2026-09-01 to 10-17, while a single number needs 20 h. The longest-gap
 * rule stays off here so an outage on our side is caught within hours.
 */
export const WHATSAPP_INBOUND_LIVENESS_PLATFORM_CONFIG: WhatsAppInboundLivenessConfig =
  {
    ...WHATSAPP_INBOUND_LIVENESS_DEFAULTS,
    minSilenceMs: 4 * HOUR_MS,
    gapHistoryMs: 0,
  };

/** A shown warning must have been confirmed by a recent hourly run. */
export const WHATSAPP_INBOUND_SILENCE_MAX_AGE_MS = 3 * HOUR_MS;

/** Credentials keys the liveness check owns. Cleared with null, never deleted. */
export const WHATSAPP_INBOUND_LIVENESS_KEYS = {
  status: "inbound_liveness_status",
  phoneNumberId: "inbound_liveness_phone_number_id",
  silentSince: "inbound_liveness_silent_since",
  detectedAt: "inbound_liveness_detected_at",
  checkedAt: "inbound_liveness_checked_at",
} as const;

const CLEARED_PATCH = Object.fromEntries(
  Object.values(WHATSAPP_INBOUND_LIVENESS_KEYS).map(key => [key, null])
);

/**
 * Confirmed outages of the source's numbers, as
 * [{ phone_number_id, from, to }] with ISO times: the last message before the
 * silence and the first one after it. An operator records them; the check
 * never does, because a flagged weekend lull that recovered on Monday would
 * then stop counting as ordinary and keep the number flagged every weekend.
 * Kept apart from the flag keys so clearing a flag keeps them.
 */
export const WHATSAPP_INBOUND_LIVENESS_OUTAGES_KEY = "inbound_liveness_outages";

type StoredOutage = { phone_number_id: string; from: string; to: string };

function readStoredOutages(
  credentials: Readonly<Record<string, unknown>>
): StoredOutage[] {
  const value = credentials[WHATSAPP_INBOUND_LIVENESS_OUTAGES_KEY];
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    if (!entry || typeof entry !== "object") return [];
    const { phone_number_id, from, to } = entry as Record<string, unknown>;
    const fromAt = readTime(from);
    const toAt = readTime(to);
    if (
      typeof phone_number_id !== "string" ||
      !phone_number_id ||
      !fromAt ||
      !toAt ||
      toAt.getTime() <= fromAt.getTime()
    ) {
      return [];
    }
    return [
      {
        phone_number_id,
        from: fromAt.toISOString(),
        to: toAt.toISOString(),
      },
    ];
  });
}

/** Recorded outages of this phone number, for evaluateWhatsAppInboundLiveness. */
export function readWhatsAppInboundLivenessOutages(
  credentials: Readonly<Record<string, unknown>>,
  phoneNumberId: string
): WhatsAppInboundOutage[] {
  return readStoredOutages(credentials)
    .filter(outage => outage.phone_number_id === phoneNumberId)
    .map(outage => ({
      fromMs: Date.parse(outage.from),
      toMs: Date.parse(outage.to),
    }));
}

export type WhatsAppInboundSilenceFlag = {
  phoneNumberId: string | null;
  silentSince: Date;
  checkedAt: Date | null;
};

export type WhatsAppInboundLivenessTransition =
  | { kind: "none" }
  | { kind: "silent"; patch: Record<string, unknown>; silentSince: Date }
  | { kind: "still_silent"; patch: Record<string, unknown>; silentSince: Date }
  | {
      kind: "recovered";
      patch: Record<string, unknown>;
      silentSince: Date;
      lastInboundAt: Date;
    }
  /** The flag belongs to a number the source no longer uses. */
  | { kind: "cleared"; patch: Record<string, unknown> };

function readTime(value: unknown): Date | null {
  const time = Date.parse(typeof value === "string" ? value : "");
  return Number.isFinite(time) ? new Date(time) : null;
}

/** The stored silence flag, whether or not it is still current. */
export function readWhatsAppInboundSilenceFlag(
  credentials: Readonly<Record<string, unknown>>
): WhatsAppInboundSilenceFlag | null {
  if (credentials[WHATSAPP_INBOUND_LIVENESS_KEYS.status] !== "silent") {
    return null;
  }
  const phoneNumberId =
    credentials[WHATSAPP_INBOUND_LIVENESS_KEYS.phoneNumberId];
  const silentSince = readTime(
    credentials[WHATSAPP_INBOUND_LIVENESS_KEYS.silentSince]
  );
  if (!silentSince) return null;
  return {
    phoneNumberId:
      typeof phoneNumberId === "string" && phoneNumberId ? phoneNumberId : null,
    silentSince,
    checkedAt:
      readTime(credentials[WHATSAPP_INBOUND_LIVENESS_KEYS.checkedAt]) ??
      readTime(credentials[WHATSAPP_INBOUND_LIVENESS_KEYS.detectedAt]),
  };
}

/**
 * When the source's current number went silent, for showing a warning.
 * A flag for another number, or one no recent run confirmed (the check was
 * turned off or keeps failing), is not shown.
 */
export function getVisibleWhatsAppInboundSilence(
  credentials: Readonly<Record<string, unknown>>,
  nowMs: number
): Date | null {
  const flag = readWhatsAppInboundSilenceFlag(credentials);
  if (!flag?.checkedAt) return null;
  const currentPhone =
    normalizeWhatsAppAccountIdentifiers(credentials).phoneNumberId;
  if (flag.phoneNumberId !== (currentPhone || null)) return null;
  if (nowMs - flag.checkedAt.getTime() > WHATSAPP_INBOUND_SILENCE_MAX_AGE_MS) {
    return null;
  }
  return flag.silentSince;
}

/**
 * A number stays silent until a message arrives after the silence began, so
 * a long outage is reported once and clears on the first message back. Each
 * run that still finds it silent refreshes the check time that keeps the
 * warning visible.
 *
 * @param mayBecomeSilent False when another warning already explains the
 *   silence, or when the whole platform went quiet.
 */
export function decideWhatsAppInboundLivenessTransition({
  credentials,
  phoneNumberId,
  verdict,
  now,
  mayBecomeSilent = true,
}: {
  credentials: Readonly<Record<string, unknown>>;
  phoneNumberId: string;
  verdict: WhatsAppInboundLivenessVerdict;
  now: Date;
  mayBecomeSilent?: boolean;
}): WhatsAppInboundLivenessTransition {
  const flag = readWhatsAppInboundSilenceFlag(credentials);
  if (flag && flag.phoneNumberId !== phoneNumberId) {
    return { kind: "cleared", patch: CLEARED_PATCH };
  }
  if (flag) {
    const lastInboundAt = verdict.lastInboundAt;
    if (lastInboundAt && lastInboundAt.getTime() > flag.silentSince.getTime()) {
      return {
        kind: "recovered",
        silentSince: flag.silentSince,
        lastInboundAt,
        patch: CLEARED_PATCH,
      };
    }
    return {
      kind: "still_silent",
      silentSince: flag.silentSince,
      patch: { [WHATSAPP_INBOUND_LIVENESS_KEYS.checkedAt]: now.toISOString() },
    };
  }

  if (verdict.state !== "silent" || !mayBecomeSilent) return { kind: "none" };
  return {
    kind: "silent",
    silentSince: verdict.lastInboundAt,
    patch: {
      [WHATSAPP_INBOUND_LIVENESS_KEYS.status]: "silent",
      [WHATSAPP_INBOUND_LIVENESS_KEYS.phoneNumberId]: phoneNumberId,
      [WHATSAPP_INBOUND_LIVENESS_KEYS.silentSince]:
        verdict.lastInboundAt.toISOString(),
      [WHATSAPP_INBOUND_LIVENESS_KEYS.detectedAt]: now.toISOString(),
      [WHATSAPP_INBOUND_LIVENESS_KEYS.checkedAt]: now.toISOString(),
    },
  };
}

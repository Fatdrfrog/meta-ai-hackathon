import "server-only";

import WhatsAppWebhookEvent from "@icecore/airi-runtime/whatsapp-webhook-event-model";
import { isDisconnectedWhatsAppSource } from "@icecore/shared/lib/whatsapp/source-state";
import type { Source } from "@icecore/shared/types/sources";
import connectDB from "@/lib/mongoose";
import { createServerLogger } from "@/lib/observability/server-logs";
import { flushServerPostHog, getPostHogClient } from "@/lib/posthog/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { deriveWhatsAppAccountHealth } from "@/lib/whatsapp/account/health";
import { isWhatsAppBusinessAppConnection } from "@/lib/whatsapp/connection-repair-mode";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import { updateCurrentWhatsAppSourceCredentials } from "@/lib/whatsapp/flows/source-rebind-guard";
import {
  WHATSAPP_INBOUND_LIVENESS_DEFAULTS,
  WHATSAPP_INBOUND_LIVENESS_PLATFORM_CONFIG,
  decideWhatsAppInboundLivenessTransition,
  evaluateWhatsAppInboundLiveness,
  readWhatsAppInboundLivenessOutages,
  type WhatsAppInboundLivenessVerdict,
} from "@/lib/whatsapp/inbound-liveness";
import { getWhatsAppConnectionMaintenanceStatus } from "@/lib/whatsapp/token-lifecycle";

const logger = createServerLogger("whatsapp.inbound-liveness");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Room for the reference days and the gap history behind a silence that is
// already a few days old.
const LOOKBACK_MS =
  Math.max(
    WHATSAPP_INBOUND_LIVENESS_DEFAULTS.referenceDays * DAY_MS,
    WHATSAPP_INBOUND_LIVENESS_DEFAULTS.gapHistoryMs
  ) +
  7 * DAY_MS;
// Receipts written for customer messages and WhatsApp Business app echoes.
const INBOUND_FIELDS = ["messages", "smb_message_echoes"];
const INBOUND_ITEM_KINDS = ["message", "messages", "smb_message_echoes"];
// Health reasons that already explain why a number receives nothing.
const SILENCE_EXPLAINING_REASONS = new Set([
  "partner_removed",
  "coexistence_offboarded",
  "waba_disabled",
  "waba_restricted",
  "phone_inaccessible",
  "phone_not_in_waba",
  "phone_not_registered",
  "webhook_reconnect_required",
  "webhook_fields_missing",
]);

type SourceRow = {
  id: string;
  workspace_id: string;
  company_id: string | null;
  created_at: string | null;
  credentials: Record<string, unknown> | null;
};

type HourBucket = {
  _id: { phone: string; slot: number };
  count: number;
  first: Date;
  last: Date;
};

export type WhatsAppInboundLivenessSummary = {
  checked: number;
  silent: Array<{ sourceId: string; workspaceId: string; silentSince: string }>;
  recovered: Array<{ sourceId: string; workspaceId: string }>;
  stillSilent: number;
  cleared: number;
  insufficientBaseline: number;
  explainedElsewhere: number;
  fleetSilent: boolean;
  errors: number;
};

/**
 * Inbound activity per phone number id as ascending epoch milliseconds.
 * Mongo groups receipts into hours counted back from `now`, so every
 * reference window end (`now` minus whole days) falls on a bucket edge. A
 * bucket's receipts are placed at its first and last real times, never
 * earlier than a real receipt.
 */
async function loadInboundTimes(
  phoneNumberIds: string[],
  since: Date,
  now: Date
) {
  await connectDB();
  const buckets = await WhatsAppWebhookEvent.aggregate<HourBucket>([
    {
      $match: {
        phoneNumberId: { $in: phoneNumberIds },
        field: { $in: INBOUND_FIELDS },
        itemKind: { $in: INBOUND_ITEM_KINDS },
        createdAt: { $gte: since, $lte: now },
      },
    },
    {
      $group: {
        _id: {
          phone: "$phoneNumberId",
          slot: {
            $floor: {
              $divide: [{ $subtract: [now, "$createdAt"] }, HOUR_MS],
            },
          },
        },
        count: { $sum: 1 },
        first: { $min: "$createdAt" },
        last: { $max: "$createdAt" },
      },
    },
  ]).option({ maxTimeMS: 20_000 });

  const times = new Map<string, number[]>();
  const ordered = [...buckets].sort(
    (left, right) =>
      new Date(left.first).getTime() - new Date(right.first).getTime()
  );
  for (const bucket of ordered) {
    const phoneTimes = times.get(bucket._id.phone) ?? [];
    for (let index = 1; index < bucket.count; index += 1) {
      phoneTimes.push(new Date(bucket.first).getTime());
    }
    phoneTimes.push(new Date(bucket.last).getTime());
    times.set(bucket._id.phone, phoneTimes);
  }
  return times;
}

/** A warning the customer already sees accounts for the silence. */
function isSilenceExplained(credentials: Record<string, unknown>, now: Date) {
  const maintenance = getWhatsAppConnectionMaintenanceStatus(
    credentials,
    now.getTime()
  ).state;
  return (
    maintenance === "expired" ||
    maintenance === "action_required" ||
    deriveWhatsAppAccountHealth(credentials, {
      now: now.getTime(),
    }).reasons.some(reason => SILENCE_EXPLAINING_REASONS.has(reason.code))
  );
}

function capture(params: {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
  companyId?: string | null;
}) {
  try {
    getPostHogClient()?.capture({
      distinctId: params.distinctId,
      event: params.event,
      properties: params.properties,
      ...(params.companyId ? { groups: { company: params.companyId } } : {}),
    });
  } catch (error) {
    logger.warn("whatsapp_inbound_liveness_capture_failed", {
      event: params.event,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

function captureSourceEvent(params: {
  event: string;
  source: SourceRow;
  phoneNumberId: string;
  wabaId: string;
  silentSince: Date;
  verdict: WhatsAppInboundLivenessVerdict;
  now: Date;
}) {
  const { source, verdict } = params;
  const silenceHours = Math.round(
    (params.now.getTime() - params.silentSince.getTime()) / HOUR_MS
  );
  logger.warn(params.event, {
    workspaceId: source.workspace_id,
    sourceId: source.id,
    silentSince: params.silentSince.toISOString(),
    silenceHours,
  });
  capture({
    distinctId: `airi:workspace:${source.workspace_id}`,
    event: params.event,
    companyId: source.company_id,
    properties: {
      workspace_id: source.workspace_id,
      company_id: source.company_id,
      source_id: source.id,
      phone_number_id: params.phoneNumberId,
      waba_id: params.wabaId,
      channel: "whatsapp",
      business_app_connection: isWhatsAppBusinessAppConnection(
        source.credentials ?? {}
      ),
      silent_since: params.silentSince.toISOString(),
      silence_hours: silenceHours,
      ...(verdict.state === "silent"
        ? {
            reference_days: verdict.referenceDays,
            active_reference_days: verdict.activeReferenceDays,
            median_events: verdict.medianEvents,
            longest_earlier_gap_hours: Math.round(
              verdict.longestGapMs / HOUR_MS
            ),
          }
        : {}),
    },
  });
}

/**
 * Flags active WhatsApp numbers whose inbound messages stopped arriving
 * against their own history, keeps the flag confirmed while the silence
 * lasts, and clears it once a message arrives. Reads Mongo and Supabase
 * only; it makes no Meta API calls.
 */
export async function runWhatsAppInboundLivenessCheck({
  now = new Date(),
}: { now?: Date } = {}): Promise<WhatsAppInboundLivenessSummary> {
  const summary: WhatsAppInboundLivenessSummary = {
    checked: 0,
    silent: [],
    recovered: [],
    stillSilent: 0,
    cleared: 0,
    insufficientBaseline: 0,
    explainedElsewhere: 0,
    fleetSilent: false,
    errors: 0,
  };

  const { data, error } = await supabaseAdmin
    .from("sources")
    .select("id, workspace_id, company_id, created_at, credentials")
    .eq("type", "whatsapp");
  if (error) throw error;

  const sources = ((data ?? []) as SourceRow[])
    .map(source => {
      const credentials = source.credentials ?? {};
      const normalized = normalizeWhatsAppCredentials(credentials);
      return {
        source,
        credentials,
        phoneNumberId: String(normalized.phoneNumberId || "").trim(),
        wabaId: String(normalized.wabaId || "").trim(),
      };
    })
    .filter(
      entry =>
        entry.phoneNumberId &&
        entry.wabaId &&
        !isDisconnectedWhatsAppSource({
          ...entry.source,
          type: "whatsapp",
        } as unknown as Source)
    );
  if (sources.length === 0) return summary;

  const lookbackStart = new Date(now.getTime() - LOOKBACK_MS);
  const phoneNumberIds = [
    ...new Set(sources.map(entry => entry.phoneNumberId)),
  ];
  const times = await loadInboundTimes(phoneNumberIds, lookbackStart, now);

  const platformVerdict = evaluateWhatsAppInboundLiveness({
    inboundTimes: phoneNumberIds
      .flatMap(phoneNumberId => times.get(phoneNumberId) ?? [])
      .sort((left, right) => left - right),
    now,
    monitoredSince: lookbackStart,
    config: WHATSAPP_INBOUND_LIVENESS_PLATFORM_CONFIG,
  });
  summary.fleetSilent = platformVerdict.state === "silent";
  if (platformVerdict.state === "silent") {
    const lastInboundAt = platformVerdict.lastInboundAt.toISOString();
    logger.error(
      "whatsapp_inbound_liveness_fleet_silent",
      new Error("No monitored WhatsApp number is receiving messages"),
      { lastInboundAt, monitoredSources: sources.length }
    );
    capture({
      distinctId: "airi:platform",
      event: "whatsapp_inbound_liveness_fleet_silent",
      properties: {
        last_inbound_at: lastInboundAt,
        silence_hours: Math.round(
          (now.getTime() - platformVerdict.lastInboundAt.getTime()) / HOUR_MS
        ),
        monitored_sources: sources.length,
      },
    });
  }

  for (const entry of sources) {
    const createdAt = Date.parse(entry.source.created_at ?? "");
    const verdict = evaluateWhatsAppInboundLiveness({
      inboundTimes: times.get(entry.phoneNumberId) ?? [],
      now,
      monitoredSince: new Date(
        Math.max(
          lookbackStart.getTime(),
          Number.isFinite(createdAt) ? createdAt : 0
        )
      ),
      outages: readWhatsAppInboundLivenessOutages(
        entry.credentials,
        entry.phoneNumberId
      ),
    });
    const explained = isSilenceExplained(entry.credentials, now);
    const transition = decideWhatsAppInboundLivenessTransition({
      credentials: entry.credentials,
      phoneNumberId: entry.phoneNumberId,
      verdict,
      now,
      mayBecomeSilent: !explained && !summary.fleetSilent,
    });
    summary.checked += 1;
    if (verdict.state === "insufficient_baseline") {
      summary.insufficientBaseline += 1;
    }
    if (explained) summary.explainedElsewhere += 1;
    if (transition.kind === "none") continue;

    try {
      await updateCurrentWhatsAppSourceCredentials({
        workspaceId: entry.source.workspace_id,
        sourceId: entry.source.id,
        expectedWabaId: entry.wabaId,
        expectedPhoneNumberId: entry.phoneNumberId,
        buildCredentials: current => ({ ...current, ...transition.patch }),
      });
    } catch (error) {
      summary.errors += 1;
      logger.warn("whatsapp_inbound_liveness_write_failed", {
        sourceId: entry.source.id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const eventContext = {
      source: entry.source,
      phoneNumberId: entry.phoneNumberId,
      wabaId: entry.wabaId,
      verdict,
      now,
    };
    if (transition.kind === "silent") {
      captureSourceEvent({
        ...eventContext,
        event: "whatsapp_inbound_liveness_silent",
        silentSince: transition.silentSince,
      });
      summary.silent.push({
        sourceId: entry.source.id,
        workspaceId: entry.source.workspace_id,
        silentSince: transition.silentSince.toISOString(),
      });
    } else if (transition.kind === "recovered") {
      captureSourceEvent({
        ...eventContext,
        event: "whatsapp_inbound_liveness_recovered",
        silentSince: transition.silentSince,
      });
      summary.recovered.push({
        sourceId: entry.source.id,
        workspaceId: entry.source.workspace_id,
      });
    } else if (transition.kind === "still_silent") {
      summary.stillSilent += 1;
    } else {
      summary.cleared += 1;
    }
  }

  await flushServerPostHog();
  return summary;
}

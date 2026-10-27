/** Shared provider health for operator admission and worker dispatch. */
import { createHash } from "node:crypto";
import { buildCacheKey, cache } from "@icecore/shared/lib/cache";
import {
  getWhatsAppGraphClient,
  type WhatsAppGraphClient,
} from "@icecore/shared/lib/meta/api";
import { asWhatsAppRecord } from "@icecore/shared/lib/whatsapp/value-utils";
import {
  isBulkCampaignReadiness,
  type BulkCampaignReadiness,
  type BulkCampaignReadinessReason,
} from "@icecore/scenario-contracts";

const graphClient = getWhatsAppGraphClient();

/** Read the business/app/WABA health together. A connected phone alone is insufficient. */
export async function getWABASendingReadiness(params: {
  wabaId?: string | null;
  accessToken?: string | null;
  client?: WhatsAppGraphClient;
  /** Worker reads may share a short cache; operator refresh/admission always read live by default. */
  maxAgeSeconds?: number;
}): Promise<BulkCampaignReadiness> {
  const maxAge = Math.max(
    0,
    Math.min(30, Math.floor(params.maxAgeSeconds || 0)),
  );
  if (!maxAge || !params.wabaId || !params.accessToken)
    return readWABASendingReadiness(params);
  const key = buildCacheKey("whatsapp:business-sending-readiness:v1", [
    params.wabaId,
    createHash("sha256").update(params.accessToken).digest("hex"),
  ]);
  try {
    const cached = await cache.get<unknown>(key);
    if (isBulkCampaignReadiness(cached)) {
      const age = Date.now() - Date.parse(cached.checkedAt);
      if (age >= 0 && age < maxAge * 1000) return cached;
    }
  } catch {
    /* A cache outage falls back to the authoritative provider read. */
  }
  const readiness = await readWABASendingReadiness(params);
  try {
    await cache.set(key, readiness, maxAge);
  } catch {
    /* The completed provider check remains authoritative. */
  }
  return readiness;
}

async function readWABASendingReadiness(params: {
  wabaId?: string | null;
  accessToken?: string | null;
  client?: WhatsAppGraphClient;
}): Promise<BulkCampaignReadiness> {
  const checkedAt = new Date().toISOString();
  const unavailable: BulkCampaignReadiness = {
    state: "unavailable",
    checkedAt,
    remainingCapacity: null,
    reasons: [{ code: "meta_check_unavailable" }],
  };
  if (!params.wabaId?.trim() || !params.accessToken?.trim()) return unavailable;
  try {
    const result = await (params.client || graphClient).getJson<{
      health_status?: unknown;
    }>(params.wabaId, {
      token: params.accessToken,
      query: { fields: "health_status" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const health = asWhatsAppRecord(result?.health_status);
    const state =
      typeof health?.can_send_message === "string"
        ? health.can_send_message.trim().toUpperCase()
        : "";
    const entities = Array.isArray(health?.entities)
      ? health.entities.map(asWhatsAppRecord)
      : [];
    const blocked = entities.filter(
      (entity) => entity?.can_send_message === "BLOCKED",
    );
    if (state === "BLOCKED" || blocked.length) {
      const reasons: BulkCampaignReadinessReason[] = [];
      const seen = new Set<string>();
      for (const entity of [health, ...blocked]) {
        for (const error of Array.isArray(entity?.errors)
          ? entity.errors
          : []) {
          const providerError = asWhatsAppRecord(error);
          const rawCode = providerError?.error_code;
          const providerCode =
            (typeof rawCode === "number" || typeof rawCode === "string") &&
            /^\d+$/.test(String(rawCode))
              ? String(rawCode)
              : undefined;
          if (!providerCode || seen.has(providerCode)) continue;
          seen.add(providerCode);
          reasons.push({
            code:
              providerCode === "141015"
                ? "meta_business_limit"
                : providerCode === "131042"
                  ? "meta_billing"
                  : "meta_sender_restricted",
            providerCode,
          });
          if (reasons.length >= 8) break;
        }
        if (reasons.length >= 8) break;
      }
      return {
        state: "blocked",
        checkedAt,
        remainingCapacity: null,
        reasons: reasons.length
          ? reasons
          : [{ code: "meta_sender_restricted" }],
      };
    }
    // Meta LIMITED still permits sending within account limits (for example,
    // while display-name approval is pending). Only BLOCKED prohibits sending.
    // https://developers.facebook.com/documentation/business-messaging/whatsapp/support/health-status
    if (
      !["AVAILABLE", "LIMITED"].includes(state) ||
      (health?.entities !== undefined && !Array.isArray(health.entities)) ||
      entities.some(
        (entity) =>
          !["AVAILABLE", "LIMITED"].includes(String(entity?.can_send_message)),
      )
    )
      return unavailable;
    return { state: "ready", checkedAt, remainingCapacity: null, reasons: [] };
  } catch {
    // Provider/auth/network failures never become permission to send or leak Graph details to the UI.
    return unavailable;
  }
}

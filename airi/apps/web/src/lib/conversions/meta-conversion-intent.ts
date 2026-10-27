import "server-only";

import { isRemovedWhatsAppSource } from "@/lib/integrations/source-status";
import { validateMetaConversionSnapshot } from "@/lib/meta-ads/whatsapp-conversions-api";
import { fetchSourceWithCredentialsResult } from "@/lib/sources/utils";
import { normalizeWhatsAppAccountIdentifiers } from "@icecore/shared/lib/whatsapp/account-identifiers";
import type { MetaConversionSnapshot } from "@icecore/shared/types/conversion-events";
import { isOnboardingTestSource } from "@icecore/shared/types/sources";
import { asRecord } from "@icecore/shared/lib/value-utils";
import { readWhatsAppConversionsConfiguration } from "./source-config";

export type MetaConversionIntent = {
  meta_delivery_status: "pending" | "not_eligible";
  meta_delivery_snapshot: MetaConversionSnapshot | null;
  meta_delivery_reason: string | null;
};

function unavailable(reason: string): MetaConversionIntent {
  return {
    meta_delivery_status: "not_eligible",
    meta_delivery_snapshot: null,
    meta_delivery_reason: reason,
  };
}

/** Called before the ledger insert so a process crash cannot lose delivery intent. */
export async function prepareMetaConversionIntent(input: {
  workspaceId: string;
  sourceId?: string | null;
  conversionType: string;
  value?: number | null;
  currency?: string | null;
  occurredAt: string;
  metadata?: unknown;
}): Promise<MetaConversionIntent> {
  if (input.conversionType !== "sale" && input.conversionType !== "refund") {
    return unavailable("unsupported_outcome");
  }
  if (!input.sourceId) return unavailable("missing_whatsapp_source");
  const metadata = asRecord(input.metadata);
  const referral = asRecord(metadata.whatsappReferral);
  const ctwaClid =
    typeof referral.ctwaClid === "string" ? referral.ctwaClid.trim() : "";
  const capturedAt =
    typeof referral.capturedAt === "string" ||
    referral.capturedAt instanceof Date
      ? new Date(referral.capturedAt).getTime()
      : NaN;
  const occurredAt = Date.parse(input.occurredAt);
  if (
    metadata.whatsappReferralStatus !== "attributed" ||
    !ctwaClid ||
    !Number.isFinite(capturedAt) ||
    !Number.isFinite(occurredAt) ||
    capturedAt > occurredAt
  ) {
    return unavailable("missing_attributable_click");
  }

  const result = await fetchSourceWithCredentialsResult(
    input.sourceId,
    "whatsapp"
  );
  if (!result.ok)
    throw new Error("WhatsApp conversion configuration lookup failed");
  const source = result.source;
  if (
    !source ||
    source.id !== input.sourceId ||
    source.workspace_id !== input.workspaceId ||
    source.type !== "whatsapp" ||
    isRemovedWhatsAppSource(source) ||
    isOnboardingTestSource(source)
  ) {
    return unavailable("whatsapp_source_unavailable");
  }
  const configuration = readWhatsAppConversionsConfiguration(
    source.credentials
  );
  const identifiers = normalizeWhatsAppAccountIdentifiers(
    asRecord(source.credentials)
  );
  if (!configuration?.enabled) return unavailable("feedback_not_enabled");
  if (!identifiers.wabaId || configuration.waba_id !== identifiers.wabaId) {
    return unavailable("whatsapp_account_changed");
  }
  if (
    configuration.attribution_boundary_at &&
    capturedAt < Date.parse(configuration.attribution_boundary_at)
  ) {
    return unavailable("whatsapp_account_changed");
  }
  const snapshot: MetaConversionSnapshot = {
    sourceId: source.id,
    datasetId: configuration.dataset_id,
    wabaId: configuration.waba_id,
    ctwaClid,
    eventName: input.conversionType === "refund" ? "OrderReturned" : "Purchase",
    eventTime: Math.floor(occurredAt / 1000),
    value: input.value ?? NaN,
    currency: input.currency ?? "",
    ...(configuration.test_event_code
      ? { testEventCode: configuration.test_event_code }
      : {}),
  };
  const invalidReason = validateMetaConversionSnapshot(snapshot);
  if (invalidReason) return unavailable(invalidReason);
  return {
    meta_delivery_status: "pending",
    meta_delivery_snapshot: snapshot,
    meta_delivery_reason: null,
  };
}

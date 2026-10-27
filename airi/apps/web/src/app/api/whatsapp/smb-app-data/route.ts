import { createClient } from "@/lib/supabase/server";
import { requestWhatsAppContactSync } from "@/lib/whatsapp/contact/sync";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import { updateCurrentWhatsAppSourceCredentials } from "@/lib/whatsapp/flows/source-rebind-guard";
import { requestWhatsAppHistorySync } from "@/lib/whatsapp/history-sync";
import { isWhatsAppHistorySyncEligible } from "@/lib/whatsapp/history-sync/eligibility";
import {
  getWhatsAppHistoryRequestAvailability,
  type WhatsAppHistorySyncState,
} from "@icecore/whatsapp/historySyncState";
import { readWhatsAppHistorySyncState } from "@icecore/airi-runtime/whatsapp-history-import-store";
import type { WhatsAppContactSyncState } from "@icecore/shared/lib/whatsapp/contact-sync-state";
import { NextRequest, NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { requiredFieldResponse } from "@/lib/api/json-body";

const COEXISTENCE_ONBOARDING_DOC_URL =
  "https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users";

type SyncType = "history" | "smb_app_state_sync";

type SyncRequest = {
  workspaceId: string;
  syncType: SyncType;
  rangeValue?: number;
  rangeUnit?: "days" | "months";
};

type WhatsAppSourceCredentials = {
  history_sync?: WhatsAppHistorySyncState;
  contact_sync?: {
    requested_at?: string;
    request_id?: string;
  } & Partial<WhatsAppContactSyncState>;
};

function toRangeDays(value: number, unit: "days" | "months") {
  if (unit === "months") {
    return value * 30;
  }
  return value;
}

function syncResultStatus(reason?: string) {
  switch (reason) {
    case "already_requested":
    case "not_coexistence":
    case "webhooks_not_ready":
    case "request_in_flight":
    case "request_outcome_unknown":
    case "onboarding_required":
    case "request_window_expired":
      return 409;
    case "missing_credentials":
      return 400;
    case "persist_failed":
      return 500;
    case "meta_error":
      return 502;
    default:
      return 500;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get("workspaceId");

  if (!workspaceId) return requiredFieldResponse("workspaceId");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { data: source, error } = await supabase
    .from("sources")
    .select("id, credentials")
    .eq("workspace_id", workspaceId)
    .eq("type", "whatsapp")
    .maybeSingle();

  if (error || !source) {
    return NextResponse.json(
      { error: "whatsapp_not_connected" },
      { status: 404 }
    );
  }

  const credentials = (source.credentials || {}) as WhatsAppSourceCredentials;

  let historySync = credentials.history_sync || null;
  if (historySync?.session_id) {
    try {
      historySync = await readWhatsAppHistorySyncState({
        workspaceId,
        sourceId: source.id,
        historySync,
      });
    } catch (error) {
      console.error("[WhatsApp History] Could not read import progress", {
        workspaceId,
        sourceId: source.id,
        error,
      });
      return NextResponse.json(
        { error: "history_sync_status_unavailable" },
        { status: 503 }
      );
    }
  }
  const historyEligible = isWhatsAppHistorySyncEligible(source.credentials);
  const historyAvailability =
    getWhatsAppHistoryRequestAvailability(historySync);

  return NextResponse.json({
    status: "ok",
    data: {
      history_sync: historySync,
      contact_sync: credentials?.contact_sync || null,
      history_sync_eligible: historyEligible,
      history_sync_can_request:
        historyEligible && historyAvailability.canRequest,
      history_sync_request_reason: historyAvailability.reason,
    },
  });
}

export async function POST(request: NextRequest) {
  const payload = (await request.json()) as SyncRequest;
  const workspaceId = payload.workspaceId;
  const syncType = payload.syncType;

  if (!workspaceId || !syncType) {
    return NextResponse.json(
      { error: "workspaceId and syncType are required" },
      { status: 400 }
    );
  }

  if (syncType !== "history" && syncType !== "smb_app_state_sync") {
    return NextResponse.json({ error: "Invalid syncType" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { data: source, error } = await supabase
    .from("sources")
    .select("id, credentials")
    .eq("workspace_id", workspaceId)
    .eq("type", "whatsapp")
    .maybeSingle();

  if (error || !source) {
    return NextResponse.json(
      { error: "whatsapp_not_connected" },
      { status: 404 }
    );
  }

  let rangeDays: number | undefined;
  if (syncType === "history") {
    const submittedRangeUnit = payload.rangeUnit;
    if (
      submittedRangeUnit &&
      submittedRangeUnit !== "days" &&
      submittedRangeUnit !== "months"
    ) {
      return NextResponse.json(
        { error: "rangeUnit must be either 'days' or 'months'" },
        { status: 400 }
      );
    }

    const rangeValue =
      typeof payload.rangeValue === "number" ? payload.rangeValue : undefined;
    const rangeUnit = submittedRangeUnit || "days";

    if (!rangeValue || !Number.isFinite(rangeValue) || rangeValue <= 0) {
      return NextResponse.json(
        { error: "rangeValue must be a positive number" },
        { status: 400 }
      );
    }

    rangeDays = toRangeDays(rangeValue, rangeUnit);
    if (rangeDays > 180) {
      return NextResponse.json(
        { error: "rangeValue exceeds 180 days limit" },
        { status: 400 }
      );
    }
  }

  const credentials = (source.credentials || {}) as WhatsAppSourceCredentials;
  const normalized = normalizeWhatsAppCredentials(source.credentials);
  const expectedWabaId = String(normalized.wabaId || "").trim();
  const expectedPhoneNumberId = String(normalized.phoneNumberId || "").trim();
  const saveCredentials = async (nextCredentials: Record<string, unknown>) => {
    await updateCurrentWhatsAppSourceCredentials({
      workspaceId,
      sourceId: source.id,
      expectedWabaId,
      expectedPhoneNumberId,
      buildCredentials: current => ({
        ...current,
        ...(syncType === "history"
          ? { history_sync: nextCredentials.history_sync }
          : { contact_sync: nextCredentials.contact_sync }),
      }),
    });
  };

  const result =
    syncType === "history"
      ? await requestWhatsAppHistorySync({
          sourceId: source.id,
          workspaceId,
          credentials,
          rangeDays,
        })
      : await requestWhatsAppContactSync({
          sourceId: source.id,
          workspaceId,
          credentials,
          saveCredentials,
        });

  if (!result.requested || result.reason === "persist_failed") {
    return NextResponse.json(
      {
        error:
          result.error ||
          (result.reason === "already_requested"
            ? "Sync has already been requested for this workspace."
            : "Sync request could not be started."),
        actionable: result.actionable,
        docs:
          result.docs ||
          (result.reason === "not_coexistence"
            ? [COEXISTENCE_ONBOARDING_DOC_URL]
            : undefined),
        error_code: result.errorCode || result.reason,
        error_subcode: result.errorSubcode,
        data: {
          history_sync:
            "historySync" in result
              ? result.historySync || null
              : credentials.history_sync || null,
          request_id: result.requestId,
          requested_at: result.requestedAt,
        },
      },
      { status: syncResultStatus(result.reason) }
    );
  }

  return NextResponse.json({
    status: "ok",
    data: {
      request_id: result.requestId,
      requested_at: result.requestedAt,
      sync_type: syncType,
      range_days: rangeDays,
      history_sync:
        "historySync" in result
          ? result.historySync || null
          : credentials.history_sync || null,
      contact_sync:
        "contactSync" in result
          ? result.contactSync || null
          : credentials.contact_sync || null,
    },
  });
}

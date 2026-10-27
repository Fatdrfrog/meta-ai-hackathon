import { createServerLogger } from "@/lib/observability/server-logs";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  buildWhatsAppAccountRowsForSource,
  compactWhatsAppAccountString,
  normalizeWhatsAppAccountIdentifiers,
} from "@icecore/shared/lib/whatsapp/account-identifiers";

const logger = createServerLogger("whatsapp.account-persistence");

type PersistenceResult = {
  persisted: boolean;
  skipped?: boolean;
  error?: string;
};

type WhatsAppAccountPersistenceParams = {
  sourceId: string;
  workspaceId: string;
  companyId?: string | null;
  credentials: Record<string, unknown>;
  isDefault?: boolean;
};

type WhatsAppOnboardingEventParams = {
  eventType: string;
  workspaceId?: string | null;
  companyId?: string | null;
  sourceId?: string | null;
  eventSource?: string | null;
  eventKey?: string | null;
  payload?: Record<string, unknown>;
  accountIdentifiers?: Record<string, unknown> | null;
};

type ObservedWhatsAppPhone = {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
  code_verification_status?: string;
  quality_rating?: string;
};

type ObservedWhatsAppAccount = {
  waba: {
    id?: string;
    name?: string;
    account_review_status?: string;
  };
  phoneNumbers: ObservedWhatsAppPhone[];
  accountType?: string;
  businessId?: string;
  businessName?: string;
};

function isMissingTableError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = (error as { message?: string } | null)?.message || "";
  return (
    code === "42P01" ||
    message.includes("whatsapp_accounts") ||
    message.includes("whatsapp_onboarding_events")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function recordObservedWhatsAppAccountsForCompany(params: {
  companyId?: string | null;
  businessId?: string | null;
  accounts: ObservedWhatsAppAccount[];
}): Promise<PersistenceResult> {
  const companyId = compactWhatsAppAccountString(params.companyId);
  if (!companyId || params.accounts.length === 0) {
    return { persisted: false, skipped: true };
  }

  const observedAt = new Date().toISOString();
  const rows = params.accounts.flatMap(account => {
    const wabaId = compactWhatsAppAccountString(account.waba?.id);
    const businessId =
      compactWhatsAppAccountString(account.businessId) ||
      compactWhatsAppAccountString(params.businessId) ||
      null;

    return account.phoneNumbers
      .map(phone => {
        const phoneNumberId = compactWhatsAppAccountString(phone.id);
        if (!phoneNumberId) return null;

        return {
          source_id: null,
          workspace_id: null,
          company_id: companyId,
          account_key: `phone:${phoneNumberId}`,
          phone_number_id: phoneNumberId,
          cs_id: null,
          messaging_account_id: wabaId,
          legacy_waba_id: wabaId,
          waac_id: null,
          business_id: businessId,
          display_phone_number:
            compactWhatsAppAccountString(phone.display_phone_number) || null,
          verified_name:
            compactWhatsAppAccountString(phone.verified_name) || null,
          is_default: false,
          connection_status: "inactive",
          raw_credentials: {
            observed: true,
            account_type:
              compactWhatsAppAccountString(account.accountType) || null,
            business_name:
              compactWhatsAppAccountString(account.businessName) || null,
            waba_name: compactWhatsAppAccountString(account.waba?.name) || null,
            account_review_status:
              compactWhatsAppAccountString(
                account.waba?.account_review_status
              ) || null,
            code_verification_status:
              compactWhatsAppAccountString(phone.code_verification_status) ||
              null,
            quality_rating:
              compactWhatsAppAccountString(phone.quality_rating) || null,
          },
          last_observed_at: observedAt,
        };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
  });

  const phoneNumberIds = rows
    .map(row => compactWhatsAppAccountString(row.phone_number_id))
    .filter((value): value is string => Boolean(value));

  if (rows.length === 0 || phoneNumberIds.length === 0) {
    return { persisted: false, skipped: true };
  }

  try {
    const { error: deleteError } = await supabaseAdmin
      .from("whatsapp_accounts")
      .delete()
      .eq("company_id", companyId)
      .is("source_id", null)
      .in("phone_number_id", phoneNumberIds);

    if (deleteError && !isMissingTableError(deleteError)) {
      logger.warn("observed whatsapp_accounts cleanup failed", {
        companyId,
        error: deleteError.message,
      });
    }

    const { error } = await supabaseAdmin
      .from("whatsapp_accounts")
      .insert(rows);
    if (error) {
      if (isMissingTableError(error))
        return { persisted: false, skipped: true };
      logger.warn("observed whatsapp_accounts insert failed", {
        companyId,
        error: error.message,
      });
      return { persisted: false, error: error.message };
    }

    return { persisted: true };
  } catch (error) {
    if (isMissingTableError(error)) return { persisted: false, skipped: true };
    logger.warn("observed whatsapp_accounts insert failed", {
      companyId,
      error: errorMessage(error),
    });
    return { persisted: false, error: errorMessage(error) };
  }
}

export async function upsertWhatsAppAccountsForSource(
  params: WhatsAppAccountPersistenceParams
): Promise<PersistenceResult> {
  const observedAt = new Date().toISOString();
  const rows = buildWhatsAppAccountRowsForSource(params).map(row => ({
    ...row,
    // Routing prefers the most recently observed row for a phone, so a
    // partner removal must not lift the removed row above a live duplicate.
    ...(row.connection_status === "removed"
      ? {}
      : { last_observed_at: observedAt }),
    // whatsapp_accounts has no updated_at trigger, so writes must set it.
    updated_at: observedAt,
  }));

  if (rows.length === 0) {
    return { persisted: false, skipped: true };
  }

  try {
    const activePhoneIds = rows
      .map(row => compactWhatsAppAccountString(row.phone_number_id))
      .filter((value): value is string => Boolean(value));
    if (activePhoneIds.length > 0) {
      const staleRowsQuery = supabaseAdmin
        .from("whatsapp_accounts")
        .delete()
        .eq("source_id", params.sourceId);
      for (const phoneNumberId of activePhoneIds) {
        staleRowsQuery.neq("phone_number_id", phoneNumberId);
      }
      const { error: staleDeleteError } = await staleRowsQuery;
      if (staleDeleteError && !isMissingTableError(staleDeleteError)) {
        logger.warn("whatsapp_accounts stale row cleanup failed", {
          sourceId: params.sourceId,
          workspaceId: params.workspaceId,
          error: staleDeleteError.message,
        });
      }
    }

    const { error } = await supabaseAdmin
      .from("whatsapp_accounts")
      .upsert(rows, {
        onConflict: "source_id,account_key",
      });
    if (error) {
      if (isMissingTableError(error))
        return { persisted: false, skipped: true };
      logger.warn("whatsapp_accounts upsert failed", {
        sourceId: params.sourceId,
        workspaceId: params.workspaceId,
        error: error.message,
      });
      return { persisted: false, error: error.message };
    }
    return { persisted: true };
  } catch (error) {
    if (isMissingTableError(error)) return { persisted: false, skipped: true };
    logger.warn("whatsapp_accounts upsert failed", {
      sourceId: params.sourceId,
      workspaceId: params.workspaceId,
      error: errorMessage(error),
    });
    return {
      persisted: false,
      error: errorMessage(error),
    };
  }
}

export async function recordWhatsAppOnboardingEvent(
  params: WhatsAppOnboardingEventParams
): Promise<PersistenceResult> {
  const ids = normalizeWhatsAppAccountIdentifiers(
    params.accountIdentifiers || params.payload
  );
  const workspaceId = compactWhatsAppAccountString(params.workspaceId);
  if (!workspaceId) return { persisted: false, skipped: true };

  const eventKey =
    compactWhatsAppAccountString(params.eventKey) ||
    [
      params.eventType,
      compactWhatsAppAccountString(params.sourceId) || "unknown-source",
      ids.phoneNumberId ||
        ids.csId ||
        ids.messagingAccountId ||
        ids.wabaId ||
        ids.waacId ||
        "unknown-account",
      new Date().toISOString(),
    ].join(":");

  try {
    const { error } = await supabaseAdmin
      .from("whatsapp_onboarding_events")
      .upsert(
        {
          event_type: params.eventType,
          event_source:
            compactWhatsAppAccountString(params.eventSource) || null,
          event_key: eventKey,
          workspace_id: workspaceId,
          company_id: compactWhatsAppAccountString(params.companyId) || null,
          source_id: compactWhatsAppAccountString(params.sourceId) || null,
          phone_number_id: ids.phoneNumberId || null,
          cs_id: ids.csId || null,
          messaging_account_id: ids.messagingAccountId || null,
          legacy_waba_id: ids.wabaId || null,
          waac_id: ids.waacId || null,
          payload: params.payload || {},
          occurred_at: new Date().toISOString(),
        },
        {
          onConflict: "event_key",
          ignoreDuplicates: true,
        }
      );

    if (error) {
      if (isMissingTableError(error))
        return { persisted: false, skipped: true };
      logger.warn("whatsapp_onboarding_events insert failed", {
        eventType: params.eventType,
        workspaceId,
        sourceId: params.sourceId || null,
        error: error.message,
      });
      return { persisted: false, error: error.message };
    }
    return { persisted: true };
  } catch (error) {
    if (isMissingTableError(error)) return { persisted: false, skipped: true };
    logger.warn("whatsapp_onboarding_events insert failed", {
      eventType: params.eventType,
      workspaceId,
      sourceId: params.sourceId || null,
      error: errorMessage(error),
    });
    return {
      persisted: false,
      error: errorMessage(error),
    };
  }
}

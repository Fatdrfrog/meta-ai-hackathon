import {
  runWhatsAppAutoDefaults,
  type AutoDefaultsTrigger,
} from "./auto-defaults";
import { runWhatsAppCatalogSetup } from "./catalog/setup";
import { backfillCloudApiWhatsAppContacts } from "./cloud-api-contact-backfill";
import { requestWhatsAppContactSync } from "./contact/sync";
import { normalizeWhatsAppCredentials } from "./credentials";
import { requestWhatsAppHistorySync } from "./history-sync";
import { WHATSAPP_HISTORY_IMPORT_DEFAULT_RANGE_DAYS } from "@icecore/shared/lib/whatsapp/history-sync-state";

type SetupStep =
  | "auto_defaults"
  | "contact_sync"
  | "catalog_setup"
  | "history_sync";
type SetupFailure = {
  step: SetupStep;
  error: string;
  reason?: string;
  errorCode?: number | string | null;
};

/** Run optional setup after saving a connection, using the caller's fenced saver. */
export async function runWhatsAppPostConnectSetup({
  sourceId,
  workspaceId,
  credentials,
  trigger,
  saveCredentials,
  includeHistory = true,
}: {
  sourceId: string;
  workspaceId: string;
  credentials: Record<string, unknown>;
  trigger: AutoDefaultsTrigger;
  saveCredentials: (credentials: Record<string, unknown>) => Promise<unknown>;
  includeHistory?: boolean;
}) {
  let currentCredentials = credentials;
  const failures: SetupFailure[] = [];
  const persistCredentials = async (
    nextCredentials: Record<string, unknown>
  ) => {
    // Keep accepted import state available for a later save to recover. The
    // injected snapshot saver advances its acknowledged snapshot only on success.
    currentCredentials = nextCredentials;
    await saveCredentials(nextCredentials);
  };
  const recordFailure = (
    step: SetupStep,
    result: {
      skipped?: boolean;
      error?: string | null;
      reason?: string;
      errorCode?: number | string | null;
    }
  ) => {
    if (result.error && !result.skipped) {
      failures.push({
        step,
        error: result.error,
        reason: result.reason,
        errorCode: result.errorCode,
      });
    }
  };

  let autoDefaults;
  try {
    const result = await runWhatsAppAutoDefaults({
      sourceId,
      credentials: currentCredentials,
      trigger,
      saveCredentials: persistCredentials,
    });
    currentCredentials = result.credentials;
    autoDefaults = {
      attempted: true,
      success: result.success,
      warnings: result.warnings,
      status: result.statusPatch,
      credentials: result.credentials,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordFailure("auto_defaults", { error: message });
    autoDefaults = {
      attempted: true,
      success: false,
      warnings: [message],
      status: null,
      credentials,
    };
  }

  const coexistenceMode = Boolean(
    normalizeWhatsAppCredentials(currentCredentials).coexistenceMode
  );
  let contactSync;
  try {
    const params = {
      sourceId,
      workspaceId,
      credentials: currentCredentials,
      saveCredentials: persistCredentials,
    };
    contactSync = coexistenceMode
      ? await requestWhatsAppContactSync(params)
      : await backfillCloudApiWhatsAppContacts(params);
  } catch (error) {
    contactSync = {
      attempted: true,
      skipped: false,
      requested: false,
      ...(coexistenceMode
        ? {}
        : { queued: false, mode: "inline_bounded" as const }),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  recordFailure("contact_sync", contactSync);

  let catalogSetup;
  if (coexistenceMode) {
    catalogSetup = { attempted: false, skipped: true, reason: "coexistence" };
  } else {
    try {
      catalogSetup = {
        attempted: true,
        skipped: false,
        ...(await runWhatsAppCatalogSetup({
          sourceId,
          workspaceId,
          credentials: currentCredentials,
          autoCreate: true,
          linkCatalog: true,
          enableCommerceSettings: true,
          saveCredentials: persistCredentials,
        })),
      };
    } catch (error) {
      catalogSetup = {
        attempted: true,
        skipped: false,
        error: error instanceof Error ? error.message : String(error),
      };
      recordFailure("catalog_setup", { error: catalogSetup.error });
    }
  }

  let historySync:
    | Awaited<ReturnType<typeof requestWhatsAppHistorySync>>
    | undefined;
  if (includeHistory) {
    try {
      // History now owns its CAS mutations; recover an accepted contact result
      // through its original snapshot saver without sending it to Meta again.
      if ("reason" in contactSync && contactSync.reason === "persist_failed") {
        await persistCredentials(currentCredentials);
      }
      historySync = await requestWhatsAppHistorySync({
        sourceId,
        workspaceId,
        credentials: currentCredentials,
      });
      if (historySync.historySync) {
        currentCredentials = { ...currentCredentials, history_sync: historySync.historySync };
      }
    } catch (error) {
      historySync = {
        attempted: true,
        requested: false,
        skipped: false,
      rangeDays: WHATSAPP_HISTORY_IMPORT_DEFAULT_RANGE_DAYS,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    recordFailure("history_sync", historySync);
  }

  return {
    credentials: currentCredentials,
    autoDefaults,
    contactSync,
    catalogSetup,
    historySync,
    failures,
  };
}

import { airiWorkerLogger } from "./logging";

export type BusinessCapabilityUpdateValue = {
  max_daily_conversation_per_phone?: string | number;
  max_daily_conversations_per_business?: string | number;
  max_phone_numbers_per_business?: string | number;
  [key: string]: unknown;
};

type SourceRow = {
  id: string;
  workspace_id: string;
  credentials: Record<string, unknown> | null;
};

type SourceRowInput = {
  id?: unknown;
  workspace_id?: unknown;
  credentials?: unknown;
};

type BusinessCapabilityLogger = {
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
};

export type WhatsAppBusinessCapabilityUpdateDependencies = {
  logger?: BusinessCapabilityLogger;
  now?: () => Date;
  resolveWhatsAppSourcesByAccountIdentifiers: (params: {
    wabaId: string;
    messagingAccountId: string;
  }) => Promise<SourceRowInput[]>;
  updateSourceCredentials: (params: {
    sourceId: string;
    workspaceId: string;
    currentCredentials: Record<string, unknown>;
    credentials: Record<string, unknown>;
  }) => Promise<{ error?: { message?: string } | unknown | null }>;
};

function normalizeCapabilityValue(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asSourceRow(value: SourceRowInput): SourceRow | null {
  if (typeof value.id !== "string" || typeof value.workspace_id !== "string") {
    return null;
  }

  return {
    id: value.id,
    workspace_id: value.workspace_id,
    credentials:
      value.credentials &&
      typeof value.credentials === "object" &&
      !Array.isArray(value.credentials)
        ? (value.credentials as Record<string, unknown>)
        : {},
  };
}

function readErrorMessage(error: unknown) {
  if (!error) return null;
  if (typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : String(message);
  }
  return String(error);
}

export function createWhatsAppBusinessCapabilityUpdateHandler(
  deps: WhatsAppBusinessCapabilityUpdateDependencies,
) {
  const logger = deps.logger || airiWorkerLogger;

  return async function handleBusinessCapabilityUpdate(params: {
    wabaId: string;
    value: BusinessCapabilityUpdateValue;
  }): Promise<{ updated: number }> {
    if (!params.wabaId) {
      logger.warn("business_capability_update skipped (missing WABA id)", {
        keys: Object.keys(params.value || {}),
      });
      return { updated: 0 };
    }

    const sources = (
      await deps.resolveWhatsAppSourcesByAccountIdentifiers({
        wabaId: params.wabaId,
        messagingAccountId: params.wabaId,
      })
    )
      .map(asSourceRow)
      .filter((source): source is SourceRow => Boolean(source));

    if (sources.length === 0) {
      logger.warn("business_capability_update: no matching source", {
        wabaId: params.wabaId,
      });
      return { updated: 0 };
    }

    const maxDailyConversationsPerBusiness = normalizeCapabilityValue(
      params.value.max_daily_conversations_per_business,
    );
    const maxDailyConversationPerPhone = normalizeCapabilityValue(
      params.value.max_daily_conversation_per_phone,
    );
    const maxPhoneNumbersPerBusiness = normalizeCapabilityValue(
      params.value.max_phone_numbers_per_business,
    );
    let updated = 0;

    for (const source of sources) {
      const credentials = source.credentials || {};
      const nextCredentials: Record<string, unknown> = {
        ...credentials,
        business_capability_last_event_at: (
          deps.now?.() ?? new Date()
        ).toISOString(),
        business_capability_raw: params.value,
      };

      if (maxDailyConversationsPerBusiness !== null) {
        nextCredentials.whatsapp_business_manager_messaging_limit =
          maxDailyConversationsPerBusiness;
      }
      if (maxDailyConversationPerPhone !== null) {
        nextCredentials.phone_messaging_limit = maxDailyConversationPerPhone;
      }
      if (maxPhoneNumbersPerBusiness !== null) {
        nextCredentials.max_phone_numbers_per_business =
          maxPhoneNumbersPerBusiness;
      }

      const { error } = await deps.updateSourceCredentials({
        sourceId: source.id,
        workspaceId: source.workspace_id,
        currentCredentials: credentials,
        credentials: nextCredentials,
      });

      if (error) {
        logger.warn("business_capability_update: source update failed", {
          error: readErrorMessage(error),
          sourceId: source.id,
          wabaId: params.wabaId,
          workspaceId: source.workspace_id,
        });
        continue;
      }

      updated += 1;
      logger.info("business_capability_update processed", {
        maxDailyConversationPerPhone,
        maxDailyConversationsPerBusiness,
        maxPhoneNumbersPerBusiness,
        sourceId: source.id,
        wabaId: params.wabaId,
        workspaceId: source.workspace_id,
      });
    }

    return { updated };
  };
}

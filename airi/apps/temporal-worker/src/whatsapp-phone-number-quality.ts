export interface PhoneNumberQualityUpdateValue {
  display_phone_number?: string;
  phone_number?: string;
  phone_number_id?: string;
  cs_id?: string;
  event?: string;
  max_daily_conversations_per_business?: string | number;
  max_daily_conversation_per_phone?: string | number;
  current_limit?: string;
  quality_rating?: string;
  current_quality_rating?: string;
}

type SourceRow = {
  id: string;
  workspace_id: string;
  credentials: Record<string, unknown> | null;
};

type SourceResolutionRow = {
  id?: string;
  workspace_id?: string;
  credentials?: unknown;
};

type PhoneQualityLogger = {
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
};

export type PhoneNumberQualityUpdateHandlerDependencies = {
  logger: PhoneQualityLogger;
  now: () => Date;
  publishWorkspaceAlert: (params: {
    action?: { label: string; url: string };
    dedupeKey: string;
    message: string;
    metadata: Record<string, unknown>;
    title: string;
    type: "critical" | "info";
    workspaceId: string;
  }) => Promise<unknown>;
  resolveWhatsAppSourcesByAccountIdentifiers: (params: {
    csId?: string;
    messagingAccountId?: string;
    phoneNumberId?: string;
    wabaId?: string;
  }) => Promise<SourceResolutionRow[]>;
  updateSourceCredentials: (params: {
    currentCredentials: Record<string, unknown>;
    credentials: Record<string, unknown>;
    sourceId: string;
    workspaceId: string;
  }) => Promise<{ errorMessage: string | null }>;
};

function normalizeDisplayPhone(input: string | undefined | null): string {
  return (input || "").toString().trim().replace(/\s+/g, "");
}

function normalizeLimitValue(input: unknown): string | null {
  if (typeof input === "number" && Number.isFinite(input)) {
    return String(input);
  }

  if (typeof input !== "string") return null;

  const value = input.trim();
  return value.length > 0 ? value.toUpperCase() : null;
}

async function findSourcesForPhone(
  deps: Pick<
    PhoneNumberQualityUpdateHandlerDependencies,
    "resolveWhatsAppSourcesByAccountIdentifiers"
  >,
  params: {
    wabaId: string;
    phoneNumberId?: string | null;
    csId?: string | null;
    displayPhoneNumber: string;
  },
): Promise<SourceRow[]> {
  const target = normalizeDisplayPhone(params.displayPhoneNumber);
  const sources = await deps.resolveWhatsAppSourcesByAccountIdentifiers({
    wabaId: params.wabaId,
    messagingAccountId: params.wabaId,
    phoneNumberId: params.phoneNumberId || undefined,
    csId: params.csId || undefined,
  });

  return sources
    .filter(
      (row) =>
        typeof row?.id === "string" && typeof row?.workspace_id === "string",
    )
    .map(
      (row): SourceRow => ({
        id: row.id as string,
        workspace_id: row.workspace_id as string,
        credentials:
          row.credentials && typeof row.credentials === "object"
            ? (row.credentials as Record<string, unknown>)
            : {},
      }),
    )
    .filter((row) => {
      const creds = row.credentials || {};
      const display = normalizeDisplayPhone(
        (creds.display_phone_number as string | undefined) ||
          (creds.displayPhoneNumber as string | undefined) ||
          "",
      );
      if (!target) return true;
      return display === target;
    });
}

export function createPhoneNumberQualityUpdateHandler(
  deps: PhoneNumberQualityUpdateHandlerDependencies,
) {
  return async function handlePhoneNumberQualityUpdate(params: {
    wabaId: string;
    value: PhoneNumberQualityUpdateValue;
  }): Promise<void> {
    const event = (params.value.event || "").toUpperCase();
    const portfolioMessagingLimit = normalizeLimitValue(
      params.value.max_daily_conversations_per_business,
    );
    const currentLimit =
      portfolioMessagingLimit ||
      normalizeLimitValue(params.value.current_limit) ||
      normalizeLimitValue(params.value.max_daily_conversation_per_phone);
    const qualityRating =
      (
        params.value.quality_rating ||
        params.value.current_quality_rating ||
        ""
      ).toUpperCase() || null;
    const displayPhoneNumber =
      params.value.display_phone_number || params.value.phone_number || "";
    const phoneNumberId = params.value.phone_number_id || params.value.cs_id;

    if (!event) {
      deps.logger.warn("phone_number_quality_update skipped (missing event)", {
        wabaId: params.wabaId,
        displayPhoneNumber,
      });
      return;
    }

    const sources = await findSourcesForPhone(deps, {
      wabaId: params.wabaId,
      phoneNumberId,
      csId: params.value.cs_id,
      displayPhoneNumber,
    });

    if (sources.length === 0) {
      deps.logger.warn("phone_number_quality_update: no matching source", {
        wabaId: params.wabaId,
        phoneNumberId,
        displayPhoneNumber,
        event,
      });
      return;
    }

    for (const source of sources) {
      const baseCreds = source.credentials || {};
      const nextCreds: Record<string, unknown> = {
        ...baseCreds,
        phone_quality_last_event: event,
        phone_quality_last_event_at: deps.now().toISOString(),
      };
      if (portfolioMessagingLimit) {
        nextCreds.whatsapp_business_manager_messaging_limit =
          portfolioMessagingLimit;
        nextCreds.phone_messaging_limit = portfolioMessagingLimit;
      } else if (currentLimit) {
        nextCreds.phone_messaging_limit = currentLimit;
      }
      if (qualityRating) nextCreds.phone_quality_rating = qualityRating;

      const { errorMessage } = await deps.updateSourceCredentials({
        sourceId: source.id,
        workspaceId: source.workspace_id,
        currentCredentials: baseCreds,
        credentials: nextCreds,
      });
      if (errorMessage) {
        deps.logger.warn("phone_number_quality_update: source update failed", {
          workspaceId: source.workspace_id,
          sourceId: source.id,
          event,
          error: errorMessage,
        });
        continue;
      }

      const isDegradation = event === "DOWNGRADE" || event === "FLAGGED";
      const isRecovery = event === "UPGRADE" || event === "UNFLAGGED";
      if (!isDegradation && !isRecovery) continue;

      await deps.publishWorkspaceAlert({
        workspaceId: source.workspace_id,
        type: isDegradation ? "critical" : "info",
        title:
          event === "DOWNGRADE"
            ? "WhatsApp number downgraded"
            : event === "FLAGGED"
              ? "WhatsApp number flagged by Meta"
              : event === "UPGRADE"
                ? "WhatsApp number upgraded"
                : "WhatsApp number unflagged",
        message:
          event === "DOWNGRADE"
            ? `Meta lowered your sending tier${
                currentLimit ? ` (new limit: ${currentLimit})` : ""
              }. Reduce send volume and review recent broadcasts for complaints.`
            : event === "FLAGGED"
              ? "Meta flagged your WhatsApp number. Pause marketing broadcasts, review customer-facing copy, and wait out the review window."
              : event === "UPGRADE"
                ? `Meta raised your sending tier${
                    currentLimit ? ` (new limit: ${currentLimit})` : ""
                  }.`
                : "Meta cleared the flag on your WhatsApp number.",
        dedupeKey: `whatsapp:phone:${source.id}:${event}`,
        action: {
          label: "Open WhatsApp settings",
          url: `/panel/w/${source.workspace_id}/settings/integrations?type=whatsapp`,
        },
        metadata: {
          sourceId: source.id,
          displayPhoneNumber: displayPhoneNumber || null,
          event,
          currentLimit,
          qualityRating,
        },
      });

      deps.logger.info("phone_number_quality_update processed", {
        workspaceId: source.workspace_id,
        sourceId: source.id,
        event,
        currentLimit,
        qualityRating,
      });
    }
  };
}

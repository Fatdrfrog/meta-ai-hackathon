import { compactWhatsAppString } from "@icecore/shared/lib/whatsapp/value-utils";

export type WhatsAppPhoneNumberUsernameUpdateValue = {
  phone_number_id?: string;
  business_phone_number_id?: string;
  cs_id?: string;
  display_phone_number?: string;
  phone_number?: string;
  event?: string;
  status?: string;
  decision?: string;
  username?: string;
  business_username?: string;
  current_username?: string;
  requested_username?: string;
  requested_business_username?: string;
  username_status?: string;
  username_review_status?: string;
  business_username_status?: string;
  rejection_reason?: string;
  reject_reason?: string;
  rejection_reasons?: unknown;
  [key: string]: unknown;
};

type SourceRowInput = {
  id?: unknown;
  workspace_id?: unknown;
  credentials?: unknown;
};

type SourceRow = {
  id: string;
  workspace_id: string;
  credentials: Record<string, unknown>;
};

type WhatsAppPhoneNumberUsernameLogger = {
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (
    message: string,
    error?: Error | unknown,
    context?: Record<string, unknown>,
  ) => void;
};

export type WhatsAppPhoneNumberUsernameUpdateDependencies = {
  findWhatsAppSourceByDisplayPhoneNumber: (
    displayPhoneNumber: string,
  ) => Promise<SourceRowInput | null | undefined>;
  logger: WhatsAppPhoneNumberUsernameLogger;
  now: () => Date;
  resolveWhatsAppSourceByAccountIdentifiers: (params: {
    phoneNumberId?: string;
    csId?: string;
    wabaId?: string;
  }) => Promise<SourceRowInput | null | undefined>;
  updateSourceCredentials: (params: {
    sourceId: string;
    workspaceId: string;
    currentCredentials: Record<string, unknown>;
    credentials: Record<string, unknown>;
  }) => Promise<{ error?: { message?: string } | unknown | null }>;
};

function asSourceRow(
  value: SourceRowInput | null | undefined,
): SourceRow | null {
  if (typeof value?.id !== "string" || typeof value.workspace_id !== "string") {
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

function readErrorMessage(error: unknown): string | null {
  if (!error) return null;
  if (typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : String(message);
  }
  return String(error);
}

export function createWhatsAppPhoneNumberUsernameUpdateHandler(
  deps: WhatsAppPhoneNumberUsernameUpdateDependencies,
) {
  return async function handlePhoneNumberUsernameUpdate(params: {
    wabaId?: string | null;
    value: WhatsAppPhoneNumberUsernameUpdateValue;
  }): Promise<{ updated: boolean; sourceId: string | null }> {
    const phoneNumberId =
      compactWhatsAppString(params.value.phone_number_id) ||
      compactWhatsAppString(params.value.business_phone_number_id);
    const csId = compactWhatsAppString(params.value.cs_id);
    const displayPhoneNumber =
      compactWhatsAppString(params.value.display_phone_number) ||
      compactWhatsAppString(params.value.phone_number);
    const wabaId = compactWhatsAppString(params.wabaId);
    const source =
      asSourceRow(
        phoneNumberId || csId || wabaId
          ? await deps.resolveWhatsAppSourceByAccountIdentifiers({
              phoneNumberId: phoneNumberId || undefined,
              csId: csId || undefined,
              wabaId: wabaId || undefined,
            })
          : null,
      ) ||
      asSourceRow(
        displayPhoneNumber
          ? await deps.findWhatsAppSourceByDisplayPhoneNumber(
              displayPhoneNumber,
            )
          : null,
      );

    if (!source) {
      deps.logger.warn("phone_number_username_update: source not found", {
        wabaId,
        phoneNumberId,
        csId,
        event: compactWhatsAppString(params.value.event),
      });
      return { updated: false, sourceId: null };
    }

    const currentCredentials = source.credentials || {};
    const currentUsernameState =
      currentCredentials.business_username &&
      typeof currentCredentials.business_username === "object" &&
      !Array.isArray(currentCredentials.business_username)
        ? (currentCredentials.business_username as Record<string, unknown>)
        : {};

    const status =
      compactWhatsAppString(params.value.status) ||
      compactWhatsAppString(params.value.username_status) ||
      compactWhatsAppString(params.value.username_review_status) ||
      compactWhatsAppString(params.value.business_username_status) ||
      compactWhatsAppString(params.value.decision);
    const username =
      compactWhatsAppString(params.value.username) ||
      compactWhatsAppString(params.value.business_username) ||
      compactWhatsAppString(params.value.current_username);
    const requestedUsername =
      compactWhatsAppString(params.value.requested_username) ||
      compactWhatsAppString(params.value.requested_business_username);

    const nextCredentials: Record<string, unknown> = {
      ...currentCredentials,
      business_username: {
        ...currentUsernameState,
        ...(username ? { username } : {}),
        ...(status ? { status } : {}),
        event: compactWhatsAppString(params.value.event),
        phone_number_id: phoneNumberId || csId,
        cs_id: csId,
        display_phone_number: displayPhoneNumber,
        requested_username: requestedUsername,
        rejection_reason:
          compactWhatsAppString(params.value.rejection_reason) ||
          compactWhatsAppString(params.value.reject_reason),
        rejection_reasons: Array.isArray(params.value.rejection_reasons)
          ? params.value.rejection_reasons
          : null,
        last_webhook_at: deps.now().toISOString(),
        raw: params.value,
      },
    };

    const { error } = await deps.updateSourceCredentials({
      sourceId: source.id,
      workspaceId: source.workspace_id,
      currentCredentials,
      credentials: nextCredentials,
    });

    if (error) {
      deps.logger.error(
        "phone_number_username_update: source credentials update failed",
        new Error(
          readErrorMessage(error) || "Source credentials update failed",
        ),
        {
          sourceId: source.id,
          workspaceId: source.workspace_id,
          wabaId,
          phoneNumberId,
        },
      );
      return { updated: false, sourceId: source.id };
    }

    deps.logger.info(
      "phone_number_username_update: source credentials updated",
      {
        sourceId: source.id,
        workspaceId: source.workspace_id,
        wabaId,
        phoneNumberId,
        csId,
        status,
        username,
      },
    );

    return { updated: true, sourceId: source.id };
  };
}

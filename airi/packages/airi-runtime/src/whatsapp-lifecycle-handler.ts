import type {
  WhatsAppWebhookBody,
  WhatsAppWebhookChange,
} from "@icecore/shared/lib/whatsapp/webhook-payload";
import {
  readNonEmptyStringField as readStringField,
  asRecord,
} from "@icecore/shared/lib/value-utils";

const LOG_ONLY_LIFECYCLE_FIELDS = new Set([
  "flows",
  "account_alerts",
  "tracking_events",
  "partner_solutions",
  "payment_configuration_update",
  "security",
]);

type LifecycleHandlerParams = {
  wabaId: string;
  value: Record<string, unknown>;
};

type LifecycleFieldHandler = (
  params: LifecycleHandlerParams,
) => Promise<unknown> | unknown;

type WhatsAppLifecycleStatusEvent = {
  field: string;
  receivedAt: string;
  event: string | null;
  value: Record<string, unknown>;
};

type SourceRow = {
  id: string;
  workspace_id: string;
  credentials: Record<string, unknown>;
};

type SourceRowInput = {
  id?: unknown;
  workspace_id?: unknown;
  credentials?: unknown;
};

export type WhatsAppLifecycleRequestLogger = {
  info: (message: string, context?: Record<string, unknown>) => void;
  error: (
    message: string,
    error?: unknown,
    context?: Record<string, unknown>,
  ) => void;
};

export type WhatsAppLifecycleWebhookHandlerDependencies = {
  handleBusinessCapabilityUpdate: LifecycleFieldHandler;
  handlePhoneNumberQualityUpdate: LifecycleFieldHandler;
  handlePhoneNumberUsernameUpdate: LifecycleFieldHandler;
  handleTemplateCategoryUpdate: LifecycleFieldHandler;
  handleTemplateComponentsUpdate: LifecycleFieldHandler;
  handleTemplateQualityUpdate: LifecycleFieldHandler;
  handleTemplateStatusUpdate: LifecycleFieldHandler;
  mergeWhatsAppAccountHealthCredentials: (
    credentials: Record<string, unknown>,
  ) => Record<string, unknown>;
  resolveWhatsAppSourcesByAccountIdentifiers: (params: {
    wabaId: string;
    messagingAccountId: string;
  }) => Promise<SourceRowInput[]>;
  updateSourceCredentials: (params: {
    sourceId: string;
    workspaceId: string;
    currentCredentials: Record<string, unknown>;
    credentials: Record<string, unknown>;
  }) => Promise<{ error?: unknown | null }>;
  now?: () => Date;
};

export type WhatsAppLifecycleWebhookHandlerParams = {
  body: WhatsAppWebhookBody;
  change: WhatsAppWebhookChange;
  requestLogger: WhatsAppLifecycleRequestLogger;
};

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

function readWebhookWabaId(body: WhatsAppWebhookBody) {
  const entry = Array.isArray(body.entry) ? body.entry[0] : null;
  return (entry?.id || "").toString();
}

function readLifecycleEventName(value: Record<string, unknown>) {
  for (const key of ["event", "status", "type", "action", "name"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function buildInformationalHealthPatch(params: {
  field: string;
  value: Record<string, unknown>;
}) {
  const event = readLifecycleEventName(params.value);
  const status = readStringField(params.value, "status");
  const message = readStringField(params.value, "message");

  if (params.field === "payment_configuration_update") {
    return {
      payment_configuration_status: status || event || "unknown",
      ...(event ? { payment_configuration_last_event: event } : {}),
      ...(message ? { payment_configuration_message: message } : {}),
    };
  }

  if (params.field === "account_alerts") {
    return {
      ...(event ? { account_alerts_last_event: event } : {}),
      ...(status ? { account_alerts_last_status: status } : {}),
      ...(message ? { account_alerts_last_message: message } : {}),
    };
  }

  if (params.field === "security") {
    return {
      ...(event ? { security_last_event: event } : {}),
      ...(status ? { security_last_status: status } : {}),
      ...(message ? { security_last_message: message } : {}),
    };
  }

  return {};
}

async function persistWhatsAppLifecycleStatusEvent(
  deps: WhatsAppLifecycleWebhookHandlerDependencies,
  params: {
    wabaId: string;
    field: string;
    value: Record<string, unknown>;
  },
) {
  const sources = (
    await deps.resolveWhatsAppSourcesByAccountIdentifiers({
      wabaId: params.wabaId,
      messagingAccountId: params.wabaId,
    })
  )
    .map(asSourceRow)
    .filter((source): source is SourceRow => Boolean(source));

  const receivedAt = (deps.now?.() ?? new Date()).toISOString();
  const event: WhatsAppLifecycleStatusEvent = {
    field: params.field,
    receivedAt,
    event: readLifecycleEventName(params.value),
    value: params.value,
  };
  let updated = 0;

  for (const source of sources) {
    const credentials = source.credentials || {};
    const nextCredentials = deps.mergeWhatsAppAccountHealthCredentials({
      ...credentials,
      whatsapp_lifecycle_last_event_at: receivedAt,
      whatsapp_lifecycle_last_event_field: params.field,
      whatsapp_lifecycle_events: {
        ...(asRecord(credentials.whatsapp_lifecycle_events) as Record<
          string,
          WhatsAppLifecycleStatusEvent
        >),
        [params.field]: event,
      },
      ...buildInformationalHealthPatch({
        field: params.field,
        value: params.value,
      }),
      diagnostics_last_checked_at: receivedAt,
    });

    const { error } = await deps.updateSourceCredentials({
      sourceId: source.id,
      workspaceId: source.workspace_id,
      currentCredentials: credentials,
      credentials: nextCredentials,
    });

    if (!error) updated += 1;
  }

  return { updated };
}

function createLifecycleFieldHandlers(
  deps: WhatsAppLifecycleWebhookHandlerDependencies,
): Record<string, LifecycleFieldHandler> {
  return {
    business_capability_update: deps.handleBusinessCapabilityUpdate,
    business_username_updates: deps.handlePhoneNumberUsernameUpdate,
    message_template_components_update: deps.handleTemplateComponentsUpdate,
    message_template_quality_update: deps.handleTemplateQualityUpdate,
    message_template_status_update: deps.handleTemplateStatusUpdate,
    phone_number_quality_update: deps.handlePhoneNumberQualityUpdate,
    phone_number_username_update: deps.handlePhoneNumberUsernameUpdate,
    template_category_update: deps.handleTemplateCategoryUpdate,
    template_correct_category_detection: deps.handleTemplateCategoryUpdate,
  };
}

function getLifecycleFieldHandler(
  field: string | undefined,
  lifecycleFieldHandlers: Record<string, LifecycleFieldHandler>,
): LifecycleFieldHandler | null {
  if (!field || !(field in lifecycleFieldHandlers)) {
    return null;
  }

  return lifecycleFieldHandlers[field];
}

export function createWhatsAppLifecycleWebhookHandler(
  deps: WhatsAppLifecycleWebhookHandlerDependencies,
) {
  const lifecycleFieldHandlers = createLifecycleFieldHandlers(deps);

  return async function tryHandleWhatsAppLifecycleWebhook(
    params: WhatsAppLifecycleWebhookHandlerParams,
  ): Promise<Response | null> {
    const { body, change, requestLogger } = params;
    const lifecycleHandler = getLifecycleFieldHandler(
      change.field,
      lifecycleFieldHandlers,
    );

    if (lifecycleHandler) {
      const wabaId = readWebhookWabaId(body);
      const value = asRecord(change.value);
      requestLogger.info("WhatsApp lifecycle webhook received", {
        field: change.field,
        wabaId,
        event: typeof value.event === "string" ? (value.event as string) : null,
        templateName:
          typeof value.message_template_name === "string"
            ? (value.message_template_name as string)
            : null,
        templateLanguage:
          typeof value.message_template_language === "string"
            ? (value.message_template_language as string)
            : null,
      });

      try {
        await lifecycleHandler({ wabaId, value });
      } catch (error) {
        requestLogger.error(
          "WhatsApp lifecycle webhook processing failed",
          error,
          { field: change.field, wabaId },
        );
      }

      return Response.json({
        status: "ok",
        message: `${change.field} processed`,
      });
    }

    if (change.field && LOG_ONLY_LIFECYCLE_FIELDS.has(change.field)) {
      const wabaId = readWebhookWabaId(body);
      const value = asRecord(change.value);
      requestLogger.info("WhatsApp informational webhook received", {
        field: change.field,
        wabaId,
        event: typeof value.event === "string" ? (value.event as string) : null,
        payloadKeys: Object.keys(value),
      });

      try {
        const { updated } = await persistWhatsAppLifecycleStatusEvent(deps, {
          wabaId,
          field: change.field,
          value,
        });
        requestLogger.info("WhatsApp informational webhook persisted", {
          field: change.field,
          wabaId,
          updated,
        });
      } catch (error) {
        requestLogger.error(
          "WhatsApp informational webhook persistence failed",
          error,
          { field: change.field, wabaId },
        );
      }

      return Response.json({
        status: "ok",
        message: `${change.field} processed`,
      });
    }

    return null;
  };
}

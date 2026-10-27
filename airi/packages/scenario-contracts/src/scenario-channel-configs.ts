import {
  normalizeWhatsAppFlowActionData,
  WHATSAPP_FLOW_STATUSES,
  type WhatsAppFlowActionPayload,
  type WhatsAppFlowActionType,
  type WhatsAppFlowCategory,
  type WhatsAppFlowSendMode,
  type WhatsAppFlowStatus,
} from "../../shared/src/types/whatsapp-flows";
import { readTrimmedString, readNonEmptyString } from "./value-guards";

export type {
  WhatsAppFlowActionPayload,
  WhatsAppFlowActionType,
  WhatsAppFlowCategory,
  WhatsAppFlowSendMode,
  WhatsAppFlowStatus,
};

export const WHATSAPP_FLOW_UI_LOCALE_IDS = [
  "en",
  "ru",
  "kk",
  "es",
  "pt",
  "uz",
  "tr",
  "de",
  "fr",
  "ar",
] as const;

export type WhatsAppFlowUiLocaleId =
  (typeof WHATSAPP_FLOW_UI_LOCALE_IDS)[number];

export type ScenarioInstagramMessageKind =
  | "text"
  | "quick_replies"
  | "button_template"
  | "generic_template"
  | "media";

export type ScenarioInstagramButtonType = "postback" | "web_url";

export type ScenarioInstagramQuickReply = {
  title: string;
  payload: string;
};

export type ScenarioInstagramButton = {
  type: ScenarioInstagramButtonType;
  title: string;
  payload?: string;
  url?: string;
};

export type ScenarioInstagramGenericCard = {
  id: string;
  title: string;
  subtitle?: string;
  imageUrl?: string;
  buttons?: ScenarioInstagramButton[];
};

export type ScenarioInstagramMediaType = "image" | "video" | "audio";

export type ScenarioInstagramConfig = {
  kind: ScenarioInstagramMessageKind;
  quickReplies?: ScenarioInstagramQuickReply[];
  buttons?: ScenarioInstagramButton[];
  cards?: ScenarioInstagramGenericCard[];
  mediaType?: ScenarioInstagramMediaType;
  mediaUrl?: string;
};

export type ScenarioWhatsAppSessionChoice = {
  id: string;
  text: string;
  payload: string;
  description?: string;
};

export type ScenarioWhatsAppContactConfig = {
  version?: 1;
  formattedName?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  phone?: string;
  email?: string;
  websiteUrl?: string;
};

export type ScenarioWhatsAppLocationConfig = {
  version?: 1;
  latitude?: number | string;
  longitude?: number | string;
  name?: string;
  address?: string;
};

export type ScenarioWhatsAppBookCallDateRangeMode =
  | "today"
  | "tomorrow"
  | "next_3_days"
  | "next_7_days"
  | "custom_days";

export type ScenarioWhatsAppBookCallConfig = {
  enabled?: boolean;
  dateRangeMode?: ScenarioWhatsAppBookCallDateRangeMode;
  durationMinutes?: number;
  minNoticeMinutes?: number;
  horizonDays?: number;
  maxSlots?: number;
  timeZone?: string;
  eventTitle?: string;
  createMeetLink?: boolean;
};

export type WhatsAppFlowFieldType =
  | "TextInput"
  | "Dropdown"
  | "DatePicker"
  | "RadioButtonsGroup"
  | "CheckboxGroup"
  | "TextArea"
  | "NavigationList";

export type WhatsAppFlowPayloadValue =
  | string
  | number
  | boolean
  | null
  | WhatsAppFlowPayloadValue[]
  | { [key: string]: WhatsAppFlowPayloadValue };

/** Static actions retain wire payload keys and values; scenario answer aliases are separate. */
export type WhatsAppFlowScreenAction =
  | {
      name: "navigate";
      nextScreenId: string;
      payload?: Record<string, WhatsAppFlowPayloadValue>;
    }
  | {
      name: "complete" | "data_exchange";
      payload?: Record<string, WhatsAppFlowPayloadValue>;
    };

export type WhatsAppFlowNavigationItem = {
  id: string;
  title: string;
  description?: string;
  action: WhatsAppFlowScreenAction;
};

export type WhatsAppFlowDataSchema = {
  type: "string" | "number" | "boolean" | "array" | "object";
  __example__?: WhatsAppFlowPayloadValue;
  items?: WhatsAppFlowDataSchema;
  properties?: Record<string, WhatsAppFlowDataSchema>;
};

export type WhatsAppFlowFieldConfig = {
  id: string;
  label: string;
  fieldType: WhatsAppFlowFieldType;
  required?: boolean;
  helperText?: string;
  options?: Array<{ id: string; title: string; description?: string }>;
  navigationItems?: WhatsAppFlowNavigationItem[];
};

export type WhatsAppFlowTextType =
  | "TextHeading"
  | "TextSubheading"
  | "TextBody"
  | "TextCaption";

/** Authoring identity is local to the screen and never becomes a Meta component name. */
export type WhatsAppFlowTextBlock = {
  kind: "text";
  id: string;
  type: WhatsAppFlowTextType;
  text: string;
};

export type WhatsAppFlowLayoutContentItem =
  | { kind: "field"; fieldId: string }
  | WhatsAppFlowTextBlock;

export type WhatsAppFlowScreenConfig = {
  id: string;
  title: string;
  fields: WhatsAppFlowFieldConfig[];
  /** Explicit screen shape for static graphs; legacy linear screens derive these values. */
  terminal?: boolean;
  success?: boolean;
  /** Optional explicit order; fields remain the sole answer definition. Footer stays last. */
  layoutContent?: WhatsAppFlowLayoutContentItem[];
  data?: Record<string, WhatsAppFlowDataSchema>;
  layoutForm?: { name: string };
  footer?: { label: string; action: WhatsAppFlowScreenAction };
};

/** How non-terminal screens advance. See Meta Flow JSON routing_model + data_exchange. */
export type WhatsAppFlowNavigationMode =
  | "linear"
  | "data_endpoint"
  | "static_graph";

export const WHATSAPP_FLOW_PROVIDER_STATUSES = WHATSAPP_FLOW_STATUSES;

export type WhatsAppFlowProviderStatus = WhatsAppFlowStatus;

export type WhatsAppFlowProviderReference = {
  flowId: string;
  sourceId: string;
  wabaId: string;
  flowName?: string;
  providerStatus: WhatsAppFlowProviderStatus;
  jsonVersion?: string;
  dataApiVersion?: string;
};

const WHATSAPP_FLOW_PROVIDER_STATUS_SET = new Set<WhatsAppFlowProviderStatus>(
  WHATSAPP_FLOW_PROVIDER_STATUSES,
);

export function normalizeWhatsAppFlowProviderReference(
  value: unknown,
): WhatsAppFlowProviderReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const flowId = readTrimmedString(candidate.flowId);
  const sourceId = readTrimmedString(candidate.sourceId);
  const wabaId = readTrimmedString(candidate.wabaId);
  const providerStatus = WHATSAPP_FLOW_PROVIDER_STATUS_SET.has(
    candidate.providerStatus as WhatsAppFlowProviderStatus,
  )
    ? (candidate.providerStatus as WhatsAppFlowProviderStatus)
    : null;
  if (!flowId || !sourceId || !wabaId || !providerStatus) return null;

  const flowName = readTrimmedString(candidate.flowName);
  const jsonVersion = readTrimmedString(candidate.jsonVersion);
  const dataApiVersion = readTrimmedString(candidate.dataApiVersion);

  return {
    flowId,
    sourceId,
    wabaId,
    ...(flowName ? { flowName } : {}),
    providerStatus,
    ...(jsonVersion ? { jsonVersion } : {}),
    ...(dataApiVersion ? { dataApiVersion } : {}),
  };
}

export type ManagedWhatsAppFlowProvisioningProjection = {
  operationId: string;
  sourceId: string;
  wabaId: string;
  contentRevision: number;
  contentDigest: string;
  flowId?: string;
  flowName?: string;
  providerStatus: WhatsAppFlowProviderStatus;
};

type WhatsAppFlowSourceBindingResolution =
  | "unmanaged"
  | "matched"
  | "outbound_source_missing"
  | "outbound_waba_missing"
  | "source_mismatch"
  | "waba_mismatch";

export type WhatsAppFlowProviderSource = {
  sourceId: string;
  wabaId: string;
};

export function resolveWhatsAppFlowProviderSource(params: {
  flowConfig?: Pick<
    WhatsAppFlowConfig,
    "managedProvisioning" | "providerReference"
  > | null;
  managedSourceId?: string | null;
  managedWabaId?: string | null;
}): WhatsAppFlowProviderSource | null {
  const projectedSourceId = readTrimmedString(
    params.flowConfig?.managedProvisioning?.sourceId,
  );
  if (projectedSourceId) {
    return {
      sourceId: projectedSourceId,
      wabaId: readTrimmedString(params.flowConfig?.managedProvisioning?.wabaId),
    };
  }

  const referencedSourceId = readTrimmedString(
    params.flowConfig?.providerReference?.sourceId,
  );
  if (referencedSourceId) {
    return {
      sourceId: referencedSourceId,
      wabaId: readTrimmedString(params.flowConfig?.providerReference?.wabaId),
    };
  }

  const compatibilitySourceId = readTrimmedString(params.managedSourceId);
  return compatibilitySourceId
    ? {
        sourceId: compatibilitySourceId,
        wabaId: readTrimmedString(params.managedWabaId),
      }
    : null;
}

export function resolveWhatsAppFlowSourceBinding(params: {
  flowConfig?: Pick<
    WhatsAppFlowConfig,
    "managedProvisioning" | "providerReference"
  > | null;
  managedSourceId?: string | null;
  managedWabaId?: string | null;
  outboundSourceId?: string | null;
  outboundWabaId?: string | null;
}): WhatsAppFlowSourceBindingResolution {
  const providerSource = resolveWhatsAppFlowProviderSource(params);
  if (!providerSource) return "unmanaged";
  const { sourceId: managedSourceId, wabaId: managedWabaId } = providerSource;
  if (!managedWabaId) return "waba_mismatch";

  const outboundSourceId =
    typeof params.outboundSourceId === "string"
      ? params.outboundSourceId.trim()
      : "";
  if (!outboundSourceId) return "outbound_source_missing";
  if (outboundSourceId !== managedSourceId) return "source_mismatch";

  const outboundWabaId =
    typeof params.outboundWabaId === "string"
      ? params.outboundWabaId.trim()
      : "";
  if (!outboundWabaId) return "outbound_waba_missing";
  return outboundWabaId === managedWabaId ? "matched" : "waba_mismatch";
}

export type WhatsAppFlowConfig = {
  templateId: string;
  screens: WhatsAppFlowScreenConfig[];
  ctaText: string;
  headerText?: string;
  bodyText?: string;
  footerText?: string;
  flowUiLocale?: WhatsAppFlowUiLocaleId;
  flowSubmitLabel?: string;
  flowNavigationMode?: WhatsAppFlowNavigationMode;
  flowJsonVersion?: "6.3" | "7.3";
  screenRoutes?: Record<string, string[]>;
  flowBranchRules?: Record<string, Record<string, Record<string, string>>>;
  /** Cloud API `mode`. Default published. Draft sends the unpublished JSON. */
  flowMode?: WhatsAppFlowSendMode;
  /** Cloud API `flow_action_payload` for navigate. Omit for data_exchange. */
  flowActionPayload?: WhatsAppFlowActionPayload;
  /** Graph create `categories`. At least one required when creating a Flow. */
  categories?: WhatsAppFlowCategory[];
  /** Graph `endpoint_uri` for data-endpoint Flows (JSON version >= 3.0). */
  endpointUri?: string;
  /** Graph `application_id` for endpoint Flows. */
  applicationId?: string;
  metaFlowId?: string | null;
  metaFlowName?: string | null;
  metaFlowStatus?: string | null;
  managedProvisioning?: ManagedWhatsAppFlowProvisioningProjection;
  providerReference?: WhatsAppFlowProviderReference;
  /**
   * The form's name in `{{form.<answersKey>.<field>}}`, an answer key such
   * as "order". Scenario data only: it never reaches Meta and is not part of
   * the Flow's content digest.
   */
  answersKey?: string;
};

export type EditableWhatsAppFlowConfig = Omit<
  WhatsAppFlowConfig,
  | "managedProvisioning"
  | "providerReference"
  | "metaFlowId"
  | "metaFlowName"
  | "metaFlowStatus"
>;

export function resolveWhatsAppFlowActionType(
  flowConfig:
    | Pick<WhatsAppFlowConfig, "flowNavigationMode" | "providerReference">
    | null
    | undefined,
): WhatsAppFlowActionType {
  return flowConfig?.flowNavigationMode === "data_endpoint" ||
    Boolean(flowConfig?.providerReference?.dataApiVersion?.trim())
    ? "data_exchange"
    : "navigate";
}

export function resolveWhatsAppFlowProviderId(params: {
  flowConfig?: Pick<
    WhatsAppFlowConfig,
    "managedProvisioning" | "providerReference" | "metaFlowId"
  > | null;
  legacyFlowId?: string | null;
}): string | null {
  const candidates = [
    params.flowConfig?.managedProvisioning?.flowId,
    params.flowConfig?.providerReference?.flowId,
    params.flowConfig?.metaFlowId,
    params.legacyFlowId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (normalized) return normalized;
  }
  return null;
}

/** Runtime send boundary: a managed projection is authoritative and cannot
 * fall back to stale legacy identity when Meta no longer reports a sendable status. */
export function resolveSendableWhatsAppFlowProviderId(params: {
  flowConfig?: Pick<
    WhatsAppFlowConfig,
    "managedProvisioning" | "providerReference" | "metaFlowId" | "flowMode"
  > | null;
  legacyFlowId?: string | null;
}): string | null {
  const flowMode = params.flowConfig?.flowMode;
  const managed = params.flowConfig?.managedProvisioning;
  if (managed) {
    if (!isSendableWhatsAppFlowStatus(managed.providerStatus, flowMode)) {
      return null;
    }
    return readNonEmptyString(managed.flowId);
  }

  const providerReference = params.flowConfig?.providerReference;
  if (providerReference) {
    if (
      !isSendableWhatsAppFlowStatus(providerReference.providerStatus, flowMode)
    ) {
      return null;
    }
    return readNonEmptyString(providerReference.flowId);
  }

  return resolveWhatsAppFlowProviderId(params);
}

export type WhatsAppFlowSendIdentity =
  | { kind: "flow_id"; flow_id: string }
  | { kind: "flow_name"; flow_name: string };

export function resolveSendableWhatsAppFlowIdentity(params: {
  flowConfig?: Pick<
    WhatsAppFlowConfig,
    | "managedProvisioning"
    | "providerReference"
    | "metaFlowId"
    | "metaFlowName"
    | "flowMode"
  > | null;
  legacyFlowId?: string | null;
  legacyFlowName?: string | null;
}): WhatsAppFlowSendIdentity | null {
  const flowId = resolveSendableWhatsAppFlowProviderId(params);
  if (flowId) return { kind: "flow_id", flow_id: flowId };

  const flowMode = params.flowConfig?.flowMode;
  const managed = params.flowConfig?.managedProvisioning;
  if (managed) {
    if (!isSendableWhatsAppFlowStatus(managed.providerStatus, flowMode)) {
      return null;
    }
    const flowName = readNonEmptyString(managed.flowName);
    return flowName ? { kind: "flow_name", flow_name: flowName } : null;
  }

  const providerReference = params.flowConfig?.providerReference;
  if (providerReference) {
    if (
      !isSendableWhatsAppFlowStatus(providerReference.providerStatus, flowMode)
    ) {
      return null;
    }
    const flowName = readNonEmptyString(providerReference.flowName);
    return flowName ? { kind: "flow_name", flow_name: flowName } : null;
  }

  const flowName =
    readNonEmptyString(params.flowConfig?.metaFlowName) ||
    readNonEmptyString(params.legacyFlowName);
  return flowName ? { kind: "flow_name", flow_name: flowName } : null;
}

function isSendableWhatsAppFlowStatus(
  status: WhatsAppFlowProviderStatus,
  flowMode?: WhatsAppFlowSendMode,
): boolean {
  if (status === "PUBLISHED" || status === "THROTTLED") return true;
  return status === "DRAFT" && flowMode === "draft";
}

export function resolveWhatsAppFlowSendMode(
  flowConfig:
    | Pick<
        WhatsAppFlowConfig,
        | "flowMode"
        | "metaFlowStatus"
        | "managedProvisioning"
        | "providerReference"
      >
    | null
    | undefined,
): WhatsAppFlowSendMode {
  if (
    flowConfig?.flowMode === "draft" ||
    flowConfig?.flowMode === "published"
  ) {
    return flowConfig.flowMode;
  }
  const status = [
    flowConfig?.managedProvisioning?.providerStatus,
    flowConfig?.providerReference?.providerStatus,
    flowConfig?.metaFlowStatus,
  ]
    .map((value) =>
      typeof value === "string" ? value.trim().toUpperCase() : "",
    )
    .find(Boolean);
  return status === "DRAFT" ? "draft" : "published";
}

export function resolveWhatsAppFlowActionData(
  flowConfig: Pick<WhatsAppFlowConfig, "flowActionPayload"> | null | undefined,
): Record<string, unknown> | undefined {
  return normalizeWhatsAppFlowActionData(flowConfig?.flowActionPayload?.data);
}

export function resolveWhatsAppFlowNavigateActionPayload(
  flowConfig:
    | Pick<
        WhatsAppFlowConfig,
        | "flowActionPayload"
        | "screens"
        | "flowNavigationMode"
        | "providerReference"
      >
    | null
    | undefined,
): Record<string, unknown> | undefined {
  if (resolveWhatsAppFlowActionType(flowConfig) !== "navigate")
    return undefined;
  const screen =
    readNonEmptyString(flowConfig?.flowActionPayload?.screen) ||
    readNonEmptyString(flowConfig?.screens?.[0]?.id) ||
    undefined;
  const data = resolveWhatsAppFlowActionData(flowConfig);
  if (!screen && !data) return undefined;
  return {
    ...(screen ? { screen } : {}),
    ...(data ? { data } : {}),
  };
}

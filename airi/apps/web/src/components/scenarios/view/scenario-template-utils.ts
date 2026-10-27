import type {
  ScenarioReplyCtaType,
  TranslateFn,
} from "@/components/scenarios/types";
import {
  listUnsupportedScenarioTemplateTokens,
  SCENARIO_TEMPLATE_VARIABLE_PATTERN,
  type ScenarioTemplateContextPath,
} from "@icecore/scenario-contracts";
import type { WhatsAppTemplateButtonDrift } from "@/lib/scenarios/whatsapp-template-button-branches";
import {
  findMatchingScenarioWhatsAppTemplate,
  type BulkWhatsAppTemplateSendBlockReason,
} from "@/lib/scenarios/whatsapp-template-selection";
import { prefixCardLabel } from "../nodes/action-node/action-node-utils";
import type { ScenarioNodeData, ScenarioWhatsAppTemplate } from "../types";

const SCENARIO_REPLY_CTA_TYPES = ["none", "link", "flow"] as const;

/**
 * User-facing merge fields for scenario replies / WhatsApp service messages.
 * Keep short and understandable — contact + chat context, not IDs / media URLs.
 * Each token must be a path the runtime renders.
 */
export const SCENARIO_TOKEN_FIELDS = {
  contact: [
    { value: "first_name", token: "first_name" },
    { value: "last_name", token: "last_name" },
    { value: "full_name", token: "customer_name" },
    { value: "phone", token: "whatsappclient.wa_id" },
    { value: "whatsapp_name", token: "whatsappclient.name" },
  ],
  conversation: [
    { value: "language", token: "conversation.preferred_language" },
    { value: "channel", token: "channel" },
    { value: "labels", token: "conversation.internal_labels" },
  ],
  message: [{ value: "last_customer_message", token: "trigger.message.text" }],
  ads: [
    {
      value: "campaign_name",
      token: "trigger.whatsappReferral.campaignName",
    },
    {
      value: "ad_headline",
      token: "trigger.whatsappReferral.headline",
    },
    {
      value: "ad_platform",
      token: "trigger.whatsappReferral.sourcePlatform",
    },
  ],
  calendar: [{ value: "next_free_slot", token: "calendar.next_free_slot" }],
  countdown: [
    { value: "time_left", token: "countdown" },
    { value: "hours_left", token: "countdown.hours" },
    { value: "minutes_left", token: "countdown.minutes" },
  ],
  picked: [
    { value: "picked_option", token: "picked.label" },
    { value: "picked_card_text", token: "picked.text" },
  ],
} as const satisfies Record<
  string,
  ReadonlyArray<{ value: string; token: ScenarioTemplateContextPath }>
>;

export type ScenarioTokenSource = keyof typeof SCENARIO_TOKEN_FIELDS;

export const SCENARIO_TOKEN_SOURCE_LABEL_KEYS: Record<
  ScenarioTokenSource,
  string
> = {
  contact: "variableGroupContact",
  conversation: "variableGroupConversation",
  message: "variableGroupMessage",
  ads: "variableGroupAds",
  calendar: "variableGroupCalendar",
  countdown: "variableGroupCountdown",
  picked: "variableGroupPicked",
};

export const SCENARIO_TOKEN_SOURCE_DESCRIPTION_KEYS: Record<
  ScenarioTokenSource,
  string
> = {
  contact: "variableGroupContactDesc",
  conversation: "variableGroupConversationDesc",
  message: "variableGroupMessageDesc",
  ads: "variableGroupAdsDesc",
  calendar: "variableGroupCalendarDesc",
  countdown: "variableGroupCountdownDesc",
  picked: "variableGroupPickedDesc",
};

export const SCENARIO_TOKEN_SOURCE_ORDER = Object.keys(
  SCENARIO_TOKEN_FIELDS
) as ScenarioTokenSource[];

/** Locale keys for every insertable catalog token (picker + chips). */
export const SCENARIO_TOKEN_FIELD_META: Record<
  string,
  { labelKey: string; descriptionKey: string }
> = {
  first_name: {
    labelKey: "variableFieldFirstName",
    descriptionKey: "variableFieldFirstNameDesc",
  },
  last_name: {
    labelKey: "variableFieldLastName",
    descriptionKey: "variableFieldLastNameDesc",
  },
  customer_name: {
    labelKey: "variableFieldFullName",
    descriptionKey: "variableFieldFullNameDesc",
  },
  "whatsappclient.wa_id": {
    labelKey: "variableFieldPhone",
    descriptionKey: "variableFieldPhoneDesc",
  },
  "whatsappclient.name": {
    labelKey: "variableFieldWhatsappName",
    descriptionKey: "variableFieldWhatsappNameDesc",
  },
  "conversation.preferred_language": {
    labelKey: "variableFieldLanguage",
    descriptionKey: "variableFieldLanguageDesc",
  },
  channel: {
    labelKey: "variableFieldChannel",
    descriptionKey: "variableFieldChannelDesc",
  },
  "conversation.internal_labels": {
    labelKey: "variableFieldLabels",
    descriptionKey: "variableFieldLabelsDesc",
  },
  "trigger.message.text": {
    labelKey: "variableFieldLastMessage",
    descriptionKey: "variableFieldLastMessageDesc",
  },
  "trigger.whatsappReferral.campaignName": {
    labelKey: "variableFieldCampaignName",
    descriptionKey: "variableFieldCampaignNameDesc",
  },
  "trigger.whatsappReferral.headline": {
    labelKey: "variableFieldAdHeadline",
    descriptionKey: "variableFieldAdHeadlineDesc",
  },
  "trigger.whatsappReferral.sourcePlatform": {
    labelKey: "variableFieldAdPlatform",
    descriptionKey: "variableFieldAdPlatformDesc",
  },
  "calendar.next_free_slot": {
    labelKey: "variableFieldCalendarNextSlot",
    descriptionKey: "variableFieldCalendarNextSlotDesc",
  },
  countdown: {
    labelKey: "variableFieldCountdown",
    descriptionKey: "variableFieldCountdownDesc",
  },
  "countdown.hours": {
    labelKey: "variableFieldCountdownHours",
    descriptionKey: "variableFieldCountdownHoursDesc",
  },
  "countdown.minutes": {
    labelKey: "variableFieldCountdownMinutes",
    descriptionKey: "variableFieldCountdownMinutesDesc",
  },
  "picked.label": {
    labelKey: "variableFieldPickedLabel",
    descriptionKey: "variableFieldPickedLabelDesc",
  },
  "picked.text": {
    labelKey: "variableFieldPickedText",
    descriptionKey: "variableFieldPickedTextDesc",
  },
};

function humanizeTokenLabel(value: string): string {
  return value
    .replace(/[_.-]+/g, " ")
    .replace(/\b\w/g, char => char.toUpperCase())
    .trim();
}

const TOKEN_FALLBACK_LABEL_BY_TOKEN = new Map<string, string>(
  Object.values(SCENARIO_TOKEN_FIELDS).flatMap(fields =>
    fields.map(field => [field.token, humanizeTokenLabel(field.value)])
  )
);

export function getScenarioTokenFallbackLabel(token: string): string {
  return (
    TOKEN_FALLBACK_LABEL_BY_TOKEN.get(token) ??
    humanizeTokenLabel(token.split(".").pop() || token)
  );
}

export function resolveScenarioTokenLabel(
  token: string,
  t?: (key: string) => string
): string {
  const labelKey = SCENARIO_TOKEN_FIELD_META[token]?.labelKey;
  if (labelKey && t) {
    const translated = t(labelKey);
    if (translated && translated !== labelKey) return translated;
  }
  return getScenarioTokenFallbackLabel(token);
}

/**
 * Stable resolver for TipTap / editors that need `(token) => label`.
 * `scopedLabels` names the answers before a step, such as a form's fields.
 */
export function createScenarioTokenLabelResolver(
  t: (key: string) => string,
  scopedLabels?: ReadonlyMap<string, string>
): (token: string) => string {
  return token =>
    scopedLabels?.get(token) ?? resolveScenarioTokenLabel(token, t);
}

/**
 * A rich-editor chip's label in the viewer's language: catalog tokens use the
 * catalog name, other tokens keep the label they were inserted with.
 */
export function resolveScenarioVariableChipLabel(
  token: string,
  insertedLabel: string,
  t: (key: string) => string
): string {
  if (SCENARIO_TOKEN_FIELD_META[token]) {
    return resolveScenarioTokenLabel(token, t);
  }
  return insertedLabel || getScenarioTokenFallbackLabel(token);
}

/** Returns the token when `text` is exactly one `{{token}}` snippet. */
export function parseExactScenarioVariableSnippet(text: string): string | null {
  const match = new RegExp(`^${SCENARIO_VARIABLE_TOKEN_REGEX.source}$`).exec(
    text.trim()
  );
  return match?.[1] ?? null;
}

/** Append `{{token}}` (or a full `{{...}}` snippet) into message text with light spacing. */
export function insertScenarioTemplateToken(
  currentText: string,
  tokenOrSnippet: string
): string {
  const snippet = tokenOrSnippet.includes("{{")
    ? tokenOrSnippet
    : `{{${tokenOrSnippet}}}`;
  const current = currentText || "";
  if (!current) return snippet;
  const separator =
    current.endsWith(" ") || current.endsWith("\n") || current.endsWith("{")
      ? ""
      : " ";
  return `${current}${separator}${snippet}`;
}

/** A text field's selection, in UTF-16 units; start and end match for a caret. */
export type ScenarioTextSelection = Readonly<{ start: number; end: number }>;

/**
 * Puts `{{token}}` over a text field's selection, spaced like
 * `insertScenarioTemplateToken`, and gives the caret after it. With no
 * selection, the token goes at the end.
 */
export function insertScenarioTemplateTokenAt(
  currentText: string,
  tokenOrSnippet: string,
  selection: ScenarioTextSelection | null
): { text: string; caret: number } {
  const current = currentText || "";
  const start = Math.min(
    Math.max(selection?.start ?? current.length, 0),
    current.length
  );
  const end = Math.min(
    Math.max(selection?.end ?? start, start),
    current.length
  );
  const inserted = insertScenarioTemplateToken(
    current.slice(0, start),
    tokenOrSnippet
  );
  const after = current.slice(end);
  // A word right after the token keeps a space from it.
  const separator = /^[\p{L}\p{N}{]/u.test(after) ? " " : "";
  return {
    text: `${inserted}${separator}${after}`,
    caret: inserted.length,
  };
}

/** `{{token}}` matcher for editors and chips: the shared grammar's chip syntax. */
export const SCENARIO_VARIABLE_TOKEN_REGEX = SCENARIO_TEMPLATE_VARIABLE_PATTERN;

const MAX_LISTED_UNSUPPORTED_TOKENS = 6;

/**
 * Warns about tokens in authored text that the runtime renders empty, such
 * as a wrongly cased `{{input.Name}}`. Null when every token renders.
 */
export function describeUnsupportedScenarioTemplateTokens(
  text: string,
  t: TranslateFn
): string | null {
  const tokens = listUnsupportedScenarioTemplateTokens(text);
  if (tokens.length === 0) return null;
  return t("variablesUnsupported", {
    tokens: tokens.slice(0, MAX_LISTED_UNSUPPORTED_TOKENS).join(", "),
  });
}

/** Shared chip styles for TipTap atoms + HTML preview (keep out of `.tsx`). */
export const SCENARIO_VARIABLE_CHIP_CLASSNAME =
  "scenario-variable-chip inline-flex max-w-full items-center gap-1 rounded-md bg-rose-100 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-rose-900 align-baseline dark:bg-rose-950/60 dark:text-rose-100";

export function resolveReplyCtaTypeFromNodeData(
  nodeData?: Partial<ScenarioNodeData>
): ScenarioReplyCtaType {
  if (!nodeData) return "none";

  const explicit =
    typeof nodeData.actionReplyCtaType === "string"
      ? nodeData.actionReplyCtaType.trim()
      : "";
  const hasFlowId =
    typeof nodeData.actionReplyCtaFlowId === "string" &&
    nodeData.actionReplyCtaFlowId.trim().length > 0;
  const hasLinkUrl =
    Array.isArray(nodeData.actionLinkUrls) &&
    nodeData.actionLinkUrls.some(
      url => typeof url === "string" && url.trim().length > 0
    );

  if (
    SCENARIO_REPLY_CTA_TYPES.includes(
      explicit as (typeof SCENARIO_REPLY_CTA_TYPES)[number]
    )
  ) {
    return explicit as ScenarioReplyCtaType;
  }

  if (hasFlowId) return "flow";
  if (hasLinkUrl) return "link";
  return "none";
}

export function bulkTemplateSendBlockReasonMessageKey(
  reason: BulkWhatsAppTemplateSendBlockReason
): string {
  switch (reason) {
    case "missing":
      return "bulkNodeTemplateSendBlockedMissing";
    case "stale":
      return "bulkNodeTemplateSendBlockedStale";
    case "not_approved":
      return "bulkNodeTemplateSendBlockedNotApproved";
    case "draft":
      return "bulkNodeTemplateSendBlockedEditing";
    case "pending_review":
      return "bulkNodeTemplateSendBlockedPending";
    case "rejected":
      return "bulkNodeTemplateSendBlockedRejected";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

const WHATSAPP_TEMPLATE_BUTTON_DRIFT_MESSAGE_KEYS: Record<
  WhatsAppTemplateButtonDrift["kind"],
  string
> = {
  removed: "whatsappTemplateButtonDriftRemoved",
  added: "whatsappTemplateButtonDriftAdded",
  renamed: "whatsappTemplateButtonDriftRenamed",
  form_removed: "whatsappTemplateButtonDriftFormRemoved",
  form_answers_removed: "whatsappTemplateButtonDriftFormAnswersRemoved",
  form_changed: "whatsappTemplateButtonDriftFormChanged",
};

/**
 * One sentence per difference, shared by the step and the activation check.
 * A carousel card's button names its card ("Card 2 · Buy").
 */
export function describeWhatsAppTemplateButtonDrift(
  drift: WhatsAppTemplateButtonDrift,
  t: TranslateFn
): string {
  return t(WHATSAPP_TEMPLATE_BUTTON_DRIFT_MESSAGE_KEYS[drift.kind], {
    label: prefixCardLabel(drift.cardIndex, drift.label, t),
    liveLabel: drift.kind === "renamed" ? drift.liveLabel : "",
  });
}

/** Button or option labels, each once and in quotes, as one list. */
export function formatQuotedLabelList(
  labels: readonly string[],
  t: TranslateFn
): { count: number; labels: string } {
  const unique = Array.from(new Set(labels));
  return {
    count: unique.length,
    labels: unique
      .map(label => t("whatsappTemplateButtonQuoted", { label }))
      .join(", "),
  };
}

export function resolveScenarioWhatsAppTemplateComponents(params: {
  nodeData?: Partial<ScenarioNodeData>;
  whatsAppTemplates: ScenarioWhatsAppTemplate[];
}): ScenarioWhatsAppTemplate["components"] | undefined {
  const savedComponents =
    Array.isArray(params.nodeData?.actionWhatsAppTemplateComponents) &&
    params.nodeData.actionWhatsAppTemplateComponents.length > 0
      ? params.nodeData.actionWhatsAppTemplateComponents
      : undefined;
  if (savedComponents) {
    return savedComponents;
  }

  const liveTemplate = findMatchingScenarioWhatsAppTemplate(params);
  if (
    liveTemplate &&
    Array.isArray(liveTemplate.components) &&
    liveTemplate.components.length > 0
  ) {
    return liveTemplate.components;
  }

  return undefined;
}

export function resolveScenarioNodeDataWithLiveWhatsAppTemplate<
  T extends Partial<ScenarioNodeData>,
>(params: { nodeData: T; whatsAppTemplates: ScenarioWhatsAppTemplate[] }): T {
  const resolvedComponents = resolveScenarioWhatsAppTemplateComponents(params);
  if (
    resolvedComponents === params.nodeData.actionWhatsAppTemplateComponents ||
    (!resolvedComponents &&
      !Array.isArray(params.nodeData.actionWhatsAppTemplateComponents))
  ) {
    return params.nodeData;
  }

  return {
    ...params.nodeData,
    actionWhatsAppTemplateComponents: resolvedComponents,
  };
}

export function parseUrlLines(input: string): string[] {
  const seen = new Set<string>();
  return input
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(value => {
      if (seen.has(value)) return [];
      seen.add(value);
      return [value];
    });
}

export function parseScenarioPriorityInput(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  if (parsed > 1000) return 1000;
  return parsed;
}

import type { ScenarioNodeData } from "./scenario-node-data";
import {
  normalizeWhatsAppQrEntryPointId,
  type ScenarioMessageMatchMode,
  type ScenarioTriggerEntryPointType,
  type ScenarioTriggerConfig,
} from "./scenario-triggers";
import { readNonEmptyStringOrUndefined } from "./value-guards";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeMessageMatchMode(
  value: unknown,
): ScenarioMessageMatchMode | undefined {
  return value === "any" || value === "exact" || value === "contains"
    ? value
    : undefined;
}

function normalizeEntryPointType(
  value: unknown,
): ScenarioTriggerEntryPointType | undefined {
  return value === "message" ||
    value === "whatsapp_qr" ||
    value === "customer_behavior" ||
    value === "business_event"
    ? value
    : undefined;
}

function normalizeKeywordMatchMode(
  value: unknown,
): "contains" | "regex" | undefined {
  return value === "contains" || value === "regex" ? value : undefined;
}

function normalizeNonBlankStringPreserveWhitespace(
  value: unknown,
): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

const MAX_CAMPAIGN_LABELS = 50;
const MAX_CAMPAIGN_NAME_FALLBACKS = 20;
const MAX_CAMPAIGN_NAME_FALLBACK_LENGTH = 120;

function normalizeCampaignLabels(
  value: unknown,
): Array<{ id: string; name?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const labels: Array<{ id: string; name?: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const name = typeof record.name === "string" ? record.name.trim() : "";
    labels.push(name ? { id, name } : { id });
    if (labels.length >= MAX_CAMPAIGN_LABELS) break;
  }
  return labels.length > 0 ? labels : undefined;
}

function normalizeCampaignNameFallbacks(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim().replace(/\s+/g, " ");
    if (!trimmed || trimmed.length > MAX_CAMPAIGN_NAME_FALLBACK_LENGTH) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(trimmed);
    if (names.length >= MAX_CAMPAIGN_NAME_FALLBACKS) break;
  }
  return names.length > 0 ? names : undefined;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = Array.from(
    new Set(
      value
        .flatMap((item) => (typeof item === "string" ? [item.trim()] : []))
        .filter(Boolean),
    ),
  );
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeBusinessEventDraft(
  value: unknown,
): ScenarioTriggerConfig["businessEvent"] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const input = asRecord(value);
  const draft: NonNullable<ScenarioTriggerConfig["businessEvent"]> = {};
  for (const field of [
    "integrationId",
    "integrationName",
    "eventId",
    "eventName",
  ] as const) {
    if (typeof input[field] === "string") draft[field] = input[field];
  }
  if (Array.isArray(input.filters)) {
    draft.filters = input.filters.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const filter = asRecord(item);
      return [
        {
          field: typeof filter.field === "string" ? filter.field : "",
          operator:
            filter.operator === "not_equals"
              ? ("not_equals" as const)
              : ("equals" as const),
          value: typeof filter.value === "string" ? filter.value : "",
        },
      ];
    });
  }
  return draft;
}

export function normalizeClientMessageTriggerConfig(
  raw: unknown,
): ScenarioTriggerConfig {
  const input = asRecord(raw);
  const normalized: ScenarioTriggerConfig = {
    enabled: normalizeBoolean(input.enabled) ?? true,
    messageMatchMode:
      normalizeMessageMatchMode(input.messageMatchMode) ?? "any",
    keywordMatchMode:
      normalizeKeywordMatchMode(input.keywordMatchMode) ?? "contains",
  };

  const channelFilter = normalizeStringList(input.channelFilter);
  const keywordPattern = normalizeNonBlankStringPreserveWhitespace(
    input.keywordPattern,
  );
  const whatsappReferralSourceTypes = normalizeStringList(
    input.whatsappReferralSourceTypes,
  );
  const whatsappReferralSourcePlatforms = normalizeStringList(
    input.whatsappReferralSourcePlatforms,
  );
  const metaReferralSourceIds = normalizeStringList(
    input.metaReferralSourceIds,
  );
  const metaReferralCampaignIds = normalizeStringList(
    input.metaReferralCampaignIds,
  );
  const metaReferralAdSetIds = normalizeStringList(input.metaReferralAdSetIds);
  const metaCampaignAdAccountId = readNonEmptyStringOrUndefined(
    input.metaCampaignAdAccountId,
  );
  const metaCampaignLabels = normalizeCampaignLabels(input.metaCampaignLabels);
  const metaCampaignNameFallbacks = normalizeCampaignNameFallbacks(
    input.metaCampaignNameFallbacks,
  );
  const onlyNewCustomers = normalizeBoolean(input.onlyNewCustomers);
  const entryPointType = normalizeEntryPointType(input.entryPointType);
  const entryPointId = normalizeWhatsAppQrEntryPointId(input.entryPointId);

  if (channelFilter) normalized.channelFilter = channelFilter;
  if (keywordPattern !== undefined) normalized.keywordPattern = keywordPattern;
  if (whatsappReferralSourceTypes) {
    normalized.whatsappReferralSourceTypes = whatsappReferralSourceTypes;
  }
  if (whatsappReferralSourcePlatforms) {
    normalized.whatsappReferralSourcePlatforms =
      whatsappReferralSourcePlatforms;
  }
  if (metaReferralSourceIds) {
    normalized.metaReferralSourceIds = metaReferralSourceIds;
  }
  if (metaReferralCampaignIds) {
    normalized.metaReferralCampaignIds = metaReferralCampaignIds;
  }
  if (metaReferralAdSetIds) {
    normalized.metaReferralAdSetIds = metaReferralAdSetIds;
  }
  if (metaCampaignAdAccountId) {
    normalized.metaCampaignAdAccountId = metaCampaignAdAccountId;
  }
  // Preserve unfinished label routes so matching fails closed until the account
  // is selected; dropping these labels would silently create a catch-all.
  if (metaCampaignLabels) {
    normalized.metaCampaignLabels = metaCampaignLabels;
  }
  if (metaCampaignNameFallbacks) {
    normalized.metaCampaignNameFallbacks = metaCampaignNameFallbacks;
  }
  if (onlyNewCustomers !== undefined) {
    normalized.onlyNewCustomers = onlyNewCustomers;
  }
  if (entryPointType !== undefined) {
    normalized.entryPointType = entryPointType;
  }
  if (entryPointType === "business_event") {
    const businessEvent = normalizeBusinessEventDraft(input.businessEvent);
    if (businessEvent) normalized.businessEvent = businessEvent;
  }
  // Preserve unfinished behavior drafts; runnable validation is authoritative.
  if (
    entryPointType === "customer_behavior" &&
    input.behavior &&
    typeof input.behavior === "object"
  ) {
    normalized.behavior = structuredClone(
      input.behavior,
    ) as ScenarioTriggerConfig["behavior"];
  }
  if (entryPointType === "whatsapp_qr" && entryPointId !== undefined) {
    normalized.entryPointId = entryPointId;
  }

  return normalized;
}

export function createClientMessageTriggerData(
  overrides: Partial<ScenarioNodeData> = {},
): ScenarioNodeData {
  const rawOverrides = overrides as Partial<ScenarioNodeData> & {
    triggerType?: unknown;
  };
  const {
    kind: _kind,
    triggerConfig,
    triggerType: _triggerType,
    ...dataOverrides
  } = rawOverrides;

  return {
    kind: "trigger",
    ...dataOverrides,
    triggerConfig: normalizeClientMessageTriggerConfig(triggerConfig),
  };
}

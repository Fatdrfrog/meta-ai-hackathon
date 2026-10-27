import { normalizeMetaAdAccountId } from "@/lib/meta-ads/meta-ad-account-id";
import { readTrimmedString } from "@icecore/shared/lib/value-utils";
import type {
  ScenarioAudienceOptions,
  ScenarioMessageMatchMode,
  ScenarioMetaAdsDataStatus,
  ScenarioMetaReferralAdOption,
  ScenarioMetaReferralAdSetOption,
  ScenarioMetaReferralCampaignOption,
  ScenarioTriggerConfig,
  TranslateFn,
} from "../../types";
import { localizeClientMessageChannel } from "../../view/client-message-trigger-presentation";
import {
  metaReferralSelectionToSelectValue,
  resolveMetaReferralSelection,
} from "./meta-referral-selection";

export type MessageTriggerEditorFormatters = {
  number: Intl.NumberFormat;
  shortDate: Intl.DateTimeFormat;
};

export type MessageTriggerMetaOption = {
  id: string;
  label: string;
  meta: string;
  title: string;
  selectValue: string;
};

export type MessageTriggerEditorModel = {
  onlyNewCustomers: boolean;
  message: {
    mode: ScenarioMessageMatchMode;
    pattern: string;
    keywordMatchMode: "contains" | "regex";
    usesPattern: boolean;
    isExact: boolean;
    isContains: boolean;
  };
  channels: {
    options: Array<{ id: string; label: string }>;
    enabledChannelSet: Set<string>;
  };
  meta: {
    hasConnection: boolean;
    catalogWarning: string;
    selectValue: string;
    selectedLabel: string;
    selectedMeta: string;
    campaignOptions: MessageTriggerMetaOption[];
    adSetOptions: MessageTriggerMetaOption[];
    adOptions: MessageTriggerMetaOption[];
  };
  product: MessageTriggerProductRouteModel;
};

export type MessageTriggerProductCatalogState =
  | "loading"
  | "disconnected"
  | "error"
  | "partial"
  | "empty"
  | "ready";

export type MessageTriggerProductLabelOption = {
  id: string;
  name: string;
  stale: boolean;
};

export type MessageTriggerProductRouteModel = {
  state: MessageTriggerProductCatalogState;
  warning: string;
  accounts: Array<{ id: string; name: string }>;
  selectedAccountId: string;
  labels: MessageTriggerProductLabelOption[];
  selectedLabelIds: string[];
  nameFallbacks: string[];
};

export function createMessageTriggerEditorFormatters(
  locale: string
): MessageTriggerEditorFormatters {
  return {
    number: new Intl.NumberFormat(locale),
    shortDate: new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
    }),
  };
}

function normalizedUniqueValues(values: unknown[] | null | undefined) {
  return Array.from(
    new Set((values || []).map(readTrimmedString).filter(Boolean))
  );
}

function formatReferenceId(value: string): string {
  return value.length <= 16
    ? value
    : `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function formatPositiveCount(params: {
  value: unknown;
  key: "triggerMetaConversationCount" | "triggerMetaAdCount";
  formatters: MessageTriggerEditorFormatters;
  t: TranslateFn;
}): string {
  if (
    typeof params.value !== "number" ||
    !Number.isFinite(params.value) ||
    params.value <= 0
  ) {
    return "";
  }
  return params.t(params.key, {
    count: params.formatters.number.format(Math.round(params.value)),
  });
}

function formatLastSeen(
  value: unknown,
  formatters: MessageTriggerEditorFormatters,
  t: TranslateFn
): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return t("triggerMetaLastSeen", {
    date: formatters.shortDate.format(date),
  });
}

function resolveSourceHost(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function joinMeta(parts: string[]): string {
  return parts.filter(Boolean).join(" / ");
}

function resolveAdLabel(
  option: ScenarioMetaReferralAdOption,
  t: TranslateFn
): string {
  return (
    readTrimmedString(option.label) ||
    readTrimmedString(option.headline) ||
    readTrimmedString(option.body) ||
    t("triggerMetaFallbackAd", {
      id: formatReferenceId(option.sourceId),
    })
  );
}

function buildMetaOption(
  selection:
    | { kind: "campaign"; option: ScenarioMetaReferralCampaignOption }
    | { kind: "ad_set"; option: ScenarioMetaReferralAdSetOption }
    | { kind: "ad"; option: ScenarioMetaReferralAdOption },
  params: {
    formatters: MessageTriggerEditorFormatters;
    t: TranslateFn;
  }
): MessageTriggerMetaOption {
  const { kind, option } = selection;
  const id = readTrimmedString(
    kind === "campaign"
      ? option.campaignId
      : kind === "ad_set"
        ? option.adSetId
        : option.sourceId
  );
  const label =
    kind === "ad"
      ? resolveAdLabel(option, params.t)
      : readTrimmedString(option.label) ||
        params.t(
          kind === "campaign"
            ? "triggerMetaFallbackCampaign"
            : "triggerMetaFallbackAdSet",
          { id: formatReferenceId(id) }
        );
  const meta = joinMeta([
    kind === "ad"
      ? params.t("triggerMetaSourceIdMetadata", { id: formatReferenceId(id) })
      : formatReferenceId(id),
    kind !== "campaign" && option.campaignName
      ? params.t("triggerMetaCampaignMetadata", {
          name: option.campaignName,
        })
      : "",
    kind === "ad" && option.adSetName
      ? params.t("triggerMetaAdSetMetadata", {
          name: option.adSetName,
        })
      : "",
    kind !== "ad"
      ? formatPositiveCount({
          value: option.adCount,
          key: "triggerMetaAdCount",
          ...params,
        })
      : "",
    formatPositiveCount({
      value: option.conversationCount,
      key: "triggerMetaConversationCount",
      ...params,
    }),
    formatLastSeen(option.lastSeenAt, params.formatters, params.t),
    kind === "ad" ? resolveSourceHost(option.sourceUrl) : "",
  ]);
  return {
    id,
    label,
    meta,
    title: joinMeta([
      label,
      meta,
      kind === "ad" ? readTrimmedString(option.sourceUrl) : "",
    ]),
    selectValue: metaReferralSelectionToSelectValue({ kind, id }),
  };
}

function prependStaleOption<T>(
  options: T[],
  selectedId: string,
  getId: (option: T) => string,
  create: () => T
): T[] {
  const existing = options.some(
    option => getId(option).toLowerCase() === selectedId.toLowerCase()
  );
  return [...(!existing && selectedId ? [create()] : []), ...options];
}

function productCatalogState(params: {
  hasConnection: boolean;
  status: ScenarioMetaAdsDataStatus | undefined;
  labelCount: number;
}): MessageTriggerProductCatalogState {
  const status = params.status;
  if (!status) {
    return params.hasConnection ? "loading" : "disconnected";
  }
  if (status.reasons.includes("not_connected")) {
    return "disconnected";
  }
  if (status.state === "unavailable") return "error";
  if (status.state === "partial") return "partial";
  return params.labelCount > 0 ? "ready" : "empty";
}

function productWarning(
  state: MessageTriggerProductCatalogState,
  t: TranslateFn
): string {
  switch (state) {
    case "loading":
      return t("triggerProductRouteLabelsLoading");
    case "disconnected":
      return t("triggerProductRouteLabelsDisconnected");
    case "error":
      return t("triggerProductRouteLabelsError");
    case "partial":
      return t("triggerProductRouteLabelsPartial");
    case "empty":
      return t("triggerProductRouteNoLabels");
    case "ready":
      return "";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function buildProductRouteModel(params: {
  triggerConfig: ScenarioTriggerConfig;
  audienceOptions: ScenarioAudienceOptions;
  hasMetaAdsConnection: boolean;
  t: TranslateFn;
}): MessageTriggerProductRouteModel {
  const savedAccountId = normalizeMetaAdAccountId(
    params.triggerConfig.metaCampaignAdAccountId
  );
  const catalog = params.audienceOptions.metaCampaignLabels ?? [];
  const accounts = new Map<string, string>();
  for (const label of catalog) {
    const accountId = normalizeMetaAdAccountId(label.adAccountId);
    if (!accountId || accounts.has(accountId)) continue;
    accounts.set(accountId, label.adAccountName?.trim() || accountId);
  }
  if (savedAccountId && !accounts.has(savedAccountId)) {
    accounts.set(savedAccountId, savedAccountId);
  }
  const selectedAccountId =
    savedAccountId || (accounts.size === 1 ? [...accounts.keys()][0] : "");
  const visibleCatalog = catalog.filter(
    label =>
      !selectedAccountId ||
      normalizeMetaAdAccountId(label.adAccountId) === selectedAccountId
  );
  const selected = (params.triggerConfig.metaCampaignLabels ?? []).flatMap(
    label => {
      const id = label.id.trim();
      return id ? [{ id, name: label.name?.trim() || id }] : [];
    }
  );
  const catalogIds = new Set(
    visibleCatalog.map(label => label.labelId.trim().toLowerCase())
  );
  const labels: MessageTriggerProductLabelOption[] = [
    ...visibleCatalog.map(label => ({
      id: label.labelId,
      name: label.name.trim() || label.labelId,
      stale: false,
    })),
    ...selected
      .filter(label => !catalogIds.has(label.id.toLowerCase()))
      .map(label => ({ id: label.id, name: label.name, stale: true })),
  ];
  const state = productCatalogState({
    hasConnection: params.hasMetaAdsConnection,
    status: params.audienceOptions.metaAdsDataStatus,
    labelCount: labels.filter(label => !label.stale).length,
  });
  return {
    state,
    warning: productWarning(state, params.t),
    accounts: [...accounts.entries()].map(([id, name]) => ({ id, name })),
    selectedAccountId,
    labels,
    selectedLabelIds: selected.map(label => label.id),
    nameFallbacks: [...(params.triggerConfig.metaCampaignNameFallbacks ?? [])],
  };
}

export function buildMessageTriggerEditorModel(params: {
  triggerConfig: ScenarioTriggerConfig;
  audienceOptions: ScenarioAudienceOptions;
  hasMetaAdsConnection: boolean;
  formatters: MessageTriggerEditorFormatters;
  t: TranslateFn;
}): MessageTriggerEditorModel {
  const mode = params.triggerConfig.messageMatchMode || "any";
  const availableChannels = normalizedUniqueValues(
    params.audienceOptions.channels
  );
  const configuredChannels = normalizedUniqueValues(
    params.triggerConfig.channelFilter
  );
  const allChannelIds = normalizedUniqueValues([
    ...availableChannels,
    ...configuredChannels,
  ]);
  const enabledChannels =
    configuredChannels.length > 0 ? configuredChannels : allChannelIds;
  const selection = resolveMetaReferralSelection(params.triggerConfig);
  const selectedCampaignId = selection.kind === "campaign" ? selection.id : "";
  const selectedAdSetId = selection.kind === "ad_set" ? selection.id : "";
  const selectedAdId = selection.kind === "ad" ? selection.id : "";
  const optionParams = {
    formatters: params.formatters,
    t: params.t,
  };
  const campaignOptions = prependStaleOption(
    params.audienceOptions.metaReferralCampaigns,
    selectedCampaignId,
    option => readTrimmedString(option.campaignId),
    () => ({
      id: `campaign:${selectedCampaignId}`,
      campaignId: selectedCampaignId,
      label: params.t("triggerMetaFallbackCampaign", {
        id: formatReferenceId(selectedCampaignId),
      }),
    })
  ).map(option => buildMetaOption({ kind: "campaign", option }, optionParams));
  const adSetOptions = prependStaleOption(
    params.audienceOptions.metaReferralAdSets,
    selectedAdSetId,
    option => readTrimmedString(option.adSetId),
    () => ({
      id: `adset:${selectedAdSetId}`,
      adSetId: selectedAdSetId,
      label: params.t("triggerMetaFallbackAdSet", {
        id: formatReferenceId(selectedAdSetId),
      }),
    })
  ).map(option => buildMetaOption({ kind: "ad_set", option }, optionParams));
  const adOptions = prependStaleOption(
    params.audienceOptions.metaReferralAds,
    selectedAdId,
    option => readTrimmedString(option.sourceId),
    () => ({
      id: `ad:${selectedAdId}`,
      sourceId: selectedAdId,
      sourceType: "ad",
      label: params.t("triggerMetaFallbackAd", {
        id: formatReferenceId(selectedAdId),
      }),
    })
  ).map(option => buildMetaOption({ kind: "ad", option }, optionParams));
  const selectedOption =
    selection.kind === "campaign"
      ? campaignOptions.find(option => option.id === selection.id)
      : selection.kind === "ad_set"
        ? adSetOptions.find(option => option.id === selection.id)
        : selection.kind === "ad"
          ? adOptions.find(option => option.id === selection.id)
          : null;
  const selectedLabel =
    selectedOption?.label ||
    (selection.kind === "any_instagram_ad"
      ? params.t("triggerMetaAnyInstagramAd")
      : params.t("triggerMatchAny"));
  const catalogStatus = params.audienceOptions.metaAdsDataStatus;
  const catalogWarning =
    !catalogStatus || catalogStatus.state === "complete"
      ? ""
      : catalogStatus.reasons.includes("not_connected")
        ? params.t("triggerMetaConnectMarketingApi")
        : catalogStatus.reasons.includes("limit_reached")
          ? params.t("triggerMetaCatalogLimited")
          : params.t(
              catalogStatus.state === "partial"
                ? "triggerMetaCatalogPartial"
                : "triggerMetaCatalogUnavailable"
            );

  return {
    onlyNewCustomers: params.triggerConfig.onlyNewCustomers === true,
    message: {
      mode,
      pattern: params.triggerConfig.keywordPattern || "",
      keywordMatchMode:
        params.triggerConfig.keywordMatchMode === "regex"
          ? "regex"
          : "contains",
      usesPattern: mode === "exact" || mode === "contains",
      isExact: mode === "exact",
      isContains: mode === "contains",
    },
    channels: {
      options: allChannelIds.map(id => ({
        id,
        label: localizeClientMessageChannel(id, params.t),
      })),
      enabledChannelSet: new Set(enabledChannels),
    },
    meta: {
      hasConnection: params.hasMetaAdsConnection,
      catalogWarning,
      selectValue: metaReferralSelectionToSelectValue(selection),
      selectedLabel,
      selectedMeta: selectedOption?.meta || "",
      campaignOptions,
      adSetOptions,
      adOptions,
    },
    product: buildProductRouteModel({
      triggerConfig: params.triggerConfig,
      audienceOptions: params.audienceOptions,
      hasMetaAdsConnection: params.hasMetaAdsConnection,
      t: params.t,
    }),
  };
}

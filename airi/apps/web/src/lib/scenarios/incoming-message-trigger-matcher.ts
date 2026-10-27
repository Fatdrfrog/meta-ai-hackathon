import type { ScenarioMessageIngressEventKind } from "@icecore/scenario-contracts";
import { isScenarioMessageIngressEventKind } from "@icecore/scenario-contracts";
import {
  normalizeWhatsAppReferralFields,
  resolveWhatsAppReferralSourcePlatform,
  type WhatsAppReferralFields,
} from "@icecore/whatsapp/referralFields";
import {
  hasCampaignProductRoute,
  resolveCampaignProductDecisions,
  type CampaignLabelStatus,
  type CampaignProductFacts,
  type CampaignProductRoute,
} from "./campaign-product-routing";
import { normalizeMetaAdAccountId } from "@/lib/meta-ads/meta-ad-account-id";
import {
  getCompiledClientMessageRegex,
  isClientMessageCriteriaMatchable,
  type ClientMessageTriggerCriteria,
} from "./client-message-trigger-criteria";

export type MetaReferralFields = Readonly<{
  sourceType?: string;
  sourceId?: string;
  sourceUrl?: string;
  sourcePlatform?: string;
  campaignId?: string;
  campaignName?: string;
  productCampaignName?: string;
  adSetId?: string;
  headline?: string;
  body?: string;
  mediaUrl?: string;
  adAccountId?: string;
  campaignLabelIds?: readonly string[];
  campaignLabels?: ReadonlyArray<{
    id?: string | null;
    name?: string | null;
  }>;
  campaignLabelStatus?: CampaignLabelStatus;
}>;

export type ScenarioIngressReferral = Readonly<{
  sourceType: string;
  sourceId: string;
  sourcePlatform: string;
  campaignId: string;
  adSetId: string;
  campaignName: string;
  headline: string;
  productCampaignName: string;
  adAccountId: string;
  campaignLabelIds: readonly string[];
  campaignLabelStatus: CampaignLabelStatus;
}>;

export type ScenarioIngressContext = Readonly<{
  eventKind: ScenarioMessageIngressEventKind;
  channel: string;
  messageText: string;
  normalizedMessageText: string;
  messageContentAvailable?: boolean;
  isNewCustomer: boolean | undefined;
  whatsappReferral: ScenarioIngressReferral | null;
  metaReferral: ScenarioIngressReferral | null;
}>;

type NullablePartial<T> = {
  [K in keyof T]?: T[K] | null;
};

export type ScenarioIngressContextInput = Readonly<{
  eventKind: ScenarioMessageIngressEventKind;
  channel: string;
  messageText?: string | null;
  messageContentAvailable?: boolean;
  isNewCustomer?: boolean;
  whatsappReferral?:
    | (NullablePartial<WhatsAppReferralFields> &
        NullablePartial<
          Pick<
            MetaReferralFields,
            | "adAccountId"
            | "campaignLabelIds"
            | "campaignLabels"
            | "campaignLabelStatus"
            | "productCampaignName"
          >
        >)
    | null;
  metaReferral?: NullablePartial<MetaReferralFields> | null;
}>;

function normalizeFact(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function readLabelIds(
  value:
    | {
        campaignLabelIds?: readonly string[] | null;
        campaignLabels?: ReadonlyArray<{ id?: string | null }> | null;
      }
    | null
    | undefined
): readonly string[] {
  const fromObjects = Array.isArray(value?.campaignLabels)
    ? value.campaignLabels.flatMap(label => {
        const id = typeof label?.id === "string" ? label.id.trim() : "";
        return id ? [id] : [];
      })
    : [];
  const fromIds = Array.isArray(value?.campaignLabelIds)
    ? value.campaignLabelIds.flatMap(id =>
        typeof id === "string" && id.trim() ? [id.trim()] : []
      )
    : [];
  return Object.freeze([...new Set([...fromObjects, ...fromIds])]);
}

function readLabelStatus(
  value: { campaignLabelStatus?: string | null } | null | undefined,
  hasCampaign: boolean
): CampaignLabelStatus {
  const status = value?.campaignLabelStatus;
  if (
    status === "present" ||
    status === "absent" ||
    status === "unavailable" ||
    status === "none"
  ) {
    return status;
  }
  return hasCampaign ? "unavailable" : "none";
}

function freezeReferral(
  referral: ScenarioIngressReferral
): ScenarioIngressReferral | null {
  return referral.sourceType ||
    referral.sourceId ||
    referral.sourcePlatform ||
    referral.campaignId ||
    referral.adSetId ||
    referral.productCampaignName
    ? Object.freeze({
        ...referral,
        campaignLabelIds: Object.freeze([...referral.campaignLabelIds]),
      })
    : null;
}

function projectWhatsAppReferral(
  value: ScenarioIngressContextInput["whatsappReferral"]
): ScenarioIngressReferral | null {
  const normalized = normalizeWhatsAppReferralFields(value);
  const campaignName = normalized.campaignName.trim();
  const productCampaignName =
    (typeof value?.productCampaignName === "string"
      ? value.productCampaignName.trim()
      : "") || campaignName;
  const hasCampaign = Boolean(
    normalized.sourceId || normalized.campaignId || productCampaignName
  );
  return freezeReferral({
    sourceType: normalizeFact(normalized.sourceType),
    sourceId: normalizeFact(normalized.sourceId),
    sourcePlatform: normalizeFact(normalized.sourcePlatform),
    campaignId: normalizeFact(normalized.campaignId),
    adSetId: normalizeFact(normalized.adSetId),
    campaignName,
    headline: normalized.headline.trim(),
    productCampaignName,
    adAccountId: normalizeMetaAdAccountId(value?.adAccountId),
    campaignLabelIds: readLabelIds(value),
    campaignLabelStatus: readLabelStatus(value, hasCampaign),
  });
}

function projectMetaReferral(
  value: ScenarioIngressContextInput["metaReferral"]
): ScenarioIngressReferral | null {
  const sourceUrl =
    typeof value?.sourceUrl === "string" ? value.sourceUrl.trim() : "";
  const sourcePlatform =
    normalizeFact(value?.sourcePlatform) ||
    normalizeFact(resolveWhatsAppReferralSourcePlatform(sourceUrl));

  const campaignName =
    typeof value?.campaignName === "string" ? value.campaignName.trim() : "";
  const productCampaignName =
    (typeof value?.productCampaignName === "string"
      ? value.productCampaignName.trim()
      : "") || campaignName;
  const hasCampaign = Boolean(
    value?.sourceId || value?.campaignId || productCampaignName
  );
  return freezeReferral({
    sourceType: normalizeFact(value?.sourceType),
    sourceId: normalizeFact(value?.sourceId),
    sourcePlatform,
    campaignId: normalizeFact(value?.campaignId),
    adSetId: normalizeFact(value?.adSetId),
    campaignName,
    headline: typeof value?.headline === "string" ? value.headline.trim() : "",
    productCampaignName,
    adAccountId: normalizeMetaAdAccountId(value?.adAccountId),
    campaignLabelIds: readLabelIds(value),
    campaignLabelStatus: readLabelStatus(value, hasCampaign),
  });
}

/**
 * Projects raw event facts once so every candidate sees the same immutable
 * ingress snapshot. Referral values and a dedicated text comparison value are
 * case-normalized; raw text, text whitespace, and channel casing are preserved.
 */
export function projectScenarioIngressContext(
  input: ScenarioIngressContextInput
): ScenarioIngressContext {
  const eventKind = input.eventKind;
  const channel = input.channel;
  const messageText = input.messageText;
  const isNewCustomer = input.isNewCustomer;
  const whatsappReferral = input.whatsappReferral;
  const metaReferral = input.metaReferral;

  return Object.freeze({
    eventKind,
    channel: typeof channel === "string" ? channel : "",
    messageText: typeof messageText === "string" ? messageText : "",
    normalizedMessageText:
      typeof messageText === "string" ? messageText.toLowerCase() : "",
    ...(input.messageContentAvailable === false
      ? { messageContentAvailable: false }
      : {}),
    isNewCustomer:
      typeof isNewCustomer === "boolean" ? isNewCustomer : undefined,
    whatsappReferral: projectWhatsAppReferral(whatsappReferral),
    metaReferral: projectMetaReferral(metaReferral),
  });
}

function matchesChannel(
  criteria: ClientMessageTriggerCriteria,
  ingress: ScenarioIngressContext
): boolean {
  return (
    criteria.channelFilter.length === 0 ||
    criteria.channelFilter.includes(ingress.channel)
  );
}

function collectKeywordHaystacks(ingress: ScenarioIngressContext): {
  raw: readonly string[];
  normalized: readonly string[];
} {
  const raw = [ingress.messageText];
  const normalized = [ingress.normalizedMessageText];

  for (const referral of [ingress.whatsappReferral, ingress.metaReferral]) {
    if (referral?.sourceType !== "ad") continue;
    for (const value of [referral.campaignName, referral.headline]) {
      if (!value) continue;
      raw.push(value);
      normalized.push(value.toLowerCase());
    }
  }

  return { raw, normalized };
}

function matchesText(
  criteria: ClientMessageTriggerCriteria,
  ingress: ScenarioIngressContext
): boolean {
  const textCriteria = criteria.text;
  if (textCriteria.mode === "any") return true;
  if (ingress.messageContentAvailable === false) return false;

  const haystacks = collectKeywordHaystacks(ingress);

  if (textCriteria.mode === "exact") {
    return (
      textCriteria.status === "valid" &&
      haystacks.normalized.some(
        value => value === textCriteria.pattern.toLowerCase()
      )
    );
  }

  if (textCriteria.status !== "valid" || !textCriteria.matcher) return false;
  if (textCriteria.matcher.kind === "literal") {
    return textCriteria.matcher.candidates.some(candidate => {
      const needle = candidate.toLowerCase();
      return haystacks.normalized.some(value => value.includes(needle));
    });
  }

  const regex = getCompiledClientMessageRegex(textCriteria.matcher);
  if (!regex) return false;
  return haystacks.raw.some(value => regex.test(value));
}

function configuredValuesMatch(
  configured: readonly string[],
  candidate: string
): boolean {
  return (
    configured.length === 0 ||
    configured.some(value => value.toLowerCase() === candidate)
  );
}

function referralMatches(
  criteria: ClientMessageTriggerCriteria,
  candidate: ScenarioIngressReferral
): boolean {
  return (
    configuredValuesMatch(
      criteria.whatsappReferralSourceTypes,
      candidate.sourceType
    ) &&
    configuredValuesMatch(
      criteria.whatsappReferralSourcePlatforms,
      candidate.sourcePlatform
    ) &&
    configuredValuesMatch(criteria.metaReferralSourceIds, candidate.sourceId) &&
    configuredValuesMatch(
      criteria.metaReferralCampaignIds,
      candidate.campaignId
    ) &&
    configuredValuesMatch(criteria.metaReferralAdSetIds, candidate.adSetId)
  );
}

function campaignFactsFromReferral(
  referral: ScenarioIngressReferral | null
): CampaignProductFacts {
  if (!referral) {
    return {
      adAccountId: "",
      campaignId: "",
      campaignName: "",
      labelIds: [],
      labelStatus: "none",
    };
  }
  return {
    adAccountId: referral.adAccountId,
    campaignId: referral.campaignId,
    campaignName: referral.productCampaignName,
    labelIds: referral.campaignLabelIds,
    labelStatus: referral.campaignLabelStatus,
  };
}

export function campaignProductRouteFromCriteria(
  criteria: ClientMessageTriggerCriteria
): CampaignProductRoute {
  return {
    adAccountId: criteria.metaCampaignAdAccountId ?? "",
    labels: criteria.metaCampaignLabels ?? [],
    nameFallbacks: criteria.metaCampaignNameFallbacks ?? [],
  };
}

export function campaignProductFactsForCriteria(
  criteria: ClientMessageTriggerCriteria,
  ingress: ScenarioIngressContext
): CampaignProductFacts {
  const matched = [ingress.whatsappReferral, ingress.metaReferral].filter(
    (referral): referral is ScenarioIngressReferral =>
      referral !== null && referralMatches(criteria, referral)
  );
  const selected =
    matched.find(
      referral =>
        referral.campaignLabelStatus === "present" ||
        referral.campaignLabelStatus === "absent"
    ) ??
    matched.find(
      referral => referral.productCampaignName || referral.campaignId
    ) ??
    matched[0] ??
    null;
  return campaignFactsFromReferral(selected);
}

function matchesReferral(
  criteria: ClientMessageTriggerCriteria,
  ingress: ScenarioIngressContext
): boolean {
  const hasReferralFilter =
    criteria.whatsappReferralSourceTypes.length > 0 ||
    criteria.whatsappReferralSourcePlatforms.length > 0 ||
    criteria.metaReferralSourceIds.length > 0 ||
    criteria.metaReferralCampaignIds.length > 0 ||
    criteria.metaReferralAdSetIds.length > 0;
  if (!hasReferralFilter) return true;

  return [ingress.whatsappReferral, ingress.metaReferral].some(
    candidate => candidate !== null && referralMatches(criteria, candidate)
  );
}

export function matchesIncomingMessageStructure(
  criteria: ClientMessageTriggerCriteria,
  ingress: ScenarioIngressContext
): boolean {
  if (!isScenarioMessageIngressEventKind(ingress.eventKind)) return false;
  if (!isClientMessageCriteriaMatchable(criteria)) return false;
  if (!matchesChannel(criteria, ingress)) return false;
  if (criteria.onlyNewCustomers && ingress.isNewCustomer === false) {
    return false;
  }
  if (!matchesReferral(criteria, ingress)) return false;
  return matchesText(criteria, ingress);
}

export function matchesIncomingMessageTrigger(
  criteria: ClientMessageTriggerCriteria,
  ingress: ScenarioIngressContext
): boolean {
  if (!matchesIncomingMessageStructure(criteria, ingress)) return false;
  const route = campaignProductRouteFromCriteria(criteria);
  if (!hasCampaignProductRoute(route)) return true;
  const decision = resolveCampaignProductDecisions([
    {
      key: "local",
      route,
      facts: campaignProductFactsForCriteria(criteria, ingress),
    },
  ]).get("local");
  return decision?.allow === true;
}

import type { ClientMessageTriggerCriteria } from "@/lib/scenarios/client-message-trigger-criteria";
import type { ScenarioAudienceOptions, TranslateFn } from "../types";

export type ClientMessageSummaryItem = Readonly<{
  kind:
    | "message"
    | "customers"
    | "channels"
    | "referral-platforms"
    | "referral-types"
    | "ad"
    | "campaign"
    | "ad-set"
    | "labels"
    | "name-fallback";
  text: string;
}>;

export type ClientMessageTriggerPresentation = Readonly<{
  summaryChips: readonly string[];
  summaryItems: readonly ClientMessageSummaryItem[];
  linkedSummary: string;
}>;

const LINKED_PATTERN_MAX_LENGTH = 30;

const CHANNEL_LABEL_KEY_BY_ID: Readonly<Record<string, string>> = {
  whatsapp: "actionSourceWhatsApp",
  instagram: "actionSourceInstagram",
  telegram: "actionSourceTelegram",
  email: "actionSourceEmail",
  web_widget: "triggerChannelWebChat",
};

function capitalizeIdentifier(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function localizeClientMessageChannel(
  value: string,
  t: TranslateFn
): string {
  const key = CHANNEL_LABEL_KEY_BY_ID[value];
  return key ? t(key) : capitalizeIdentifier(value);
}

function truncateLinkedPattern(pattern: string): string {
  return pattern.length > LINKED_PATTERN_MAX_LENGTH
    ? `${pattern.slice(0, LINKED_PATTERN_MAX_LENGTH)}…`
    : pattern;
}

function buildTextPresentation(
  criteria: ClientMessageTriggerCriteria,
  t: TranslateFn
): { summary: string; linked: string } {
  const text = criteria.text;

  if (text.mode === "any") {
    return {
      summary: t("triggerMatchAny"),
      linked: t("scenarioLinkTriggerIncoming"),
    };
  }

  if (text.mode === "exact") {
    if (text.status !== "valid") {
      return {
        summary: t("triggerMatchExact"),
        linked: t("scenarioLinkTriggerExactTextDefault"),
      };
    }

    const pattern = text.pattern.trim();
    return {
      summary: t("scenarioLinkTriggerExactText", { text: pattern }),
      linked: t("scenarioLinkTriggerExactText", {
        text: truncateLinkedPattern(pattern),
      }),
    };
  }

  if (text.status !== "valid") {
    return {
      summary: t("triggerMatchContains"),
      linked: t("scenarioLinkTriggerContainsDefault"),
    };
  }

  const pattern = text.matcher.source.trim();
  return {
    summary: t("scenarioLinkContains", { text: pattern }),
    linked: t("scenarioLinkTriggerContains", {
      text: truncateLinkedPattern(pattern),
    }),
  };
}

export function buildClientMessageTriggerPresentation(
  criteria: ClientMessageTriggerCriteria,
  t: TranslateFn,
  catalog?: Pick<
    ScenarioAudienceOptions,
    "metaReferralCampaigns" | "metaReferralAdSets" | "metaReferralAds"
  >
): ClientMessageTriggerPresentation {
  const text = buildTextPresentation(criteria, t);
  const summaryItems: ClientMessageSummaryItem[] = [
    { kind: "message", text: text.summary },
  ];
  const add = (kind: ClientMessageSummaryItem["kind"], value: string) =>
    summaryItems.push({ kind, text: value });

  if (criteria.onlyNewCustomers) {
    add("customers", t("triggerOnlyNewCustomers"));
  }
  if (criteria.channelFilter.length > 0) {
    add(
      "channels",
      criteria.channelFilter
        .map(channel => localizeClientMessageChannel(channel, t))
        .join(", ")
    );
  }
  if (criteria.whatsappReferralSourcePlatforms.length > 0) {
    add(
      "referral-platforms",
      criteria.whatsappReferralSourcePlatforms
        .map(platform => localizeClientMessageChannel(platform, t))
        .join(", ")
    );
  }
  if (criteria.whatsappReferralSourceTypes.length > 0) {
    add(
      "referral-types",
      t("triggerSummaryWhatsAppReferralTypes", {
        types: criteria.whatsappReferralSourceTypes.join(", "),
      })
    );
  }
  if (criteria.metaReferralSourceIds.length > 0) {
    add(
      "ad",
      catalog
        ? t("triggerSummaryMetaAdNamed", {
            name: criteria.metaReferralSourceIds
              .map(
                id =>
                  catalog.metaReferralAds?.find(
                    option => option.sourceId === id
                  )?.label || id
              )
              .join(", "),
          })
        : t("triggerSummaryInstagramAd")
    );
  }
  if (criteria.metaReferralCampaignIds.length > 0) {
    add(
      "campaign",
      catalog
        ? t("triggerSummaryMetaCampaignNamed", {
            name: criteria.metaReferralCampaignIds
              .map(
                id =>
                  catalog.metaReferralCampaigns?.find(
                    option => option.campaignId === id
                  )?.label || id
              )
              .join(", "),
          })
        : t("triggerSummaryMetaCampaign")
    );
  }
  if (criteria.metaReferralAdSetIds.length > 0) {
    add(
      "ad-set",
      catalog
        ? t("triggerSummaryMetaAdSetNamed", {
            name: criteria.metaReferralAdSetIds
              .map(
                id =>
                  catalog.metaReferralAdSets?.find(
                    option => option.adSetId === id
                  )?.label || id
              )
              .join(", "),
          })
        : t("triggerSummaryMetaAdSet")
    );
  }
  if (criteria.metaCampaignLabels.length > 0) {
    add(
      "labels",
      t("triggerSummaryCampaignLabels", {
        labels: criteria.metaCampaignLabels
          .map(label => label.name || label.id)
          .join(", "),
      })
    );
  }
  if (criteria.metaCampaignNameFallbacks.length > 0) {
    add(
      "name-fallback",
      t("triggerSummaryCampaignNameFallback", {
        names: criteria.metaCampaignNameFallbacks.join(", "),
      })
    );
  }

  return Object.freeze({
    summaryChips: Object.freeze(summaryItems.map(item => item.text)),
    summaryItems: Object.freeze(summaryItems),
    linkedSummary: text.linked,
  });
}

import type {
  ScenarioAudienceOptions,
  ScenarioTriggerConfig,
  TranslateFn,
} from "../../types";
import {
  buildMessageTriggerEditorModel,
  createMessageTriggerEditorFormatters,
  type MessageTriggerMetaOption,
} from "./message-trigger-editor-model";

const t: TranslateFn = (key, values) => {
  if (key === "triggerMetaFallbackCampaign") {
    return `Campaign ${values?.id}`;
  }
  if (key === "triggerMetaConversationCount") {
    return `Conversations: ${values?.count}`;
  }
  if (key === "triggerMetaLastSeen") {
    return `Last seen: ${values?.date}`;
  }
  if (key === "triggerChannelWebChat") return "Web Chat";
  return key;
};

const echoT: TranslateFn = (key, values) =>
  values
    ? `${key}(${Object.entries(values)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(",")})`
    : key;

const audienceOptions: ScenarioAudienceOptions = {
  channels: ["whatsapp", "web_widget"],
  classificationCategories: [],
  funnelStages: [],
  internalLabels: [],
  customers: [],
  metaReferralAds: [],
  metaReferralCampaigns: [],
  metaReferralAdSets: [],
  metaCampaignLabels: [],
};

function buildModel(
  triggerConfig: ScenarioTriggerConfig = {},
  options = audienceOptions,
  translate: TranslateFn = t
) {
  return buildMessageTriggerEditorModel({
    triggerConfig,
    audienceOptions: options,
    hasMetaAdsConnection: true,
    formatters: createMessageTriggerEditorFormatters("en-US"),
    t: translate,
  });
}

describe("message trigger editor model", () => {
  it("keeps saved choices available while showing incomplete catalog status", () => {
    const model = buildModel(
      { metaReferralCampaignIds: ["saved"] },
      {
        ...audienceOptions,
        metaAdsDataStatus: { state: "partial", reasons: ["provider_error"] },
      }
    );
    expect(model.meta.catalogWarning).toBe("triggerMetaCatalogPartial");
    expect(model.meta.campaignOptions[0].id).toBe("saved");
  });

  it.each([
    ["unavailable", ["provider_error"], "triggerMetaCatalogUnavailable"],
    ["partial", ["limit_reached"], "triggerMetaCatalogLimited"],
    ["complete", [], ""],
  ] as const)(
    "describes %s catalog without changing the trigger",
    (state, reasons, warning) => {
      const model = buildModel(
        {},
        {
          ...audienceOptions,
          metaAdsDataStatus: { state, reasons: [...reasons] },
        }
      );
      expect(model.meta.catalogWarning).toBe(warning);
      expect(model.meta.selectValue).toBe("any_message");
    }
  );
  it.each([
    ["any", false, false],
    ["exact", true, false],
    ["contains", true, true],
  ] as const)(
    "derives %s message matching",
    (mode, usesPattern, isContains) => {
      const model = buildModel({
        messageMatchMode: mode,
        keywordMatchMode: "regex",
        keywordPattern: "stored pattern",
      });

      expect(model.message).toMatchObject({
        mode,
        usesPattern,
        isContains,
        keywordMatchMode: "regex",
        pattern: "stored pattern",
      });
    }
  );

  it("treats no channel filter as all available channels", () => {
    const model = buildModel();

    expect(model.channels.options.map(option => option.id)).toEqual([
      "whatsapp",
      "web_widget",
    ]);
    expect(Array.from(model.channels.enabledChannelSet)).toEqual([
      "whatsapp",
      "web_widget",
    ]);
    expect(model.channels.options[1]?.label).toBe("Web Chat");
  });

  it("uses translated labels for every known channel", () => {
    const model = buildModel(
      {},
      {
        ...audienceOptions,
        channels: ["whatsapp", "instagram", "telegram", "email", "web_widget"],
      }
    );

    expect(model.channels.options.map(option => option.label)).toEqual([
      "actionSourceWhatsApp",
      "actionSourceInstagram",
      "actionSourceTelegram",
      "actionSourceEmail",
      "Web Chat",
    ]);
  });

  it("preserves stale configured channels while options are loading", () => {
    const model = buildModel(
      { channelFilter: ["legacy_sms"] },
      { ...audienceOptions, channels: [] }
    );

    expect(model.channels.options.map(option => option.id)).toEqual([
      "legacy_sms",
    ]);
    expect(Array.from(model.channels.enabledChannelSet)).toEqual([
      "legacy_sms",
    ]);
  });

  it("synthesizes a localized option for a stale persisted Meta ID", () => {
    const model = buildModel({ metaReferralCampaignIds: ["old-campaign-id"] });

    expect(model.meta.campaignOptions[0]).toMatchObject({
      id: "old-campaign-id",
      label: "Campaign old-campaign-id",
    });
    expect(model.meta.selectedLabel).toBe("Campaign old-campaign-id");
  });

  it.each([
    [
      "metaReferralCampaignIds",
      "campaignOptions",
      "campaign:missing",
      "triggerMetaFallbackCampaign",
    ],
    [
      "metaReferralAdSetIds",
      "adSetOptions",
      "ad_set:missing",
      "triggerMetaFallbackAdSet",
    ],
    [
      "metaReferralSourceIds",
      "adOptions",
      "ad:missing",
      "triggerMetaFallbackAd",
    ],
  ] as const)(
    "keeps a selectable fallback for %s while the catalog is empty",
    (filterKey, optionKey, selectValue, labelKey) => {
      const model = buildModel({ [filterKey]: ["missing"] });
      expect(model.meta[optionKey]).toHaveLength(1);
      expect(model.meta[optionKey][0]).toMatchObject({
        id: "missing",
        label: t(labelKey, { id: "missing" }),
        selectValue,
      });
      expect(model.meta.selectValue).toBe(selectValue);
      expect(model.meta.selectedLabel).toBe(t(labelKey, { id: "missing" }));
    }
  );

  it("uses the catalog option once a persisted Meta ID is available", () => {
    const model = buildModel(
      { metaReferralCampaignIds: ["campaign-1"] },
      {
        ...audienceOptions,
        metaReferralCampaigns: [
          {
            id: "campaign:1",
            campaignId: "campaign-1",
            label: "Current campaign",
          },
        ],
      }
    );
    expect(model.meta.campaignOptions).toHaveLength(1);
    expect(model.meta.selectedLabel).toBe("Current campaign");
  });

  it("formats Meta counts and dates with the selected locale", () => {
    const model = buildModel(
      { metaReferralCampaignIds: ["campaign-1"] },
      {
        ...audienceOptions,
        metaReferralCampaigns: [
          {
            id: "campaign:1",
            campaignId: "campaign-1",
            label: "Launch",
            conversationCount: 1234,
            lastSeenAt: "2026-01-02T12:00:00.000Z",
          },
        ],
      }
    );

    expect(model.meta.campaignOptions[0]?.meta).toContain(
      "Conversations: 1,234"
    );
    expect(model.meta.campaignOptions[0]?.meta).toContain("Last seen: Jan 2");
  });

  it.each<{
    name: string;
    catalog: Partial<ScenarioAudienceOptions>;
    optionKey: "campaignOptions" | "adSetOptions" | "adOptions";
    expected: MessageTriggerMetaOption;
  }>([
    {
      name: "campaign",
      catalog: {
        metaReferralCampaigns: [
          {
            id: "campaign:1",
            campaignId: "campaign-1",
            label: "Launch",
            campaignName: "Launch campaign",
            adCount: 3,
            conversationCount: 1234,
          },
        ],
      },
      optionKey: "campaignOptions",
      expected: {
        id: "campaign-1",
        label: "Launch",
        meta: "campaign-1 / triggerMetaAdCount(count=3) / triggerMetaConversationCount(count=1,234)",
        title:
          "Launch / campaign-1 / triggerMetaAdCount(count=3) / triggerMetaConversationCount(count=1,234)",
        selectValue: "campaign:campaign-1",
      },
    },
    {
      name: "ad set",
      catalog: {
        metaReferralAdSets: [
          {
            id: "adset:1",
            adSetId: "set-1",
            label: "Almaty",
            adSetName: "Almaty set",
            campaignName: "Launch",
            adCount: 2,
          },
        ],
      },
      optionKey: "adSetOptions",
      expected: {
        id: "set-1",
        label: "Almaty",
        meta: "set-1 / triggerMetaCampaignMetadata(name=Launch) / triggerMetaAdCount(count=2)",
        title:
          "Almaty / set-1 / triggerMetaCampaignMetadata(name=Launch) / triggerMetaAdCount(count=2)",
        selectValue: "ad_set:set-1",
      },
    },
    {
      name: "ad",
      catalog: {
        metaReferralAds: [
          {
            id: "ad:1",
            sourceId: "ad-1",
            label: "New phone",
            campaignName: "Launch",
            adSetName: "Almaty",
            conversationCount: 5,
            lastSeenAt: "2026-01-02T12:00:00.000Z",
            sourceUrl: "https://www.example.com/promo?ref=1",
          },
        ],
      },
      optionKey: "adOptions",
      expected: {
        id: "ad-1",
        label: "New phone",
        meta: "triggerMetaSourceIdMetadata(id=ad-1) / triggerMetaCampaignMetadata(name=Launch) / triggerMetaAdSetMetadata(name=Almaty) / triggerMetaConversationCount(count=5) / triggerMetaLastSeen(date=Jan 2) / example.com",
        title:
          "New phone / triggerMetaSourceIdMetadata(id=ad-1) / triggerMetaCampaignMetadata(name=Launch) / triggerMetaAdSetMetadata(name=Almaty) / triggerMetaConversationCount(count=5) / triggerMetaLastSeen(date=Jan 2) / example.com / https://www.example.com/promo?ref=1",
        selectValue: "ad:ad-1",
      },
    },
  ])(
    "describes a $name option with only the metadata its kind owns",
    ({ catalog, optionKey, expected }) => {
      const model = buildModel({}, { ...audienceOptions, ...catalog }, echoT);

      expect(model.meta[optionKey]).toEqual([expected]);
    }
  );
});

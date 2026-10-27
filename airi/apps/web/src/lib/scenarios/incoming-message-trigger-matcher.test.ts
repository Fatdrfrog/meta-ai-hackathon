import type {
  ScenarioMessageIngressEventKind,
  ScenarioPostActionEventKind,
  ScenarioTriggerConfig,
} from "@icecore/scenario-contracts";
import {
  projectActiveClientMessageFilters,
  type ClientMessageTriggerCriteria,
} from "./client-message-trigger-criteria";
import {
  matchesIncomingMessageTrigger,
  projectScenarioIngressContext,
  type ScenarioIngressContext,
  type ScenarioIngressContextInput,
} from "./incoming-message-trigger-matcher";

type ProjectedIngressEventKind = Parameters<
  typeof projectScenarioIngressContext
>[0]["eventKind"];

const compileTimeIngressKind: ProjectedIngressEventKind = "inbound_message";
void compileTimeIngressKind;

// @ts-expect-error Post-action events cannot enter the ingress projector.
const compileTimePostActionKind: ProjectedIngressEventKind = "payment_detected";
void compileTimePostActionKind;

const INGRESS_EVENT_KINDS = [
  "inbound_message",
  "telegram_quick_reply",
  "instagram_quick_reply",
  "whatsapp_button_reply",
  "whatsapp_flow_reply",
] as const satisfies readonly ScenarioMessageIngressEventKind[];

const POST_ACTION_EVENT_KINDS = [
  "payment_detected",
  "no_human_reply_timeout",
  "post_action_user_reply",
] as const satisfies readonly ScenarioPostActionEventKind[];

function criteria(
  config: ScenarioTriggerConfig = {}
): ClientMessageTriggerCriteria {
  return projectActiveClientMessageFilters(config);
}

function ingress(
  overrides: Partial<ScenarioIngressContextInput> = {}
): ScenarioIngressContext {
  return projectScenarioIngressContext({
    eventKind: "inbound_message",
    channel: "whatsapp",
    messageText: "",
    ...overrides,
  });
}

function matches(
  config: ScenarioTriggerConfig,
  overrides: Partial<ScenarioIngressContextInput> = {}
): boolean {
  return matchesIncomingMessageTrigger(criteria(config), ingress(overrides));
}

describe("incoming message trigger matcher", () => {
  it("matches Any without activating dormant matcher fields", () => {
    expect(
      matches(
        {
          enabled: true,
          messageMatchMode: "any",
          keywordMatchMode: "regex",
          keywordPattern: "[",
        },
        { messageText: "anything" }
      )
    ).toBe(true);
  });

  it("matches Exact case-insensitively while preserving whitespace", () => {
    const exact = criteria({
      messageMatchMode: "exact",
      keywordMatchMode: "regex",
      keywordPattern: "  Refund  ",
    });

    expect(
      matchesIncomingMessageTrigger(
        exact,
        ingress({ messageText: "  refund  " })
      )
    ).toBe(true);
    expect(
      matchesIncomingMessageTrigger(exact, ingress({ messageText: "refund" }))
    ).toBe(false);
  });

  it("matches every literal Contains alternative", () => {
    expect(
      matches(
        {
          messageMatchMode: "contains",
          keywordMatchMode: "contains",
          keywordPattern: "refund, cancel;exchange\nreturn",
        },
        { messageText: "Please CANCEL my order" }
      )
    ).toBe(true);
  });

  it("matches a valid case-insensitive regex", () => {
    expect(
      matches(
        {
          messageMatchMode: "contains",
          keywordMatchMode: "regex",
          keywordPattern: "refund\\s+request",
        },
        { messageText: "New REFUND request" }
      )
    ).toBe(true);
  });

  it("reuses one compiled regex for repeated matches of the same matcher", () => {
    let sourceReads = 0;
    const matcher = Object.freeze({
      kind: "regex" as const,
      get source(): string {
        sourceReads += 1;
        return "refund\\s+request";
      },
    });
    const regexCriteria = Object.freeze({
      enabled: true,
      channelFilter: Object.freeze([]),
      onlyNewCustomers: false,
      whatsappReferralSourceTypes: Object.freeze([]),
      whatsappReferralSourcePlatforms: Object.freeze([]),
      metaReferralSourceIds: Object.freeze([]),
      metaReferralCampaignIds: Object.freeze([]),
      metaReferralAdSetIds: Object.freeze([]),
      metaCampaignAdAccountId: "",
      metaCampaignLabels: Object.freeze([]),
      metaCampaignNameFallbacks: Object.freeze([]),
      text: Object.freeze({
        mode: "contains" as const,
        status: "valid" as const,
        matcher,
      }),
    }) satisfies ClientMessageTriggerCriteria;
    const context = ingress({ messageText: "New REFUND request" });

    expect(matchesIncomingMessageTrigger(regexCriteria, context)).toBe(true);
    expect(matchesIncomingMessageTrigger(regexCriteria, context)).toBe(true);
    expect(sourceReads).toBe(1);
  });

  it("preserves raw Unicode text for case-insensitive regex evaluation", () => {
    const context = ingress({ messageText: "İ" });

    expect(context.messageText).toBe("İ");
    expect(context.normalizedMessageText).toBe("i̇");
    expect(
      matchesIncomingMessageTrigger(
        criteria({
          messageMatchMode: "contains",
          keywordMatchMode: "regex",
          keywordPattern: "İ",
        }),
        context
      )
    ).toBe(true);
  });

  it.each([
    {
      name: "disabled criteria",
      config: { enabled: false } satisfies ScenarioTriggerConfig,
    },
    {
      name: "missing Exact pattern",
      config: {
        messageMatchMode: "exact",
      } satisfies ScenarioTriggerConfig,
    },
    {
      name: "empty literal Contains pattern",
      config: {
        messageMatchMode: "contains",
        keywordMatchMode: "contains",
        keywordPattern: ", ;\r\n",
      } satisfies ScenarioTriggerConfig,
    },
    {
      name: "invalid regex",
      config: {
        messageMatchMode: "contains",
        keywordMatchMode: "regex",
        keywordPattern: "[",
      } satisfies ScenarioTriggerConfig,
    },
  ])("fails closed for $name", ({ config }) => {
    expect(matches(config, { messageText: "refund" })).toBe(false);
  });

  it("uses exact channel semantics and the projected new-customer fact", () => {
    const filtered = criteria({
      channelFilter: ["whatsapp"],
      onlyNewCustomers: true,
    });

    expect(
      matchesIncomingMessageTrigger(
        filtered,
        ingress({ channel: "whatsapp", isNewCustomer: true })
      )
    ).toBe(true);
    expect(
      matchesIncomingMessageTrigger(
        filtered,
        ingress({ channel: "WhatsApp", isNewCustomer: true })
      )
    ).toBe(false);
    expect(
      matchesIncomingMessageTrigger(
        filtered,
        ingress({ channel: "whatsapp", isNewCustomer: false })
      )
    ).toBe(false);
    expect(
      matchesIncomingMessageTrigger(
        filtered,
        ingress({ channel: "whatsapp", isNewCustomer: undefined })
      )
    ).toBe(true);
  });

  it.each([
    {
      name: "WhatsApp source type",
      config: {
        whatsappReferralSourceTypes: ["AD"],
      } satisfies ScenarioTriggerConfig,
      context: {
        whatsappReferral: {
          sourceType: " ad ",
        },
      } satisfies Partial<ScenarioIngressContextInput>,
    },
    {
      name: "WhatsApp source platform",
      config: {
        whatsappReferralSourcePlatforms: ["INSTAGRAM"],
      } satisfies ScenarioTriggerConfig,
      context: {
        whatsappReferral: {
          sourceUrl: " https://www.instagram.com/p/referral/ ",
        },
      } satisfies Partial<ScenarioIngressContextInput>,
    },
    {
      name: "Meta source ID",
      config: {
        metaReferralSourceIds: ["ig-ad-123"],
      } satisfies ScenarioTriggerConfig,
      context: {
        metaReferral: {
          sourceId: " IG-AD-123 ",
        },
      } satisfies Partial<ScenarioIngressContextInput>,
    },
    {
      name: "Meta campaign ID",
      config: {
        metaReferralCampaignIds: ["campaign-123"],
      } satisfies ScenarioTriggerConfig,
      context: {
        metaReferral: {
          campaignId: " CAMPAIGN-123 ",
        },
      } satisfies Partial<ScenarioIngressContextInput>,
    },
    {
      name: "Meta ad-set ID",
      config: {
        metaReferralAdSetIds: ["adset-123"],
      } satisfies ScenarioTriggerConfig,
      context: {
        metaReferral: {
          adSetId: " ADSET-123 ",
        },
      } satisfies Partial<ScenarioIngressContextInput>,
    },
  ])("matches normalized $name filters", ({ config, context }) => {
    expect(matches(config, context)).toBe(true);
  });

  it("allows exact Meta IDs to match normalized WhatsApp referral facts", () => {
    expect(
      matches(
        {
          metaReferralSourceIds: ["238000111222333"],
          metaReferralCampaignIds: ["campaign-123"],
          metaReferralAdSetIds: ["adset-123"],
        },
        {
          whatsappReferral: {
            sourceType: "ad",
            sourceId: " 238000111222333 ",
            campaignId: " CAMPAIGN-123 ",
            adSetId: " ADSET-123 ",
            sourceUrl: "https://instagram.com/p/referral/",
          },
        }
      )
    ).toBe(true);
  });

  it("requires one referral candidate to satisfy every constrained dimension", () => {
    expect(
      matches(
        {
          whatsappReferralSourceTypes: ["ad"],
          metaReferralSourceIds: ["meta-source"],
        },
        {
          whatsappReferral: {
            sourceType: "ad",
            sourceId: "whatsapp-source",
          },
          metaReferral: {
            sourceType: "post",
            sourceId: "meta-source",
          },
        }
      )
    ).toBe(false);
  });

  it("fails closed when referral filters have no matching referral", () => {
    expect(
      matches(
        {
          metaReferralCampaignIds: ["campaign-123"],
        },
        {
          metaReferral: {
            campaignId: "campaign-456",
          },
        }
      )
    ).toBe(false);
    expect(
      matches({
        whatsappReferralSourceTypes: ["ad"],
      })
    ).toBe(false);
  });

  it.each(INGRESS_EVENT_KINDS)("accepts ingress event kind %s", eventKind => {
    expect(
      matchesIncomingMessageTrigger(criteria(), ingress({ eventKind }))
    ).toBe(true);
  });

  it.each(POST_ACTION_EVENT_KINDS)(
    "fails closed for post-action event kind %s at runtime",
    eventKind => {
      const invalidContext = {
        ...ingress(),
        eventKind,
      } as unknown as ScenarioIngressContext;

      expect(matchesIncomingMessageTrigger(criteria(), invalidContext)).toBe(
        false
      );
    }
  );

  it("projects event facts once into a deeply frozen reusable context", () => {
    let messageTextReads = 0;
    let whatsappReferralReads = 0;
    let metaReferralReads = 0;
    const whatsappReferral = Object.freeze({
      sourceType: " AD ",
      sourceId: " WA-SOURCE ",
      sourceUrl: " https://instagram.com/p/referral/ ",
    });
    const metaReferral = Object.freeze({
      sourceType: " AD ",
      sourceId: " META-SOURCE ",
      sourcePlatform: " INSTAGRAM ",
      campaignId: " CAMPAIGN-1 ",
      adSetId: " ADSET-1 ",
    });
    const rawInput = Object.freeze({
      eventKind: "inbound_message" as const,
      channel: "whatsapp",
      get messageText() {
        messageTextReads += 1;
        return "  ReFuNd  ";
      },
      isNewCustomer: true,
      get whatsappReferral() {
        whatsappReferralReads += 1;
        return whatsappReferral;
      },
      get metaReferral() {
        metaReferralReads += 1;
        return metaReferral;
      },
    });

    const context = projectScenarioIngressContext(rawInput);
    const inputSnapshot = {
      whatsappReferral: { ...whatsappReferral },
      metaReferral: { ...metaReferral },
    };

    expect(context).toEqual({
      eventKind: "inbound_message",
      channel: "whatsapp",
      messageText: "  ReFuNd  ",
      normalizedMessageText: "  refund  ",
      isNewCustomer: true,
      whatsappReferral: {
        sourceType: "ad",
        sourceId: "wa-source",
        sourcePlatform: "instagram",
        campaignId: "",
        adSetId: "",
        campaignName: "",
        headline: "",
        productCampaignName: "",
        adAccountId: "",
        campaignLabelIds: [],
        campaignLabelStatus: "unavailable",
      },
      metaReferral: {
        sourceType: "ad",
        sourceId: "meta-source",
        sourcePlatform: "instagram",
        campaignId: "campaign-1",
        adSetId: "adset-1",
        campaignName: "",
        headline: "",
        productCampaignName: "",
        adAccountId: "",
        campaignLabelIds: [],
        campaignLabelStatus: "unavailable",
      },
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.whatsappReferral)).toBe(true);
    expect(Object.isFrozen(context.metaReferral)).toBe(true);
    expect(messageTextReads).toBe(1);
    expect(whatsappReferralReads).toBe(1);
    expect(metaReferralReads).toBe(1);

    const exact = criteria({
      messageMatchMode: "exact",
      keywordPattern: "  REFUND  ",
    });
    expect(matchesIncomingMessageTrigger(exact, context)).toBe(true);
    expect(matchesIncomingMessageTrigger(exact, context)).toBe(true);
    expect(messageTextReads).toBe(1);
    expect(whatsappReferralReads).toBe(1);
    expect(metaReferralReads).toBe(1);
    expect({ ...whatsappReferral }).toEqual(inputSnapshot.whatsappReferral);
    expect({ ...metaReferral }).toEqual(inputSnapshot.metaReferral);
  });

  it("matches Contains against an ad headline when the customer message has no keyword", () => {
    expect(
      matches(
        {
          messageMatchMode: "contains",
          keywordMatchMode: "contains",
          keywordPattern: "Ортеке",
        },
        {
          messageText: "Привет! Можно узнать об этом подробнее?",
          whatsappReferral: {
            sourceType: "ad",
            headline: "Ортеке - домбырашыны ЕРЕКШЕЛЕЙТІН аспап!",
          },
        }
      )
    ).toBe(true);
  });

  it("matches Contains against an ad campaign title", () => {
    expect(
      matches(
        {
          messageMatchMode: "contains",
          keywordMatchMode: "contains",
          keywordPattern: "orteke",
        },
        {
          messageText: "hello",
          whatsappReferral: {
            sourceType: "ad",
            campaignName: "Orteke CTWA launch",
          },
        }
      )
    ).toBe(true);
  });

  it("does not use ad copy body as a keyword haystack", () => {
    expect(
      matches(
        {
          messageMatchMode: "contains",
          keywordMatchMode: "contains",
          keywordPattern: "Ортеке",
        },
        {
          messageText: "hello",
          whatsappReferral: {
            sourceType: "ad",
            body: "Ортеке — напарник, который оживает под музыку.",
          },
        }
      )
    ).toBe(false);
  });

  it("does not match title or headline unless the referral is an ad", () => {
    expect(
      matches(
        {
          messageMatchMode: "contains",
          keywordMatchMode: "contains",
          keywordPattern: "Ортеке",
        },
        {
          messageText: "hello",
          whatsappReferral: {
            sourceType: "post",
            headline: "Ортеке - домбырашыны ЕРЕКШЕЛЕЙТІН аспап!",
            campaignName: "Ортеке",
          },
        }
      )
    ).toBe(false);
  });

  it("matches Exact and regex against ad headline text", () => {
    expect(
      matches(
        {
          messageMatchMode: "exact",
          keywordPattern: "Ортеке",
        },
        {
          messageText: "hello",
          whatsappReferral: {
            sourceType: "ad",
            headline: "Ортеке",
          },
        }
      )
    ).toBe(true);
    expect(
      matches(
        {
          messageMatchMode: "contains",
          keywordMatchMode: "regex",
          keywordPattern: "ортеке.+аспап",
        },
        {
          messageText: "",
          whatsappReferral: {
            sourceType: "ad",
            headline: "Ортеке - домбырашыны ЕРЕКШЕЛЕЙТІН аспап!",
          },
        }
      )
    ).toBe(true);
  });

  it("matches a campaign name fallback without reading the message or headline", () => {
    const config: ScenarioTriggerConfig = {
      messageMatchMode: "any",
      metaCampaignAdAccountId: "act_42",
      metaCampaignNameFallbacks: ["Product A"],
    };
    expect(
      matches(config, {
        messageText: "Product A",
        whatsappReferral: {
          sourceType: "ad",
          sourceId: "ad-1",
          headline: "Product A",
          campaignName: "Other campaign",
          adAccountId: "act_42",
          campaignLabelStatus: "absent",
        },
      })
    ).toBe(false);
    expect(
      matches(config, {
        messageText: "hello",
        whatsappReferral: {
          sourceType: "ad",
          sourceId: "ad-1",
          headline: "hello",
          campaignName: "product a launch",
          adAccountId: "act_42",
          campaignLabelStatus: "absent",
        },
      })
    ).toBe(true);
    expect(
      matches(config, {
        messageText: "hello",
        metaReferral: {
          sourceType: "ad",
          sourceId: "ad-1",
          headline: "Product A",
          productCampaignName: "Product A launch",
          adAccountId: "act_42",
          campaignLabelStatus: "absent",
        },
      })
    ).toBe(true);
    expect(
      matches(
        {
          messageMatchMode: "contains",
          keywordMatchMode: "contains",
          keywordPattern: "Product A",
        },
        {
          messageText: "hello",
          metaReferral: {
            sourceType: "ad",
            sourceId: "ad-1",
            headline: "unrelated",
            productCampaignName: "Product A launch",
          },
        }
      )
    ).toBe(false);
  });

  it("blocks name fallback when campaign labels are unavailable", () => {
    const config: ScenarioTriggerConfig = {
      messageMatchMode: "any",
      metaCampaignNameFallbacks: ["Product A"],
    };
    expect(
      matches(config, {
        whatsappReferral: {
          sourceType: "ad",
          sourceId: "ad-1",
          campaignName: "Product A",
          campaignLabelStatus: "unavailable",
        },
      })
    ).toBe(false);
    expect(
      matches(config, {
        whatsappReferral: {
          sourceType: "ad",
          sourceId: "ad-1",
          campaignName: "Product A",
          campaignLabelStatus: "absent",
        },
      })
    ).toBe(true);
  });

  it("matches Contains against a Meta ad headline", () => {
    expect(
      matches(
        {
          messageMatchMode: "contains",
          keywordMatchMode: "contains",
          keywordPattern: "Ортеке",
        },
        {
          messageText: "hi",
          metaReferral: {
            sourceType: "ad",
            headline: "Ортеке — күймен бірге билейтін серік",
          },
        }
      )
    ).toBe(true);
  });
});

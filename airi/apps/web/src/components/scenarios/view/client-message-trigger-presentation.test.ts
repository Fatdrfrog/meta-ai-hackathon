import fs from "fs";
import path from "path";
import { projectActiveClientMessageFilters } from "@/lib/scenarios/client-message-trigger-criteria";
import type {
  ScenarioBuilderSummary,
  ScenarioSummary,
  ScenarioTriggerConfig,
  TranslateFn,
} from "../types";
import { buildClientMessageTriggerPresentation } from "./client-message-trigger-presentation";
import {
  buildScenarioSummaryChips,
  buildScenarioTriggerSummaryChips,
} from "./scenario-builder-summary-labels";

const t: TranslateFn = (key, values) => {
  if (!values) return key;
  const serializedValues = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(",");
  return `${key}(${serializedValues})`;
};

function present(config: ScenarioTriggerConfig) {
  return buildClientMessageTriggerPresentation(
    projectActiveClientMessageFilters(config),
    t
  );
}

function scenarioWithTriggers(
  triggerConfigs: ScenarioTriggerConfig[],
  primaryActionType?: ScenarioBuilderSummary["primaryActionType"]
): ScenarioSummary {
  return {
    _id: "scenario-1",
    name: "Welcome",
    description: "",
    status: "draft",
    mode: "conversation",
    timezone: null,
    priority: 0,
    presetId: null,
    presetVersion: null,
    segmentKey: null,
    matchingRole: "default",
    entryPolicy: "once_per_conversation",
    linkedParentScenarioIds: [],
    nodeCount: triggerConfigs.length,
    edgeCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    builderSummary: {
      triggers: triggerConfigs.map((triggerConfig, index) => ({
        triggerNodeId: `trigger-${index + 1}`,
        triggerConfig,
        label: null,
      })),
      primaryActionType,
    },
  };
}

describe("buildClientMessageTriggerPresentation", () => {
  it("hides dormant matcher fields when Any is selected", () => {
    const presentation = present({
      messageMatchMode: "any",
      keywordPattern: "refund",
      keywordMatchMode: "regex",
    });

    expect(presentation.summaryChips).toEqual(["triggerMatchAny"]);
    expect(presentation.linkedSummary).toBe("scenarioLinkTriggerIncoming");
    expect(JSON.stringify(presentation)).not.toContain("refund");
  });

  it.each([
    {
      name: "Exact",
      config: {
        messageMatchMode: "exact",
        keywordPattern: "  refund request  ",
        keywordMatchMode: "regex",
      } satisfies ScenarioTriggerConfig,
      summary: "scenarioLinkTriggerExactText(text=refund request)",
      linked: "scenarioLinkTriggerExactText(text=refund request)",
    },
    {
      name: "literal Contains",
      config: {
        messageMatchMode: "contains",
        keywordPattern: "refund, cancel",
        keywordMatchMode: "contains",
      } satisfies ScenarioTriggerConfig,
      summary: "scenarioLinkContains(text=refund, cancel)",
      linked: "scenarioLinkTriggerContains(text=refund, cancel)",
    },
    {
      name: "regex Contains",
      config: {
        messageMatchMode: "contains",
        keywordPattern: "refund\\s+request",
        keywordMatchMode: "regex",
      } satisfies ScenarioTriggerConfig,
      summary: "scenarioLinkContains(text=refund\\s+request)",
      linked: "scenarioLinkTriggerContains(text=refund\\s+request)",
    },
  ])("localizes a valid $name matcher", ({ config, summary, linked }) => {
    const presentation = present(config);

    expect(presentation.summaryChips[0]).toBe(summary);
    expect(presentation.linkedSummary).toBe(linked);
  });

  it.each([
    {
      name: "missing Exact pattern",
      config: { messageMatchMode: "exact" } satisfies ScenarioTriggerConfig,
      summary: "triggerMatchExact",
      linked: "scenarioLinkTriggerExactTextDefault",
    },
    {
      name: "delimiter-only literal Contains",
      config: {
        messageMatchMode: "contains",
        keywordPattern: ", ;\r\n",
        keywordMatchMode: "contains",
      } satisfies ScenarioTriggerConfig,
      summary: "triggerMatchContains",
      linked: "scenarioLinkTriggerContainsDefault",
    },
    {
      name: "invalid regex Contains",
      config: {
        messageMatchMode: "contains",
        keywordPattern: "[",
        keywordMatchMode: "regex",
      } satisfies ScenarioTriggerConfig,
      summary: "triggerMatchContains",
      linked: "scenarioLinkTriggerContainsDefault",
    },
  ])(
    "keeps a malformed $name visible as its selected mode without displaying invalid source",
    ({ config, summary, linked }) => {
      const presentation = present(config);

      expect(presentation.summaryChips).toEqual([summary]);
      expect(presentation.linkedSummary).toBe(linked);
    }
  );

  it("localizes every active global-filter chip", () => {
    const config: ScenarioTriggerConfig = {
      messageMatchMode: "any",
      channelFilter: ["whatsapp", "web_widget"],
      onlyNewCustomers: true,
      whatsappReferralSourcePlatforms: ["instagram"],
      whatsappReferralSourceTypes: ["ad"],
      metaReferralSourceIds: ["ad-1"],
      metaReferralCampaignIds: ["campaign-1"],
      metaReferralAdSetIds: ["ad-set-1"],
      metaCampaignAdAccountId: "act_1",
      metaCampaignLabels: [{ id: "label-1", name: "Product B" }],
      metaCampaignNameFallbacks: ["spring"],
    };

    expect(buildScenarioTriggerSummaryChips(config, t)).toEqual([
      "triggerMatchAny",
      "triggerOnlyNewCustomers",
      "actionSourceWhatsApp, triggerChannelWebChat",
      "actionSourceInstagram",
      "triggerSummaryWhatsAppReferralTypes(types=ad)",
      "triggerSummaryInstagramAd",
      "triggerSummaryMetaCampaign",
      "triggerSummaryMetaAdSet",
      "triggerSummaryCampaignLabels(labels=Product B)",
      "triggerSummaryCampaignNameFallback(names=spring)",
    ]);
  });

  it("provides named filter details without losing unavailable or multiple saved references", () => {
    const presentation = buildClientMessageTriggerPresentation(
      projectActiveClientMessageFilters({
        metaReferralCampaignIds: ["campaign-1", "saved-missing"],
        metaReferralAdSetIds: ["set-1"],
        metaReferralSourceIds: ["ad-1"],
        metaCampaignAdAccountId: "act_1",
        metaCampaignLabels: [{ id: "label-1", name: "Electronics" }],
        onlyNewCustomers: true,
      }),
      t,
      {
        metaReferralCampaigns: [
          { id: "campaign-1", campaignId: "campaign-1", label: "Forte Market" },
        ],
        metaReferralAdSets: [
          { id: "set-1", adSetId: "set-1", label: "Almaty" },
        ],
        metaReferralAds: [{ id: "ad-1", sourceId: "ad-1", label: "New phone" }],
      }
    );
    expect(presentation.summaryItems).toEqual(
      expect.arrayContaining([
        {
          kind: "campaign",
          text: "triggerSummaryMetaCampaignNamed(name=Forte Market, saved-missing)",
        },
        { kind: "ad-set", text: "triggerSummaryMetaAdSetNamed(name=Almaty)" },
        { kind: "ad", text: "triggerSummaryMetaAdNamed(name=New phone)" },
        {
          kind: "labels",
          text: "triggerSummaryCampaignLabels(labels=Electronics)",
        },
        { kind: "customers", text: "triggerOnlyNewCustomers" },
      ])
    );
  });

  it("localizes the multi-trigger count", () => {
    expect(
      buildScenarioSummaryChips(
        scenarioWithTriggers([
          { messageMatchMode: "any" },
          { messageMatchMode: "exact", keywordPattern: "refund" },
        ]),
        t
      )
    ).toEqual(["scenarioTriggerCount(count=2)", "triggerMatchAny"]);
  });

  it("does not claim a WhatsApp QR trigger needs a code without its readiness", () => {
    const qrTrigger: ScenarioTriggerConfig = {
      entryPointType: "whatsapp_qr",
      entryPointId: "p1",
    };

    expect(buildScenarioTriggerSummaryChips(qrTrigger, t)).toEqual([
      "presetTriggerWhatsAppQr",
    ]);
    expect(
      buildScenarioSummaryChips(scenarioWithTriggers([qrTrigger], "reply"), t)
    ).toEqual(["presetTriggerWhatsAppQr", "presetActionReply"]);
  });

  it("uses a real ellipsis when truncating a linked matcher summary", () => {
    const presentation = present({
      messageMatchMode: "contains",
      keywordMatchMode: "contains",
      keywordPattern: "12345678901234567890123456789012345",
    });

    expect(presentation.linkedSummary).toBe(
      "scenarioLinkTriggerContains(text=123456789012345678901234567890…)"
    );
    // "…" misread as Windows-1251, built from code points so this source file stays clean.
    expect(presentation.linkedSummary).not.toContain(
      String.fromCharCode(0x0432, 0x0402, 0x00a6)
    );
  });
});

describe("client-message trigger presentation catalogs", () => {
  const localeRoot = path.resolve(__dirname, "../../../../messages/scenarios");
  const requiredTokens = {
    scenarioTriggerCount: "{count",
    triggerSummaryWhatsAppReferralTypes: "{types}",
    triggerSummaryInstagramAd: null,
    triggerSummaryMetaCampaign: null,
    triggerSummaryMetaAdSet: null,
    triggerSummaryCampaignLabels: "{labels}",
    triggerSummaryCampaignNameFallback: "{names}",
  } as const;

  it.each(["en", "kz", "ru"])(
    "defines aligned presentation copy for %s",
    locale => {
      const messages = JSON.parse(
        fs.readFileSync(path.join(localeRoot, locale, "page.json"), "utf8")
      ) as {
        Scenarios?: Record<string, unknown>;
      };

      for (const [key, token] of Object.entries(requiredTokens)) {
        const value = messages.Scenarios?.[key];
        expect(typeof value).toBe("string");
        expect(String(value).trim()).not.toBe("");
        if (token) {
          expect(String(value)).toContain(token);
        }
      }
    }
  );
});

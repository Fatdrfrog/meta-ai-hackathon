import type { ScenarioTriggerConfig } from "@/components/scenarios/types";
import {
  metaReferralSelectionToConfigDelta,
  metaReferralSelectionToSelectValue,
  resolveMetaReferralSelection,
  selectValueToMetaReferralSelection,
  type MetaReferralSelection,
} from "./meta-referral-selection";

describe("Meta referral selection", () => {
  const selections: MetaReferralSelection[] = [
    { kind: "any_message" },
    { kind: "any_instagram_ad" },
    { kind: "campaign", id: "campaign:one" },
    { kind: "ad_set", id: "ad set/one" },
    { kind: "ad", id: "ad?one" },
  ];

  it.each(selections)(
    "round-trips $kind through the Select value",
    selection => {
      expect(
        selectValueToMetaReferralSelection(
          metaReferralSelectionToSelectValue(selection)
        )
      ).toEqual(selection);
    }
  );

  it.each([
    "",
    "campaign:",
    "ad_set:",
    "ad:",
    "unknown:value",
    "campaign:%E0%A4%A",
  ])("rejects malformed Select value %p", value => {
    expect(selectValueToMetaReferralSelection(value)).toBeNull();
  });

  it("uses campaign, ad set, ad, legacy Instagram, then any precedence", () => {
    const competing: ScenarioTriggerConfig = {
      metaReferralCampaignIds: ["campaign-1"],
      metaReferralAdSetIds: ["adset-1"],
      metaReferralSourceIds: ["ad-1"],
      whatsappReferralSourceTypes: ["ad"],
      whatsappReferralSourcePlatforms: ["instagram"],
    };

    expect(resolveMetaReferralSelection(competing)).toEqual({
      kind: "campaign",
      id: "campaign-1",
    });
    expect(
      resolveMetaReferralSelection({
        ...competing,
        metaReferralCampaignIds: [],
      })
    ).toEqual({ kind: "ad_set", id: "adset-1" });
    expect(
      resolveMetaReferralSelection({
        ...competing,
        metaReferralCampaignIds: [],
        metaReferralAdSetIds: [],
      })
    ).toEqual({ kind: "ad", id: "ad-1" });
    expect(
      resolveMetaReferralSelection({
        whatsappReferralSourceTypes: ["ad"],
        whatsappReferralSourcePlatforms: ["instagram"],
      })
    ).toEqual({ kind: "any_instagram_ad" });
    expect(resolveMetaReferralSelection({})).toEqual({
      kind: "any_message",
    });
  });

  it("emits mutually exclusive raw config deltas and never Select sentinels", () => {
    expect(
      metaReferralSelectionToConfigDelta({
        kind: "ad_set",
        id: "persisted-ad-set",
      })
    ).toEqual({
      metaReferralCampaignIds: [],
      metaReferralAdSetIds: ["persisted-ad-set"],
      metaReferralSourceIds: [],
      whatsappReferralSourceTypes: [],
      whatsappReferralSourcePlatforms: [],
    });

    expect(
      JSON.stringify(
        metaReferralSelectionToConfigDelta({ kind: "any_instagram_ad" })
      )
    ).not.toContain("any_instagram_ad");
  });

  it("clears every modern and legacy field for any message", () => {
    expect(metaReferralSelectionToConfigDelta({ kind: "any_message" })).toEqual(
      {
        metaReferralCampaignIds: [],
        metaReferralAdSetIds: [],
        metaReferralSourceIds: [],
        whatsappReferralSourceTypes: [],
        whatsappReferralSourcePlatforms: [],
      }
    );
  });
});

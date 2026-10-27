"use client";

import { useLocale, useTranslations } from "next-intl";
import { createLandingNumberFormatters } from "./landing-number-formatters";
import { LANDING_CAMPAIGN_RECIPIENTS } from "./landing-workflow-sample";
import s from "./landing-workflow-studio.module.css";

/** The same selected audience appears in the draft and its customer-side walkthrough. */
export function LandingCampaignAudience() {
  const t = useTranslations("LandingDemo.featureCards.previews.smartChat");
  const format = createLandingNumberFormatters(useLocale());
  return (
    <div className={s.campaignAudience} data-campaign-audience>
      <dl>
        <div>
          <dt>{t("audienceLabel")}</dt>
          <dd>{t("audience")}</dd>
        </div>
        <div className={s.campaignRecipientCount}>
          <dt>{t("recipients")}</dt>
          <dd>{format.integer(LANDING_CAMPAIGN_RECIPIENTS)}</dd>
        </div>
      </dl>
      <p>{t("eligibility")}</p>
    </div>
  );
}

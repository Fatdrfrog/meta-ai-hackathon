"use client";

import { Clock3, MessageSquare, Megaphone } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { formatDashboardDuration } from "@/components/dashboard/dashboard-localization";
import { createLandingNumberFormatters } from "./landing-number-formatters";
import {
  LANDING_AD_CONVERSATIONS,
  LANDING_CAMPAIGN_REPORT,
  LANDING_META_ADS_SAMPLE,
  LANDING_RESPONSE_SAMPLE,
} from "./landing-workflow-sample";
import s from "./landing-workflow-studio.module.css";
import { LandingMonthlyAnalytics } from "./landing-monthly-analytics";

/** Compact public excerpts of the existing advertising, bulk and team reports. */
export function LandingAnalyticsDetails() {
  const t = useTranslations("LandingDemo.revenueReport.details");
  const productT = useTranslations(
    "LandingDemo.featureCards.previews.products"
  );
  const durationT = useTranslations(
    "LandingDemo.revenueReport.details.response"
  );
  const locale = useLocale();
  const format = createLandingNumberFormatters(locale);
  const ads = LANDING_META_ADS_SAMPLE;
  const campaign = LANDING_CAMPAIGN_REPORT;
  const response = LANDING_RESPONSE_SAMPLE;
  const duration = (seconds: number) =>
    formatDashboardDuration(seconds, locale, durationT);

  return (
    <div className={s.analyticsDetails}>
      <section
        className={s.adsReport}
        aria-labelledby="landing-meta-report"
        data-analytics-detail="meta"
      >
        <header className={s.analyticsDetailHeading}>
          <div>
            <Megaphone size={17} aria-hidden />
            <h3 id="landing-meta-report">{t("ads.title")}</h3>
          </div>
          <span>{t("ads.source")}</span>
        </header>
        <p className={s.analyticsDetailIntro}>{t("ads.description")}</p>
        <dl className={s.adsTotals}>
          <div>
            <dt>{t("ads.spend")}</dt>
            <dd>{format.currency(ads.totalSpend, ads.currency)}</dd>
          </div>
          <div>
            <dt>{t("ads.results")}</dt>
            <dd>{format.integer(ads.totalResults)}</dd>
          </div>
          <div>
            <dt>{t("ads.cost")}</dt>
            <dd>{format.currency(ads.costPerResult, ads.currency)}</dd>
          </div>
        </dl>
        <table className={s.adsTable}>
          <caption>{t("ads.table")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("ads.ad")}</th>
              <th scope="col">{t("ads.results")}</th>
              <th scope="col">{t("ads.spend")}</th>
              <th scope="col">{t("ads.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {ads.topAds.map(ad => (
              <tr key={ad.adId}>
                <th scope="row">{productT(`${ad.adId}.name`)}</th>
                <td>
                  <span
                    className={s.adResultBar}
                    aria-hidden
                    style={{
                      width: `${(ad.results / ads.topAds[0].results) * 100}%`,
                    }}
                  />
                  <span>{format.integer(ad.results)}</span>
                </td>
                <td>{format.currency(ad.spend, ads.currency)}</td>
                <td>{format.currency(ad.costPerResult, ads.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={s.analyticsSourceNote}>
          <strong>
            {t("ads.captured", {
              count: format.integer(LANDING_AD_CONVERSATIONS),
            })}
          </strong>{" "}
          {t("ads.boundary")}
        </p>
      </section>

      <section
        className={s.campaignReport}
        aria-labelledby="landing-campaign-report"
        data-analytics-detail="campaign"
      >
        <header className={s.analyticsDetailHeading}>
          <div>
            <MessageSquare size={17} aria-hidden />
            <h3 id="landing-campaign-report">{t("campaign.title")}</h3>
          </div>
          <span>{t("campaign.source")}</span>
        </header>
        <p className={s.analyticsDetailIntro}>
          {t("campaign.description", {
            count: format.integer(campaign.totalAccepted),
          })}
        </p>
        <dl className={s.campaignBars}>
          {(["totalAccepted", "delivered", "read", "replied"] as const).map(
            key => (
              <div key={key}>
                <dt>{t(`campaign.${key}`)}</dt>
                <dd>
                  <i
                    aria-hidden
                    style={{
                      width: `${(campaign[key] / campaign.totalAccepted) * 100}%`,
                    }}
                  />
                  <span>{format.integer(campaign[key])}</span>
                </dd>
              </div>
            )
          )}
        </dl>
        <p className={s.analyticsSourceNote}>
          {t("campaign.replyRate", {
            rate: format.percent(
              (campaign.replied / campaign.totalAccepted) * 100,
              0
            ),
          })}{" "}
          ·{" "}
          {t("campaign.cost", {
            value: format.currency(campaign.costPerReply, "USD"),
          })}
        </p>
      </section>

      <section
        className={s.responseReport}
        aria-labelledby="landing-response-report"
        data-analytics-detail="response"
      >
        <header className={s.analyticsDetailHeading}>
          <div>
            <Clock3 size={17} aria-hidden />
            <h3 id="landing-response-report">{t("response.title")}</h3>
          </div>
          <span>{t("response.source")}</span>
        </header>
        <p className={s.analyticsDetailIntro}>{t("response.description")}</p>
        <dl className={s.responseMetrics}>
          <div>
            <dt>{t("response.median")}</dt>
            <dd>{duration(response.medianSeconds)}</dd>
          </div>
          <div>
            <dt>{t("response.p90")}</dt>
            <dd>{duration(response.p90Seconds)}</dd>
          </div>
        </dl>
        <p className={s.analyticsSourceNote}>
          {t("response.scope", { count: format.integer(response.count) })}
        </p>
      </section>
      <LandingMonthlyAnalytics />
      <p className={s.analyticsDemoNote}>{t("demoNote")}</p>
    </div>
  );
}

"use client";

import {
  ArrowRight,
  Check,
  CheckCheck,
  Clock3,
  FileText,
  Instagram,
  MessageCircle,
  ShoppingBag,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { DEFAULT_LOCALE, isLocale } from "@/i18n/locales";
import { getPublicTemplatePath } from "@/lib/landing/public-template-seo";
import {
  Bubble,
  ProductImage,
  WhatsAppConversation,
} from "./hero-feature-card-previews";
import Image from "next/image";
import Link from "next/link";
import { LandingCampaignAudience } from "./landing-campaign-audience";
import { LandingTemplateCta } from "./landing-template-cta";
import { WhatsAppFormattedMessage } from "./template-preview";
import { getPublicTemplate } from "@/lib/landing/public-template-catalog";
import s from "./landing-workflow-studio.module.css";

export function BulkCampaignsSection() {
  const locale = useLocale();
  const t = useTranslations("LandingDemo.revenueWorkflows");
  const templates = useTranslations("LandingDemo.templates");
  const cards = useTranslations("LandingDemo.featureCards");
  const common = useTranslations("LandingDemo.featureCards.previews.common");
  const products = useTranslations(
    "LandingDemo.featureCards.previews.products"
  );
  return (
    <section
      id="bulk-campaigns"
      aria-labelledby="landing-workflow-title"
      className={s.editorialSection}
    >
      <div className={s.sectionInner}>
        <div className={s.growthHeading}>
          <div className={s.sectionHeading}>
            <h2 id="landing-workflow-title">{t("title")}</h2>
          </div>
          <Link
            href={getPublicTemplatePath(
              isLocale(locale) ? locale : DEFAULT_LOCALE
            )}
            className="inline-flex min-h-11 items-center gap-2 text-sm font-medium underline underline-offset-4"
          >
            {templates("browseAll")}
            <ArrowRight size={16} aria-hidden />
          </Link>
        </div>
        <div id="fit" className={s.growthGrid}>
          <article
            className={s.growthCampaign}
            aria-labelledby="growth-campaign-title"
            data-revenue-workflow="campaign"
          >
            <div className={s.growthCardHeading}>
              <span className={s.growthIndex}>01</span>
              <span className={s.growthLabel}>{t("campaign.label")}</span>
              <h3 id="growth-campaign-title">{t("campaign.title")}</h3>
              <LandingTemplateCta templateId="seasonal-offer" />
            </div>
            <div className={s.growthStage}>
              <LandingCampaignAudience />
              <div className={s.campaignMessage}>
                <ProductImage
                  src={getPublicTemplate("seasonal-offer")?.imagePath}
                  alt={t("campaign.title")}
                  image="vase"
                  className={s.campaignMessagePhoto}
                />
                <div>
                  <span>
                    <MessageCircle size={13} aria-hidden />
                    {common("shop")} · WhatsApp
                  </span>
                  <p>
                    <WhatsAppFormattedMessage text={t("campaign.message")} />
                  </p>
                  <small>
                    {t("campaign.template")}
                    <Check size={13} aria-hidden />
                  </small>
                </div>
              </div>
            </div>
          </article>
          <article
            className={s.growthConsultation}
            aria-labelledby="growth-consultation-title"
            data-revenue-workflow="consultation"
          >
            <div className={s.growthCardHeading}>
              <span className={s.growthIndex}>02</span>
              <span className={s.growthLabel}>{t("consultation.label")}</span>
              <h3 id="growth-consultation-title">{t("consultation.title")}</h3>
            </div>
            <div className={s.growthStage}>
              <div className={s.adReferralStrip}>
                <ProductImage image="story" className={s.referralPhoto} />
                <span>
                  <Instagram size={14} aria-hidden />
                  {t("consultation.source")}
                  <strong>{products("basket.name")}</strong>
                </span>
              </div>
              <div className={s.salesConversation}>
                <p>{t("consultation.question")}</p>
                <div>
                  <p>{t("consultation.answer")}</p>
                  <span>
                    <FileText size={12} aria-hidden />
                    {t("consultation.sourceNote")}
                  </span>
                </div>
                <p className={s.purchaseReply}>
                  {t("consultation.reply")}
                  <CheckCheck size={14} aria-hidden />
                </p>
              </div>
            </div>
          </article>
          <article
            className={s.growthRecovery}
            aria-labelledby="growth-recovery-title"
            data-revenue-workflow="recovery"
          >
            <div className={s.growthCardHeading}>
              <span className={s.growthIndex}>03</span>
              <span className={s.growthLabel}>{t("recovery.label")}</span>
              <h3 id="growth-recovery-title">{t("recovery.title")}</h3>
              <LandingTemplateCta templateId="abandoned-cart" />
            </div>
            <div className={s.growthStage}>
              <ol className={s.recoveryTimeline}>
                <li>
                  <span className={s.timelineIcon}>
                    <ShoppingBag size={16} aria-hidden />
                  </span>
                  <div>
                    <strong>{t("recovery.pending")}</strong>
                    <span>
                      {products("mirror.name")} · {products("mirror.price")}
                    </span>
                  </div>
                </li>
                <li>
                  <span className={s.timelineIcon}>
                    <Clock3 size={16} aria-hidden />
                  </span>
                  <div>
                    <strong>{t("recovery.wait")}</strong>
                    <p className={s.recoveryMessage}>
                      <WhatsAppFormattedMessage text={t("recovery.message")} />
                    </p>
                  </div>
                </li>
                <li>
                  <span className={s.timelineComplete}>
                    <Check size={16} aria-hidden />
                  </span>
                  <div>
                    <strong>{t("recovery.confirmed")}</strong>
                    <span>{t("recovery.stop")}</span>
                  </div>
                  <span className={s.recoveredValue}>
                    {products("mirror.price")}
                  </span>
                </li>
              </ol>
            </div>
          </article>
          <article
            className={s.growthRepeat}
            aria-labelledby="growth-repeat-title"
            data-revenue-workflow="repeat"
          >
            <div className={s.growthCardHeading}>
              <span className={s.growthIndex}>04</span>
              <span className={s.growthLabel}>{t("repeat.label")}</span>
              <h3 id="growth-repeat-title">{t("repeat.title")}</h3>
              <LandingTemplateCta templateId="repeat-purchase" />
            </div>
            <div className={s.growthStage}>
              <div className={s.repeatHistory}>
                <ProductImage image="textile" className={s.referralPhoto} />
                <div>
                  <span>{t("repeat.previous")}</span>
                  <strong>{products("textile.name")}</strong>
                </div>
                <ArrowRight size={17} aria-hidden />
              </div>
              <div className={s.repeatOffer}>
                <ProductImage
                  src={getPublicTemplate("repeat-purchase")?.imagePath}
                  alt={t("repeat.title")}
                  image="story"
                  className={s.repeatPhoto}
                />
                <p>
                  <WhatsAppFormattedMessage text={t("repeat.message")} />
                </p>
                <span>{t("repeat.audience")}</span>
              </div>
            </div>
          </article>
          <article
            className={s.qrWorkflow}
            aria-labelledby="growth-qr-title"
            data-revenue-workflow="qr"
          >
            <div className={s.qrIntroduction}>
              <div className={s.growthCardHeading}>
                <span className={s.growthIndex}>05</span>
                <span className={s.growthLabel}>{t("qr.label")}</span>
                <h3 id="growth-qr-title">{t("qr.title")}</h3>
              </div>
              <p>{t("qr.description")}</p>
              <div className={s.qrPlacement}>
                <ProductImage image="vase" className={s.qrProductPhoto} />
                <div className={s.qrPlacard}>
                  <span>Forma Home</span>
                  <strong>{t("qr.sign")}</strong>
                  <a href="#qr-conversation" aria-label={t("qr.open")}>
                    <Image
                      src="/landing/whatsapp-demo-qr.svg"
                      alt={t("qr.alt")}
                      width={116}
                      height={116}
                      unoptimized
                    />
                  </a>
                  <span>WhatsApp</span>
                </div>
              </div>
              <small>{t("qr.demoNote")}</small>
            </div>
            <div className={s.qrDestination} id="qr-conversation" tabIndex={-1}>
              <div className={s.qrSource}>
                <span>{t("qr.source")}</span>
                <span>{t("qr.sourceNote")}</span>
              </div>
              <WhatsAppConversation className={s.qrChat}>
                <Bubble outgoing time="12:41">
                  {t("qr.question")}
                </Bubble>
                <Bubble time="12:41">{t("qr.answer")}</Bubble>
                <Bubble outgoing time="12:42">
                  {t("qr.reply")}
                </Bubble>
              </WhatsAppConversation>
            </div>
          </article>
        </div>
        <p className={s.growthFooter}>
          {common("shop")} · {cards("reviewNote")}
        </p>
      </div>
    </section>
  );
}

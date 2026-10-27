"use client";

import { Button } from "@/components/ui/button";
import {
  getLandingPrimaryAction,
  type LandingHeaderViewer,
} from "@/lib/landing/landing-header-viewer";
import { ArrowRight, CheckCheck, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { BulkCampaignsSection } from "./bulk-campaigns-section";
import { LandingFooter } from "./landing-footer";
import { LandingRevenuePreview } from "./landing-revenue-preview";
import { SentAccent } from "./landing-sent-accent";
import s from "./landing-workflow-studio.module.css";

const FAQ_KEYS = ["start", "number", "ai", "cost", "crm"] as const;

export function LandingBelowFold({ viewer }: { viewer?: LandingHeaderViewer }) {
  const t = useTranslations("LandingDemo");
  const pageT = useTranslations("LandingPage");
  const primaryAction = getLandingPrimaryAction(viewer);
  const primaryActionLabel =
    primaryAction.label === "openWorkspace"
      ? pageT("header.openWorkspace")
      : primaryAction.label === "signIn"
        ? t("header.signIn")
        : t("hero.startFree");

  return (
    <>
      <BulkCampaignsSection />
      <section
        id="results"
        aria-labelledby="landing-results-title"
        className={s.revenueSection}
      >
        <div className={s.sectionInner}>
          <div className={s.sectionHeading}>
            <h2 id="landing-results-title">{t("revenueReport.title")}</h2>
            <p className={s.sectionIntro}>{t("revenueReport.description")}</p>
          </div>
          <LandingRevenuePreview interactive={false} variant="report" />
        </div>
      </section>
      <section
        id="faq"
        aria-labelledby="landing-faq-title"
        className={s.editorialSection}
      >
        <div className={[s.sectionInner, s.faqLayout].join(" ")}>
          <div className={s.sectionHeading}>
            <h2 id="landing-faq-title">{t("faq.title")}</h2>
            <p className={s.sectionIntro}>{t("faq.description")}</p>
          </div>
          <div className={s.faqList}>
            {FAQ_KEYS.map(key => (
              <details key={key} name="landing-faq" open={key === "start"}>
                <summary>
                  <span>{t("faq.items." + key + ".question")}</span>
                  <CheckCheck className={s.faqTicks} size={16} aria-hidden />
                  <Plus size={20} aria-hidden />
                </summary>
                <p>{t("faq.items." + key + ".answer")}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
      <section aria-labelledby="landing-start-title" className={s.finalCta}>
        <div className={s.sectionInner}>
          <h2 id="landing-start-title">
            {t("cta.title")}{" "}
            <em>
              <SentAccent text={t("cta.titleAccent")} />
            </em>
          </h2>
          <p>{t("cta.pricing")}</p>
          <div className={s.finalActions}>
            <Button asChild variant="secondary" className={s.primaryAction}>
              <Link href={primaryAction.href}>
                {primaryActionLabel}
                <ArrowRight size={17} aria-hidden />
              </Link>
            </Button>
          </div>
        </div>
      </section>
      <LandingFooter />
    </>
  );
}

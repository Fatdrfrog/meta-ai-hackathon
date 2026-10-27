"use client";

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  getLandingPrimaryAction,
  type LandingHeaderViewer,
} from "@/lib/landing/landing-header-viewer";
import { useTranslations } from "next-intl";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { HeroDemoCta } from "./hero-demo-cta";
import { HeroFeatureCards } from "./hero-feature-cards";
import { LandingBelowFold } from "./landing-below-fold";
import { SentAccent } from "./landing-sent-accent";
import { LandingPageHeader } from "./page-header";
import { SourcesSection } from "./sources-section";
import s from "./landing-workflow-studio.module.css";

type InteractiveDemoLandingProps = {
  viewer?: LandingHeaderViewer;
};

export function InteractiveDemoLanding({
  viewer,
}: InteractiveDemoLandingProps = {}) {
  const t = useTranslations("LandingDemo");
  const landingPageT = useTranslations("LandingPage");
  const primaryAction = getLandingPrimaryAction(viewer);
  const primaryActionLabel =
    primaryAction.label === "openWorkspace"
      ? landingPageT("header.openWorkspace")
      : primaryAction.label === "signIn"
        ? t("header.signIn")
        : t("hero.startFree");
  const showMarketingCtas = !viewer?.isAuthenticated;
  const consentSlotRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // External portals must wait until this streamed subtree has hydrated.
    const slot = consentSlotRef.current;
    slot?.setAttribute("data-landing-consent-ready", "true");
    return () => slot?.removeAttribute("data-landing-consent-ready");
  }, []);

  return (
    <div className={s.root}>
      <div>
        <LandingPageHeader viewer={viewer} />
        <div id="landing-consent-slot" ref={consentSlotRef} />
        <section className={s.hero}>
          <div className={s.heroGrid}>
            <div className={s.heroCopy}>
              <h1 className={s.heading}>
                {t("hero.title")}{" "}
                <span className={s.headingAccent}>
                  <SentAccent text={t("hero.titleAccent")} />
                </span>
              </h1>
              <p className={s.intro}>{t("hero.subtitle")}</p>
              <Collapsible>
                <div className={s.heroActions}>
                  <Button
                    asChild
                    size="lg"
                    variant="secondary"
                    className={s.primaryAction}
                  >
                    <Link href={primaryAction.href}>{primaryActionLabel}</Link>
                  </Button>
                  {showMarketingCtas && (
                    <CollapsibleTrigger className={s.textButton}>
                      {t("hero.bookDemo")}
                      <ArrowRight size={17} aria-hidden />
                    </CollapsibleTrigger>
                  )}
                </div>
                {showMarketingCtas && (
                  <CollapsibleContent className={s.demoForm}>
                    <HeroDemoCta focusOnMount />
                  </CollapsibleContent>
                )}
              </Collapsible>
            </div>

            <div className="min-w-0">
              <HeroFeatureCards />
            </div>
          </div>
        </section>

        <SourcesSection />

        <LandingBelowFold viewer={viewer} />
      </div>
    </div>
  );
}

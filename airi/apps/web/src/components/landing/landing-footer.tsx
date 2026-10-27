"use client";

import { MARKETING_PAGES } from "@/lib/landing/marketing-pages";
import { useTranslations } from "next-intl";
import Image from "next/image";
import Link from "next/link";
import s from "./landing-workflow-studio.module.css";

const PRODUCT_LINKS = [
  ["delivery", MARKETING_PAGES.delivery],
  ["metaAds", MARKETING_PAGES.metaAds],
  ["mcp", MARKETING_PAGES.mcp],
  ["templates", "/whatsapp-templates"],
] as const;

const LEGAL_LINKS = [
  ["ourTeam", "/about"],
  ["terms", "/terms"],
  ["refunds", "/refunds"],
  ["privacy", "/privacy"],
  ["security", "/security"],
] as const;

export function LandingFooter() {
  const t = useTranslations("LandingDemo.footer");

  return (
    <footer role="contentinfo" className={s.footer}>
      <div className={s.sectionInner}>
        <div className={s.footerTop}>
          <div>
            <div className={s.footerBrand}>
              <Image
                src="/logo_short_white.svg"
                alt=""
                width={120}
                height={30}
                className={s.footerLogo}
              />
              <span>airi.chat</span>
            </div>
            <p>{t("tagline")}</p>
          </div>
          <div className={s.footerNavs}>
            <nav aria-label={t("productNavigation")}>
              {PRODUCT_LINKS.map(([key, href]) => (
                <Link key={key} href={href}>
                  {t(key)}
                </Link>
              ))}
            </nav>
            <nav aria-label={t("navigation")}>
              {LEGAL_LINKS.map(([key, href]) => (
                <Link key={key} href={href}>
                  {t(key)}
                </Link>
              ))}
            </nav>
          </div>
        </div>
        <div className={s.footerBottom}>
          <p>{t("rights")}</p>
          <p>Turan 57G, Astana, Kazakhstan</p>
        </div>
      </div>
      <div className={s.footerWordmark} aria-hidden>
        airi<span>.</span>chat
      </div>
    </footer>
  );
}

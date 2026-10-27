import { LandingPageHeader } from "@/components/landing/page-header";
import {
  getLocaleFromCookie,
  loadRefundPolicyMessages,
} from "@/i18n/message-loader";
import { PUBLIC_SUPPORT_EMAIL } from "@/lib/airi-product-context";
import { getLandingHeaderViewerForRequest } from "@/lib/landing/landing-header-viewer.server";
import { createMetadata } from "@/lib/seo";
import type { Metadata } from "next";
import { createTranslator } from "next-intl";
import Link from "next/link";
import type { ReactNode } from "react";
import type enRefundMessages from "../../../messages/legal/refunds/en/page.json";

const LAST_UPDATED = "2026-06-26";

type RefundPolicyMessages = typeof enRefundMessages;

async function getRefundPolicyTranslator() {
  const locale = await getLocaleFromCookie();
  // All three checked-in refund catalogs share the en key shape (tested).
  const messages = (await loadRefundPolicyMessages(
    locale
  )) as RefundPolicyMessages;

  return createTranslator({
    locale,
    messages,
    namespace: "RefundPolicyPage",
  });
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getRefundPolicyTranslator();

  return createMetadata({
    title: t("metadata.title"),
    description: t("metadata.description"),
    path: "/refunds",
    keywords: [
      "airi refund policy",
      "saas refund policy",
      "subscription proration",
      "unused subscription days refund",
    ],
  });
}

const supportEmailLink = (chunks: ReactNode) => (
  <a className="underline" href={`mailto:${PUBLIC_SUPPORT_EMAIL}`}>
    {chunks}
  </a>
);

export default async function RefundPolicyPage() {
  const [viewer, t] = await Promise.all([
    getLandingHeaderViewerForRequest(),
    getRefundPolicyTranslator(),
  ]);

  return (
    <main className="container mx-auto max-w-3xl px-4 py-12">
      <LandingPageHeader viewer={viewer} />
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-2 text-muted-foreground">
          {t("lastUpdated", { date: LAST_UPDATED })}
        </p>
      </header>

      <section className="space-y-6 leading-relaxed">
        <p>
          {t.rich("intro", {
            terms: chunks => (
              <Link className="underline" href="/terms">
                {chunks}
              </Link>
            ),
          })}
        </p>

        <h2 className="text-xl font-medium">{t("window.title")}</h2>
        <p>{t("window.body")}</p>
        <p>{t("window.paddle")}</p>

        <h2 className="text-xl font-medium">{t("recalculation.title")}</h2>
        <p>{t("recalculation.body")}</p>
        <p>{t("recalculation.formula")}</p>
        <p>{t("recalculation.example")}</p>

        <h2 className="text-xl font-medium">{t("eligibility.title")}</h2>
        <ul className="ml-6 list-disc space-y-2">
          <li>{t("eligibility.items.unusedDays")}</li>
          <li>{t("eligibility.items.billingErrors")}</li>
          <li>{t("eligibility.items.trialCharges")}</li>
        </ul>

        <h2 className="text-xl font-medium">{t("exclusions.title")}</h2>
        <p>{t("exclusions.intro")}</p>
        <ul className="ml-6 list-disc space-y-2">
          <li>{t("exclusions.items.usedDays")}</li>
          <li>{t("exclusions.items.usage")}</li>
          <li>{t("exclusions.items.passThrough")}</li>
          <li>{t("exclusions.items.services")}</li>
          <li>{t("exclusions.items.taxes")}</li>
        </ul>

        <h2 className="text-xl font-medium">{t("request.title")}</h2>
        <p>
          {t.rich("request.body", {
            email: PUBLIC_SUPPORT_EMAIL,
            mail: supportEmailLink,
          })}
        </p>
        <p>{t("request.paddle")}</p>

        <h2 className="text-xl font-medium">{t("processing.title")}</h2>
        <p>{t("processing.body")}</p>
        <p>{t("processing.credits")}</p>

        <h2 className="text-xl font-medium">{t("cancellation.title")}</h2>
        <p>
          {t.rich("cancellation.body", {
            privacy: chunks => (
              <Link className="underline" href="/privacy">
                {chunks}
              </Link>
            ),
          })}
        </p>

        <h2 className="text-xl font-medium">{t("changes.title")}</h2>
        <p>{t("changes.body")}</p>

        <h2 className="text-xl font-medium">{t("contact.title")}</h2>
        <p>
          {t.rich("contact.body", {
            email: PUBLIC_SUPPORT_EMAIL,
            mail: supportEmailLink,
          })}
        </p>
      </section>
    </main>
  );
}

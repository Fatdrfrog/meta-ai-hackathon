import { LandingPageHeader } from "@/components/landing/page-header";
import { StructuredData } from "@/components/seo/structured-data";
import { getLandingHeaderViewerForRequest } from "@/lib/landing/landing-header-viewer.server";
import {
  createFAQSchema,
  createMetadata,
  createOrganizationSchema,
} from "@/lib/seo";
import { DEFAULT_OG_IMAGE_PATH } from "@/lib/public-seo";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = createMetadata({
  title: "About Airi.chat",
  description:
    "Learn how Airi.chat helps teams launch official WhatsApp bulk campaigns, automate AI follow-ups, and manage customer engagement across messaging channels.",
  keywords: [
    "about Airi.chat",
    "WhatsApp bulk campaigns",
    "WhatsApp marketing platform",
    "AI follow ups",
    "customer engagement platform",
    "WhatsApp Business Platform",
    "airi team",
  ],
  path: "/about",
  image: DEFAULT_OG_IMAGE_PATH,
});

export default async function About() {
  const [t, viewer] = await Promise.all([
    getTranslations("LandingDemo"),
    getLandingHeaderViewerForRequest(),
  ]);
  const organizationSchema = createOrganizationSchema();

  const faqSchema = createFAQSchema([
    {
      question: t("about.faq.what.question"),
      answer: t("about.faq.what.answer"),
    },
    {
      question: t("about.faq.founders.question"),
      answer: t("about.faq.founders.answer"),
    },
    {
      question: t("about.faq.problems.question"),
      answer: t("about.faq.problems.answer"),
    },
    {
      question: t("about.faq.audience.question"),
      answer: t("about.faq.audience.answer"),
    },
  ]);

  return (
    <>
      <StructuredData data={[organizationSchema, faqSchema]} />
      <main className="container mx-auto max-w-3xl px-4 py-12">
        <LandingPageHeader viewer={viewer} />
        <Image
          src="/about.jpg"
          alt={t("about.images.heroAlt")}
          width={1000}
          height={1000}
          className="rounded-lg mt-2 mb-2"
        />
        <span className="text-sm text-muted-foreground block text-center mb-2">
          {t("about.caption")}
        </span>
        <h1 className="text-3xl font-semibold tracking-tight">
          {t("about.title")}
        </h1>

        <section className="space-y-8 leading-relaxed">
          <h2 className="text-xl font-medium">{t("about.teamInfo.title")}</h2>
          <p>{t("about.teamInfo.intro")}</p>
          <ul className="list-disc ml-6 space-y-2">
            <li>
              <span className="font-medium">
                {t("about.teamInfo.aisulu.nameRole")}
              </span>{" "}
              {t("about.teamInfo.aisulu.description")}
              <br />
              <Link
                className="text-blue-400"
                href="https://www.linkedin.com/in/aisulu-kalshabekova-122b261b1"
                target="_blank"
              >
                {t("about.links.linkedin")}
              </Link>
            </li>
            <li>
              <span className="font-medium">
                {t("about.teamInfo.samat.nameRole")}
              </span>{" "}
              {t("about.teamInfo.samat.description")}
              <br />
              <Link
                className="text-blue-400"
                href="https://www.linkedin.com/in/kalshabekov/"
                target="_blank"
              >
                {t("about.links.linkedin")}
              </Link>
            </li>

            <li>{t("about.teamInfo.pmf")}</li>
          </ul>
          <h2 className="text-xl font-medium">{t("about.products.title")}</h2>
          <Image
            src="/about2.png"
            alt={t("about.images.productAlt")}
            width={1000}
            height={1000}
            className="rounded-lg mt-2 mb-2"
          />
          <p>{t("about.products.intro")}</p>
          <p>{t("about.products.problemsLabel")}</p>
          <ul className="list-disc ml-6 space-y-2">
            <li>{t("about.products.problems.overwhelmed")}</li>
            <li>{t("about.products.problems.visibility")}</li>
            <li>{t("about.products.problems.manualAnalysis")}</li>
            <li>{t("about.products.problems.audienceCompanies")}</li>
            <li>{t("about.products.problems.audienceTeams")}</li>
          </ul>
          <p>{t("about.products.closing")}</p>

          <section className="space-y-4 leading-relaxed">
            <div className="flex justify-center pt-4">
              <Link
                href="https://t.me/airi_chat1"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block text-2xl font-bold tracking-tight transition-all duration-300 ease-out hover:scale-105 hover:text-primary"
              >
                {t("about.ourTeam.join")}
              </Link>
            </div>
          </section>
        </section>
      </main>
    </>
  );
}

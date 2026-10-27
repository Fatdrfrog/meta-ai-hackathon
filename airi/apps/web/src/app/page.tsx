import { InteractiveDemoLanding } from "@/components/landing/interactive-demo";
import { landingDisplayFont } from "@/components/landing/landing-display-font";
import { StructuredData } from "@/components/seo/structured-data";
import { getLandingHeaderViewerForRequest } from "@/lib/landing/landing-header-viewer.server";
import {
  createFAQSchema,
  createMetadata,
  createOrganizationSchema,
  createSoftwareApplicationSchema,
  createWebSiteSchema,
} from "@/lib/seo";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export const metadata: Metadata = createMetadata({
  title: "airi.chat — WhatsApp campaigns, AI replies and follow-ups",
  description:
    "Run WhatsApp campaigns, answer customer questions with AI, and follow up from one shared workspace. Keep your team involved at every step with airi.chat.",
  keywords: [
    "WhatsApp customer engagement",
    "AI customer replies",
    "WhatsApp bulk campaigns",
    "official WhatsApp campaigns",
    "WhatsApp Business Platform",
    "WhatsApp marketing platform",
    "WhatsApp campaign automation",
    "WhatsApp templates",
    "WhatsApp Flows",
    "WhatsApp Marketing Messages API",
    "Instagram DM automation",
    "AI follow ups",
    "reply aware campaigns",
    "customer engagement platform",
  ],
  path: "/",
});

export default async function Home() {
  const [viewer, t] = await Promise.all([
    getLandingHeaderViewerForRequest(),
    getTranslations("LandingDemo"),
  ]);
  const organizationSchema = createOrganizationSchema();
  const websiteSchema = createWebSiteSchema();
  const softwareApplicationSchema = createSoftwareApplicationSchema();
  const faqSchema = createFAQSchema(
    Object.values(
      t.raw("faq.items") as Record<string, { question: string; answer: string }>
    )
  );

  return (
    <>
      <StructuredData
        data={[
          organizationSchema,
          websiteSchema,
          softwareApplicationSchema,
          faqSchema,
        ]}
      />
      <main
        className={`min-h-screen bg-background ${landingDisplayFont.variable}`}
      >
        <InteractiveDemoLanding viewer={viewer} />
      </main>
    </>
  );
}

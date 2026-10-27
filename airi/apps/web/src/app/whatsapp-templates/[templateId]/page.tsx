import { NextIntlClientProvider } from "next-intl";
import { notFound } from "next/navigation";
import { landingDisplayFont } from "@/components/landing/landing-display-font";
import { TemplateMarketplace } from "@/components/landing/template-marketplace";
import { StructuredData } from "@/components/seo/structured-data";
import { getPublicTemplatePageContext } from "@/lib/landing/public-template-page-context.server";
import { getLandingHeaderViewerForRequest } from "@/lib/landing/landing-header-viewer.server";
import { getPublicTemplate } from "@/lib/landing/public-template-catalog";
import {
  PUBLIC_TEMPLATE_LANGUAGES,
  createPublicTemplateMetadata,
  createPublicTemplateSchema,
  getPublicTemplatePath,
  resolvePublicTemplateLocale,
  type PublicTemplateSearchParams,
} from "@/lib/landing/public-template-seo";
import { createBreadcrumbSchema } from "@/lib/seo";
import { getPublicUrl } from "@/lib/public-seo";
import { getPublicTemplateText } from "@/lib/landing/public-template-catalog";

type Props = {
  params: Promise<{ templateId: string }>;
  searchParams: Promise<PublicTemplateSearchParams>;
};

async function getPageData({ params, searchParams }: Props) {
  const [{ templateId }, query] = await Promise.all([params, searchParams]);
  const locale = resolvePublicTemplateLocale(query);
  const template = getPublicTemplate(templateId, locale);
  if (!template) notFound();
  const { translate, messages } = await getPublicTemplatePageContext(locale);
  return { locale, template, translate, query, messages };
}

export async function generateMetadata(props: Props) {
  const { locale, template, translate, query } = await getPageData(props);
  return createPublicTemplateMetadata({
    locale,
    template,
    translate,
    searchParams: query,
  });
}

export default async function WhatsAppTemplatePage(props: Props) {
  const { locale, template, translate: t, messages } = await getPageData(props);
  const viewer = await getLandingHeaderViewerForRequest();
  const breadcrumbs = createBreadcrumbSchema([
    { name: "airi.chat", url: getPublicUrl() },
    {
      name: t("LandingDemo.templates.seo.title"),
      url: getPublicUrl(getPublicTemplatePath(locale)),
    },
    {
      name: getPublicTemplateText(template, "title", t),
      url: getPublicUrl(getPublicTemplatePath(locale, template.id)),
    },
  ]);
  return (
    <main
      lang={PUBLIC_TEMPLATE_LANGUAGES[locale].tag}
      className={`min-h-screen bg-background ${landingDisplayFont.variable}`}
    >
      <StructuredData
        data={[
          createPublicTemplateSchema({ locale, template, translate: t }),
          breadcrumbs,
        ]}
      />
      <NextIntlClientProvider locale={locale} messages={messages}>
        <TemplateMarketplace viewer={viewer} templateId={template.id} />
      </NextIntlClientProvider>
    </main>
  );
}

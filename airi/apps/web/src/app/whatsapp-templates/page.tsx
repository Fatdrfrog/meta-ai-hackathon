import { NextIntlClientProvider } from "next-intl";
import { landingDisplayFont } from "@/components/landing/landing-display-font";
import { TemplateMarketplace } from "@/components/landing/template-marketplace";
import { getLandingHeaderViewerForRequest } from "@/lib/landing/landing-header-viewer.server";
import { getPublicTemplatePageContext } from "@/lib/landing/public-template-page-context.server";
import { StructuredData } from "@/components/seo/structured-data";
import {
  PUBLIC_TEMPLATE_LANGUAGES,
  createPublicTemplateMetadata,
  createPublicTemplateSchema,
  resolvePublicTemplateLocale,
  type PublicTemplateSearchParams,
} from "@/lib/landing/public-template-seo";

type Props = { searchParams: Promise<PublicTemplateSearchParams> };

export async function generateMetadata({ searchParams }: Props) {
  const params = await searchParams;
  const locale = resolvePublicTemplateLocale(params);
  const { translate: t } = await getPublicTemplatePageContext(locale);
  return createPublicTemplateMetadata({
    locale,
    translate: t,
    searchParams: params,
  });
}

export default async function WhatsAppTemplatesPage({ searchParams }: Props) {
  const params = await searchParams;
  const locale = resolvePublicTemplateLocale(params);
  const [viewer, { translate: t, messages }] = await Promise.all([
    getLandingHeaderViewerForRequest(),
    getPublicTemplatePageContext(locale),
  ]);

  return (
    <main
      lang={PUBLIC_TEMPLATE_LANGUAGES[locale].tag}
      className={`min-h-screen bg-background ${landingDisplayFont.variable}`}
    >
      <StructuredData
        data={createPublicTemplateSchema({
          locale,
          translate: t,
          searchParams: params,
        })}
      />
      <NextIntlClientProvider locale={locale} messages={messages}>
        <TemplateMarketplace viewer={viewer} />
      </NextIntlClientProvider>
    </main>
  );
}

import {
  MarketingPage,
  getMarketingPageText,
} from "@/components/landing/marketing-page";
import { createMarketingPageMetadata } from "@/lib/landing/marketing-pages";
import {
  resolvePublicTemplateLocale,
  type PublicTemplateSearchParams,
} from "@/lib/landing/public-template-seo";

type Props = { searchParams: Promise<PublicTemplateSearchParams> };

export async function generateMetadata({ searchParams }: Props) {
  const locale = resolvePublicTemplateLocale(await searchParams);
  const text = await getMarketingPageText(locale);
  return createMarketingPageMetadata({
    page: "metaAds",
    locale,
    title: text("metaAds.seo.title"),
    description: text("metaAds.seo.description"),
  });
}

export default async function MetaAdsMcpPage({ searchParams }: Props) {
  const locale = resolvePublicTemplateLocale(await searchParams);
  return <MarketingPage page="metaAds" locale={locale} />;
}

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
    page: "delivery",
    locale,
    title: text("delivery.seo.title"),
    description: text("delivery.seo.description"),
  });
}

export default async function WhatsAppMarketingDeliveryPage({
  searchParams,
}: Props) {
  const locale = resolvePublicTemplateLocale(await searchParams);
  return <MarketingPage page="delivery" locale={locale} />;
}

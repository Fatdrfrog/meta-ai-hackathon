import { getLocaleFromCookie } from "@/i18n/message-loader";
import { buildPublicKBLandingHref } from "@/lib/kb/kb-route-prefetch";
import { resolvePublicKBRequestedLocale } from "@/lib/kb/public-kb-locale-fallback";
import { getPublicKBWorkspaceIds } from "@/lib/kb/public-kb";
import { notFound, redirect } from "next/navigation";

type CompanyPublicHomeSearchParams = {
  locale?: string | string[];
};

export default async function CompanyPublicHomePage({
  params,
  searchParams,
}: {
  params: Promise<{ companySlug: string }>;
  searchParams?: Promise<CompanyPublicHomeSearchParams>;
}) {
  const [{ companySlug }, resolvedSearchParams, cookieLocale] =
    await Promise.all([params, searchParams, getLocaleFromCookie()]);
  const workspaceIds = await getPublicKBWorkspaceIds(companySlug);

  if (workspaceIds.length === 0) {
    return notFound();
  }

  redirect(
    buildPublicKBLandingHref(
      companySlug,
      resolvePublicKBRequestedLocale(resolvedSearchParams, cookieLocale)
    )
  );
}

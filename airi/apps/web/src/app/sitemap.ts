import { AIRI_PRODUCT_KB_COMPANY_SLUG } from "@/lib/airi-product-context";
import {
  findMarketingPageByPath,
  getMarketingPageSitemapEntries,
} from "@/lib/landing/marketing-pages";
import { PUBLIC_MARKETING_ROUTES, getPublicUrl } from "@/lib/public-seo";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getPublicTemplateSitemapEntries } from "@/lib/landing/public-template-seo";
import type { MetadataRoute } from "next";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const buildTime = new Date();

  const staticPages: MetadataRoute.Sitemap = PUBLIC_MARKETING_ROUTES.flatMap(
    route => {
      // Localized pages list each language with its alternates.
      const marketingPage = findMarketingPageByPath(route.path);
      if (marketingPage) return getMarketingPageSitemapEntries(marketingPage);
      return route.path === "/whatsapp-templates"
        ? getPublicTemplateSitemapEntries()
        : [
            {
              url: getPublicUrl(route.path),
              lastModified: route.lastModified
                ? new Date(route.lastModified)
                : buildTime,
              changeFrequency: route.changeFrequency,
              priority: route.priority,
            },
          ];
    }
  );

  // Only airi.chat's own help center belongs in this sitemap: customers' public
  // knowledge bases are their content, not airi.chat's. Crawlers are anonymous,
  // and anon cannot read workspaces or companies for the public URL slug, so
  // read on the server and keep the public visibility rule (published, with a
  // publish time that has passed) in the query.
  const { data: articles, error } = await supabaseAdmin
    .from("kb_articles")
    .select(
      `
      id,
      published_at,
      updated_at,
      workspaces:workspaces!kb_articles_workspace_id_fkey!inner(
        companies:companies!workspaces_company_id_fkey!inner(
          slug
        )
      )
    `
    )
    .eq("workspaces.companies.slug", AIRI_PRODUCT_KB_COMPANY_SLUG)
    .eq("status", "published")
    .not("published_at", "is", null)
    .lte("published_at", buildTime.toISOString())
    .order("published_at", { ascending: false });

  if (error) {
    console.error("[Sitemap] Failed to fetch KB articles:", error);
    return staticPages;
  }

  const articlePages: MetadataRoute.Sitemap = [];

  if (articles) {
    for (const article of articles) {
      const workspace = Array.isArray(article.workspaces)
        ? article.workspaces[0]
        : article.workspaces;
      const company = Array.isArray(workspace?.companies)
        ? workspace.companies[0]
        : workspace?.companies;

      if (company?.slug === AIRI_PRODUCT_KB_COMPANY_SLUG) {
        const lastModified = article.updated_at
          ? new Date(article.updated_at)
          : article.published_at
            ? new Date(article.published_at)
            : buildTime;

        articlePages.push({
          url: getPublicUrl(`/${company.slug}/kb/${article.id}`),
          lastModified,
          changeFrequency: "monthly",
          priority: 0.7,
        });
      }
    }
  }

  return [...staticPages, ...articlePages];
}

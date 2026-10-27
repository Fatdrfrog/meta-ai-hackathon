import { supabaseAdmin } from "@/lib/supabase/admin";

export interface ArticleURLData {
  companySlug: string | null;
  articlePath: string;
  isPubliclyVisible: boolean;
  allowAutoLinkEmbedding: boolean;
}

type ArticleWorkspaceRow = {
  id: string;
  workspace_id: string;
  published_at: string | null;
  is_featured: boolean | null;
  include_link: boolean | null;
};

type WorkspaceCompanyRow = {
  id: string;
  company_id: string | null;
  companies?: {
    slug: string | null;
  } | null;
};

export function generateArticleURL(
  companySlug: string | null,
  articlePath: string
): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.airi.chat";
  if (companySlug) {
    return `${baseUrl}/${companySlug}/kb/${articlePath}`;
  }
  return `${baseUrl}/kb/${articlePath}`;
}

export async function fetchArticleURLData(
  articleIds: string[]
): Promise<Map<string, ArticleURLData>> {
  if (articleIds.length === 0) {
    return new Map();
  }

  try {
    const { data: articleRows, error: articleError } = await supabaseAdmin
      .from("kb_articles")
      .select("id, workspace_id, published_at, is_featured, include_link")
      .in("id", articleIds);

    if (articleError) {
      console.error(
        "[KB URL] Error fetching article workspace data:",
        articleError
      );
      return new Map();
    }

    if (!articleRows || articleRows.length === 0) {
      return new Map();
    }

    const typedArticles = articleRows as ArticleWorkspaceRow[];
    const workspaceIds = Array.from(
      new Set(typedArticles.map(a => a.workspace_id).filter(Boolean))
    );

    const { data: workspaceRows, error: workspaceError } = await supabaseAdmin
      .from("workspaces")
      .select("id, company_id, companies ( slug )")
      .in("id", workspaceIds);

    if (workspaceError) {
      console.error(
        "[KB URL] Error fetching workspace company data:",
        workspaceError
      );
      return new Map();
    }

    const typedWorkspaces = (workspaceRows ||
      []) as unknown as WorkspaceCompanyRow[];
    const workspaceToCompanySlug = new Map<string, string | null>(
      typedWorkspaces.map(w => [w.id, w.companies?.slug || null])
    );

    const urlDataMap = new Map<string, ArticleURLData>();
    for (const article of typedArticles) {
      const companySlug =
        workspaceToCompanySlug.get(article.workspace_id) || null;

      urlDataMap.set(article.id, {
        companySlug,
        articlePath: article.id,
        isPubliclyVisible: Boolean(article.published_at),
        allowAutoLinkEmbedding: Boolean(article.include_link),
      });
    }

    return urlDataMap;
  } catch (error) {
    console.error("[KB URL] Error fetching URL data:", error);
    return new Map();
  }
}

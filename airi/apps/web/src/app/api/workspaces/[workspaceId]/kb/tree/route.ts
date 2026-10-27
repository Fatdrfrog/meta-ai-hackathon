import { getAuthenticatedUser } from "@/lib/supabase/auth-helpers";
import {
  getKBTreeArticleLocaleState,
  getKBTreeArticleTitle,
} from "@/lib/kb/kb-title-overrides";
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type KBTreeArticleRow = {
  id: string;
  title: string;
  draft_title: string | null;
  workspace_id: string;
  parent_id: string | null;
  default_locale: string | null;
  status: string;
  updated_at: string;
  sort_order: number;
};

type KBTreeLocalizationRow = {
  article_id: string;
  locale: string;
  title: string;
  draft_title: string | null;
  draft_content_mdx: string | null;
  status: string | null;
};

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const supabase = await createClient();
    const { workspaceId } = await context.params;

    const { user, error: authError } = await getAuthenticatedUser(supabase);
    if (authError || !user) {
      return NextResponse.json(
        { error: authError?.message || "Unauthorized" },
        { status: 401 }
      );
    }

    const { count: membershipCount, error: membershipError } = await supabase
      .from("company_users")
      .select("workspace_id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("workspace_id", workspaceId)
      .limit(1);

    if (membershipError) throw membershipError;

    if (!membershipCount) {
      return NextResponse.json(
        { error: "Access denied to this workspace" },
        { status: 403 }
      );
    }

    const requestedLocale = request.nextUrl.searchParams.get("locale");

    const { data: articles, error: articlesError } = await supabase
      .from("kb_articles")
      .select(
        "id, title, draft_title, workspace_id, parent_id, default_locale, status, updated_at, sort_order"
      )
      .eq("workspace_id", workspaceId)
      .order("sort_order", { ascending: true });

    if (articlesError) throw articlesError;

    const articleRows = (articles ?? []) as KBTreeArticleRow[];
    const articleIds = articleRows.map(article => article.id);
    const { data: localizationRows, error: localizationError } =
      articleIds.length > 0
        ? await supabase
            .from("kb_article_localizations")
            .select("article_id, locale, title, draft_title, status")
            .in("article_id", articleIds)
        : { data: [], error: null };

    if (localizationError) throw localizationError;

    const { data: draftContentRows, error: draftContentError } =
      articleIds.length > 0
        ? await supabase
            .from("kb_article_localizations")
            .select("article_id, locale")
            .in("article_id", articleIds)
            .not("draft_content_mdx", "is", null)
        : { data: [], error: null };

    if (draftContentError) throw draftContentError;

    const draftContentKeys = new Set(
      ((draftContentRows as Array<{ article_id: string; locale: string }> | null) ??
        []
      ).map(row => `${row.article_id}:${row.locale}`)
    );
    const localizations = (
      (localizationRows as KBTreeLocalizationRow[] | null) ?? []
    ).map(row => ({
      ...row,
      draft_content_mdx: draftContentKeys.has(`${row.article_id}:${row.locale}`)
        ? "1"
        : null,
    }));

    const normalizedArticles = articleRows.map(
      ({ draft_title, default_locale, ...article }) => {
        const treeArticle = {
          id: article.id,
          title: article.title,
          draft_title,
          default_locale,
          status: article.status,
        };
        const localeState = getKBTreeArticleLocaleState({
          article: treeArticle,
          localizations,
          locale: requestedLocale,
        });

        return {
          ...article,
          default_locale,
          title: getKBTreeArticleTitle({
            article: treeArticle,
            localizations,
            locale: requestedLocale,
          }),
          locale_status: localeState.status,
          locale_has_draft: localeState.hasDraft,
        };
      }
    );

    return NextResponse.json(
      {
        articles: normalizedArticles,
      },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

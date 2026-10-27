import type { SupabaseClient } from "@supabase/supabase-js";
import { pickKBArticleTitle } from "@/lib/kb/kb-title-overrides";

export interface KBAncestor {
  id: string;
  title: string;
}

const MAX_DEPTH = 5;

interface FetchKBAncestorsOptions {
  maxDepth?: number;
  useDraft?: boolean;
  locale?: string | null;
}

type KBAncestorRpcRow = {
  id: string;
  title: string;
  depth: number;
};

/**
 * Fetch ancestor chain (root -> immediate parent) for an article.
 * Uses DB RPC in a single query.
 */
export async function fetchKBAncestors(
  supabase: SupabaseClient,
  parentId: string | null,
  workspaceId?: string,
  options?: FetchKBAncestorsOptions
): Promise<KBAncestor[]> {
  if (!parentId) return [];

  const maxDepth = Math.max(1, options?.maxDepth ?? MAX_DEPTH);
  const { data, error } = await supabase.rpc("kb_fetch_ancestors", {
    p_parent_id: parentId,
    p_workspace_id: workspaceId ?? null,
    p_max_depth: maxDepth,
    p_use_draft: options?.useDraft ?? false,
  });

  if (error) {
    throw error;
  }

  if (!Array.isArray(data)) {
    return [];
  }

  const ancestors = (data as KBAncestorRpcRow[]).map(row => ({
    id: row.id,
    title: row.title,
  }));

  if (!options?.locale || ancestors.length === 0) {
    return ancestors;
  }

  let localizationsQuery = supabase
    .from("kb_article_localizations")
    .select("article_id, title, draft_title, status, published_at")
    .in(
      "article_id",
      ancestors.map(ancestor => ancestor.id)
    )
    .eq("locale", options.locale);

  if (!options.useDraft) {
    localizationsQuery = localizationsQuery
      .eq("status", "published")
      .not("published_at", "is", null)
      .lte("published_at", new Date().toISOString());
  }

  const { data: localizations } = await localizationsQuery;

  const titleByArticleId = new Map(
    (
      (localizations ?? []) as Array<{
        article_id: string;
        title: string;
        draft_title: string | null;
      }>
    ).map(localization => [
      localization.article_id,
      options.useDraft
        ? pickKBArticleTitle(localization.draft_title, localization.title)
        : pickKBArticleTitle(localization.title),
    ])
  );

  return ancestors.map(ancestor => ({
    ...ancestor,
    title: pickKBArticleTitle(
      titleByArticleId.get(ancestor.id),
      ancestor.title
    ),
  }));
}

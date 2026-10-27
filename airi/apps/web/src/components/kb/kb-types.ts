/**
 * Shared types for Knowledge Base components
 * Used by both admin panel and public-facing KB
 */

// Base article type with common fields
export interface KBArticleBase {
  id: string;
  title: string;
  workspace_id: string;
  parent_id: string | null;
  sort_order: number;
}

// Extended article type for admin use
export interface KBArticleAdmin extends KBArticleBase {
  status: string;
  updated_at: string;
  default_locale?: string | null;
  locale_status?: string | null;
  locale_has_draft?: boolean;
}

/**
 * Build a nested article tree from a flat list
 * @param articles - Flat list of articles for a workspace
 * @param parentId - Parent article ID (null for root level)
 * @returns Sorted array of child articles
 */
export function buildArticleTree<T extends KBArticleBase>(
  articles: T[],
  parentId: string | null = null
): T[] {
  return articles
    .filter(a => a.parent_id === parentId)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
}

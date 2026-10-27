interface KBNavTreeArticle {
  id: string;
  parent_id: string | null;
  sort_order: number;
}

export interface KBNavTreeModel<TArticle extends KBNavTreeArticle> {
  getChildren: (parentId: string | null) => TArticle[];
  getDescendantCount: (articleId: string) => number;
}

export function buildKBNavTreeModel<TArticle extends KBNavTreeArticle>(
  articles: TArticle[]
): KBNavTreeModel<TArticle> {
  const childrenByParentId = new Map<string | null, TArticle[]>();

  for (const article of articles) {
    const siblings = childrenByParentId.get(article.parent_id) ?? [];
    siblings.push(article);
    childrenByParentId.set(article.parent_id, siblings);
  }

  for (const siblings of childrenByParentId.values()) {
    siblings.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  }

  const descendantCountByArticleId = new Map<string, number>();

  const countDescendants = (
    articleId: string,
    visiting: Set<string> = new Set()
  ): number => {
    const cached = descendantCountByArticleId.get(articleId);
    if (cached !== undefined) return cached;
    if (visiting.has(articleId)) return 0;
    visiting.add(articleId);

    const children = childrenByParentId.get(articleId) ?? [];
    let count = children.length;

    for (const child of children) {
      count += countDescendants(child.id, visiting);
    }

    visiting.delete(articleId);
    descendantCountByArticleId.set(articleId, count);
    return count;
  };

  return {
    getChildren: parentId => childrenByParentId.get(parentId) ?? [],
    getDescendantCount: articleId => countDescendants(articleId),
  };
}

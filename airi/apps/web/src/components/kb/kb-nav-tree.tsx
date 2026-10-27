"use client";

import { Badge } from "@/components/ui/badge";
import {
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { companySlugAtom } from "@/lib/navigation/company-slug-state";
import {
  buildAdminKBArticleHref,
  buildPublicKBArticleHref,
  prefetchKBArticleRoutes,
} from "@/lib/kb/kb-route-prefetch";
import { buildKBNavTreeModel } from "@/lib/kb/kb-nav-tree-model";
import { useAtom } from "jotai";
import { ChevronDown, ChevronRight, FileText } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { KBArticleBase as KBArticlePublic } from "./kb-types";

function collectAncestorArticleKeys(
  articles: KBArticlePublic[],
  articleId: string
): string[] {
  const byId = new Map(articles.map(article => [article.id, article]));
  const keys: string[] = [];
  const visited = new Set<string>();
  let current = byId.get(articleId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    keys.push(`article-${current.id}`);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return keys;
}

function mergeExpandedAncestorKeys(
  expandedItems: Set<string>,
  ancestorKeys: string[]
): Set<string> {
  if (
    ancestorKeys.length === 0 ||
    ancestorKeys.every(key => expandedItems.has(key))
  ) {
    return expandedItems;
  }
  const next = new Set(expandedItems);
  for (const key of ancestorKeys) {
    next.add(key);
  }
  return next;
}

interface KBNavTreeProps {
  articles: KBArticlePublic[];
  currentArticleId?: string;
  mode: "public" | "internal";
  companySlug?: string;
  workspaceId?: string;
  locale?: string | null;
}

export function KBNavTree({
  articles,
  currentArticleId,
  mode,
  companySlug,
  workspaceId,
  locale,
}: KBNavTreeProps) {
  const router = useRouter();
  const [companySlugFromAtom] = useAtom(companySlugAtom);
  const effectiveCompanySlug = companySlug ?? companySlugFromAtom;
  const effectiveWorkspaceId = workspaceId;
  const [expandedItems, setExpandedItems] = useState<Set<string>>(() =>
    currentArticleId
      ? new Set(collectAncestorArticleKeys(articles, currentArticleId))
      : new Set()
  );
  const [prevCurrentArticleId, setPrevCurrentArticleId] =
    useState(currentArticleId);
  const [prevArticles, setPrevArticles] = useState(articles);
  const treeModel = useMemo(() => buildKBNavTreeModel(articles), [articles]);

  if (currentArticleId !== prevCurrentArticleId || articles !== prevArticles) {
    setPrevCurrentArticleId(currentArticleId);
    setPrevArticles(articles);
    if (currentArticleId) {
      const nextExpandedItems = mergeExpandedAncestorKeys(
        expandedItems,
        collectAncestorArticleKeys(articles, currentArticleId)
      );
      if (nextExpandedItems !== expandedItems) {
        setExpandedItems(nextExpandedItems);
      }
    }
  }

  const toggleItem = useCallback((itemId: string) => {
    setExpandedItems(prev => {
      const newSet = new Set(prev);
      if (newSet.has(itemId)) {
        newSet.delete(itemId);
      } else {
        newSet.add(itemId);
      }
      return newSet;
    });
  }, []);

  const getArticleUrl = useCallback(
    (articleId: string) => {
      if (mode === "public") {
        return buildPublicKBArticleHref(
          effectiveCompanySlug ?? undefined,
          articleId,
          locale
        );
      }
      return buildAdminKBArticleHref(
        effectiveWorkspaceId ?? "",
        articleId,
        locale
      );
    },
    [mode, effectiveCompanySlug, effectiveWorkspaceId, locale]
  );

  const prefetchArticle = useCallback(
    (articleId: string) => {
      prefetchKBArticleRoutes(router, [getArticleUrl(articleId)], 1);
    },
    [getArticleUrl, router]
  );

  const getArticleChildren = useCallback(
    (parentId: string | null = null): KBArticlePublic[] => {
      return treeModel.getChildren(parentId);
    },
    [treeModel]
  );

  function renderArticle(
    article: KBArticlePublic,
    level: number = 0
  ): React.ReactNode {
    const articleKey = `article-${article.id}`;
    const isExpanded = expandedItems.has(articleKey);
    const childArticles = getArticleChildren(article.id);
    const hasChildren = childArticles.length > 0;
    const isActive = currentArticleId === article.id;
    const articleHref = getArticleUrl(article.id);
    const warmArticleRoute = () => prefetchArticle(article.id);

    const articleLink = (
      <Link
        href={articleHref}
        prefetch={true}
        className="min-w-0"
        onMouseEnter={warmArticleRoute}
        onFocus={warmArticleRoute}
      >
        <FileText className="h-4 w-4" />
        <span className="min-w-0 flex-1 truncate">{article.title}</span>
      </Link>
    );

    if (hasChildren) {
      return (
        <SidebarMenuItem key={article.id}>
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted"
              aria-expanded={isExpanded}
              aria-label={isExpanded ? "Collapse" : "Expand"}
              onClick={() => toggleItem(articleKey)}
            >
              {isExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
            <SidebarMenuButton
              asChild
              isActive={isActive}
              className="min-w-0 flex-1"
            >
              {articleLink}
            </SidebarMenuButton>
            <Badge variant="secondary" className="ml-1 shrink-0 text-xs">
              {treeModel.getDescendantCount(article.id)}
            </Badge>
          </div>

          {isExpanded ? (
            <SidebarMenuSub>
              {childArticles.map(child => renderArticle(child, level + 1))}
            </SidebarMenuSub>
          ) : null}
        </SidebarMenuItem>
      );
    }

    if (level === 0) {
      return (
        <SidebarMenuItem key={article.id}>
          <SidebarMenuButton asChild isActive={isActive}>
            {articleLink}
          </SidebarMenuButton>
        </SidebarMenuItem>
      );
    }

    return (
      <SidebarMenuSubItem key={article.id}>
        <SidebarMenuSubButton asChild isActive={isActive}>
          {articleLink}
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    );
  }

  const rootArticles = useMemo(
    () => getArticleChildren(null),
    [getArticleChildren]
  );

  return <>{rootArticles.map(article => renderArticle(article, 0))}</>;
}

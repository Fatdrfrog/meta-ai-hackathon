"use client";

import { Button } from "@/components/ui/button";
import { useKBArticles } from "@/hooks/use-kb-articles";
import {
  kbArticleEditorSaveStatusAtom,
  kbArticleRoutePendingAtom,
  kbArticleSaveDraftBeforeNavigateAtom,
  kbArticleRouteTargetIdAtom,
  kbArticleTitleOverridesAtom,
  kbTreeRefreshCallbackAtom,
} from "@/lib/kb/kb-editor-state";
import { registerKBTreeRefreshCallback } from "@/lib/kb/kb-tree-refresh-registration";
import {
  buildAdminKBArticleHref,
  buildKBArticleHrefs,
  prefetchKBArticleRoutes,
} from "@/lib/kb/kb-route-prefetch";
import { isLocale } from "@/i18n/locales";
import { reconcileKBArticleTitleOverrides } from "@/lib/kb/kb-title-overrides";
import { useAtomValue, useSetAtom } from "jotai";
import { BookOpen, ChevronLeft, Loader2, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { KBAdminTree } from "./kb-admin-tree";

import type { KBArticleAdmin } from "./kb-types";

export type { KBArticleAdmin as KBArticleData } from "./kb-types";

async function readKbAdminJson<T>(
  response: Response,
  fallbackError: string
): Promise<T> {
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      typeof data?.error === "string" && data.error.trim()
        ? data.error
        : fallbackError
    );
  }
  return (await response.json().catch(() => ({}))) as T;
}

interface KBAdminSidebarProps {
  workspaceId: string;
  onCollapse?: () => void;
  isMobile?: boolean;
}

export function KBAdminSidebar({
  workspaceId,
  onCollapse,
  isMobile,
}: KBAdminSidebarProps) {
  const t = useTranslations("KnowledgeBase");
  const newArticleTitle =
    typeof t.has === "function" && t.has("newArticle.title")
      ? t("newArticle.title")
      : "New Article";
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const editorLocale = searchParams.get("locale");

  const { articles, isLoading, error, mutate } = useKBArticles(workspaceId, {
    revalidateOnFocus: false,
    refreshInterval: 0,
    locale: editorLocale,
  });

  const mutateRef = useRef(mutate);
  const setRefreshCallback = useSetAtom(kbTreeRefreshCallbackAtom);
  const setTitleOverrides = useSetAtom(kbArticleTitleOverridesAtom);
  const saveStatus = useAtomValue(kbArticleEditorSaveStatusAtom);
  const saveBeforeNavigate = useAtomValue(kbArticleSaveDraftBeforeNavigateAtom);
  const isRoutePending = useAtomValue(kbArticleRoutePendingAtom);
  const setRoutePending = useSetAtom(kbArticleRoutePendingAtom);
  const setRouteTargetId = useSetAtom(kbArticleRouteTargetIdAtom);
  useEffect(() => {
    mutateRef.current = mutate;
  }, [mutate]);

  useEffect(() => {
    registerKBTreeRefreshCallback(setRefreshCallback, async () => {
      await mutateRef.current();
    });
    return () => setRefreshCallback(null);
  }, [setRefreshCallback]);

  useEffect(() => {
    prefetchKBArticleRoutes(
      router,
      buildKBArticleHrefs(articles, articleId =>
        buildAdminKBArticleHref(workspaceId, articleId, editorLocale)
      ),
      80
    );
  }, [articles, editorLocale, router, workspaceId]);

  useEffect(() => {
    setTitleOverrides(prev => reconcileKBArticleTitleOverrides(prev, articles));
  }, [articles, setTitleOverrides]);

  const [isCreatingArticle, setIsCreatingArticle] = useState(false);
  const [isDeletingArticle, setIsDeletingArticle] = useState(false);

  const getCurrentSelection = useCallback(() => {
    const kbMatch = pathname?.match(/\/panel\/w\/[^/]+\/kb\/([^/]+)/);
    return {
      articleId: kbMatch?.[1] || null,
    };
  }, [pathname]);

  const { articleId: currentArticleId } = getCurrentSelection();

  useEffect(() => {
    if (!isRoutePending) return;
    if (!currentArticleId) {
      setRoutePending(false);
      setRouteTargetId(null);
    }
  }, [currentArticleId, isRoutePending, setRoutePending, setRouteTargetId]);

  const fetchData = useCallback(async (_refresh = false) => {
    await mutateRef.current();
  }, []);

  const ensureActiveArticleSaved = useCallback(async (): Promise<boolean> => {
    if (!currentArticleId || !saveBeforeNavigate) return true;
    if (saveStatus === "saved") return true;

    if (saveStatus === "saving") {
      toast.error("Please wait until the current article is saved.");
      return false;
    }

    try {
      const saved = await saveBeforeNavigate();
      if (!saved) {
        toast.error("Please fix save issues before leaving this article.");
        return false;
      }
      return true;
    } catch (error) {
      console.error("Failed to save current article before navigation:", error);
      toast.error("Failed to save the current article. Please try again.");
      return false;
    }
  }, [currentArticleId, saveBeforeNavigate, saveStatus]);

  const handleDeleteArticle = useCallback(
    async (articleId: string) => {
      if (isCreatingArticle || isDeletingArticle || isRoutePending) return;

      const canContinue = await ensureActiveArticleSaved();
      if (!canContinue) return;

      const article = articles.find(a => a.id === articleId);
      const remainingArticles = articles.filter(a => a.id !== articleId);
      const isDeletingCurrentArticle = currentArticleId === articleId;
      const targetId = article?.parent_id ?? remainingArticles[0]?.id ?? null;

      setIsDeletingArticle(true);

      if (isDeletingCurrentArticle) {
        setRouteTargetId(targetId);
        setRoutePending(true);
      }

      try {
        const response = await fetch(`/api/kb/${articleId}`, {
          method: "DELETE",
        });
        await readKbAdminJson(response, "Failed to delete article");

        try {
          await mutate();
        } catch (revalidateError) {
          console.error(
            "Failed to revalidate KB tree after delete:",
            revalidateError
          );
        }

        if (isDeletingCurrentArticle) {
          router.push(
            targetId
              ? buildAdminKBArticleHref(workspaceId, targetId, editorLocale)
              : `/panel/w/${workspaceId}/kb`
          );
        }
      } catch (error) {
        console.error("Error deleting article:", error);
        toast.error(t("adminTree.failedToDelete") ?? "Failed to delete");
        if (isDeletingCurrentArticle) {
          setRoutePending(false);
          setRouteTargetId(null);
        }
      } finally {
        setIsDeletingArticle(false);
      }
    },
    [
      articles,
      currentArticleId,
      isCreatingArticle,
      isDeletingArticle,
      isRoutePending,
      ensureActiveArticleSaved,
      mutate,
      router,
      setRoutePending,
      setRouteTargetId,
      t,
      workspaceId,
      editorLocale,
    ]
  );

  // Handle navigation
  const handleSelectArticle = useCallback(
    async (articleId: string) => {
      if (isRoutePending || articleId === currentArticleId) {
        return;
      }

      setRouteTargetId(articleId);
      setRoutePending(true);

      const canContinue = await ensureActiveArticleSaved();
      if (!canContinue) {
        setRoutePending(false);
        setRouteTargetId(null);
        return;
      }

      router.push(
        buildAdminKBArticleHref(workspaceId, articleId, editorLocale)
      );
    },
    [
      currentArticleId,
      ensureActiveArticleSaved,
      isRoutePending,
      router,
      setRoutePending,
      setRouteTargetId,
      workspaceId,
      editorLocale,
    ]
  );

  const handleCreateArticle = useCallback(
    async (parentArticleId?: string) => {
      if (isCreatingArticle || isDeletingArticle || isRoutePending) return;

      const canContinue = await ensureActiveArticleSaved();
      if (!canContinue) return;

      setIsCreatingArticle(true);
      setRoutePending(true);
      setRouteTargetId(null);

      try {
        const response = await fetch(`/api/kb`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "",
            parent_id: parentArticleId ?? null,
            workspace_id: workspaceId,
            ...(editorLocale && isLocale(editorLocale)
              ? { locale: editorLocale }
              : {}),
          }),
        });

        const data = await readKbAdminJson<{ article?: KBArticleAdmin }>(
          response,
          "Failed to create article"
        );

        const serverArticle = data.article as KBArticleAdmin | undefined;
        if (!serverArticle?.id) {
          throw new Error("Create article response is missing article id");
        }

        try {
          await mutate();
        } catch (revalidateError) {
          console.error(
            "Failed to revalidate KB tree after create:",
            revalidateError
          );
        }

        setRouteTargetId(serverArticle.id);
        setRoutePending(true);
        router.push(
          buildAdminKBArticleHref(workspaceId, serverArticle.id, editorLocale)
        );
      } catch (error) {
        console.error("Error creating article:", error);
        toast.error("Failed to create article");
        setRoutePending(false);
        setRouteTargetId(null);
      } finally {
        setIsCreatingArticle(false);
      }
    },
    [
      isCreatingArticle,
      isDeletingArticle,
      isRoutePending,
      ensureActiveArticleSaved,
      mutate,
      router,
      setRoutePending,
      setRouteTargetId,
      workspaceId,
      editorLocale,
    ]
  );

  const isUILocked = isRoutePending || isCreatingArticle || isDeletingArticle;
  const showTreeSpinner = isLoading && articles.length === 0;

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden min-h-0">
      {/* Header - fixed at top (not sticky to prevent scroll issues) */}
      <div className="p-3 border-b flex items-center justify-between shrink-0 min-w-0 bg-background">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {isMobile && onCollapse && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              onClick={onCollapse}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          )}
          <BookOpen className="h-4 w-4 shrink-0" />
          <span className="font-medium text-sm truncate">{t("title")}</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className={`h-7 w-7 shrink-0 transition-opacity ${
            isUILocked ? "opacity-0 pointer-events-none" : "opacity-100"
          }`}
          onClick={() => handleCreateArticle()}
          title={newArticleTitle}
          aria-label={newArticleTitle}
          disabled={isUILocked}
          aria-busy={isUILocked}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Tree Content - always shows thin scrollbar to prevent layout shift */}
      <div
        className="flex-1 overflow-y-auto scrollbar-show"
        aria-busy={isUILocked || showTreeSpinner}
      >
        <div className="py-2 pl-0.5 pr-1 w-full min-w-0">
          {showTreeSpinner ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              <span>
                {t("adminTree.loadingArticles") || "Loading articles..."}
              </span>
            </div>
          ) : error && articles.length === 0 ? (
            <div className="text-center py-8 px-4">
              <p className="text-sm text-muted-foreground mb-3">
                {t("adminTree.failedToLoad") || "Could not load articles"}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void mutate();
                }}
              >
                {t("adminTree.retry") || "Retry"}
              </Button>
            </div>
          ) : articles.length === 0 ? (
            <motion.div
              className="text-center py-8 px-4"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ type: "spring", bounce: 0.1, duration: 0.3 }}
            >
              <BookOpen className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground mb-3">
                {t("noArticlesYet") || "No articles yet"}
              </p>
              <Button
                size="sm"
                onClick={() => handleCreateArticle()}
                disabled={isUILocked}
                className={`w-full max-w-full min-w-0 whitespace-normal text-center leading-snug transition-opacity ${
                  isUILocked ? "opacity-0 pointer-events-none" : "opacity-100"
                }`}
              >
                <Plus className="size-3.5 shrink-0" />
                <span className="min-w-0 leading-snug">
                  {t("createFirstArticle") || "Create first article"}
                </span>
              </Button>
            </motion.div>
          ) : (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ type: "spring", bounce: 0.1, duration: 0.2 }}
              className="min-h-0"
            >
              <KBAdminTree
                articles={articles}
                currentArticleId={currentArticleId}
                onSelectArticle={handleSelectArticle}
                onCreateArticle={handleCreateArticle}
                onRefresh={fetchData}
                onDeleteArticle={handleDeleteArticle}
                isInteractionLocked={isUILocked}
              />
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  kbArticleActiveIdAtom,
  kbArticleActiveTitleAtom,
  kbArticleTitleOverridesAtom,
} from "@/lib/kb/kb-editor-state";
import { cn } from "@/lib/utils";
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { ReactNode } from "react";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { atom, useAtomValue, useSetAtom } from "jotai";
import {
  ChevronRight,
  FileText,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { motion } from "motion/react";
import { useTranslations } from "next-intl";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { toast } from "sonner";
import type { KBArticleData } from "./kb-admin-sidebar";
import { buildArticleTree } from "./kb-types";

interface KBAdminTreeProps {
  articles: KBArticleData[];
  currentArticleId: string | null;
  onSelectArticle: (articleId: string) => void;
  onCreateArticle: (parentArticleId?: string) => void;
  onRefresh: () => void;
  onDeleteArticle: (articleId: string) => void;
  isInteractionLocked?: boolean;
}

interface TreeItemState {
  expanded: Set<string>;
  editing: string | null;
  editValue: string;
}

const KBTreeLiveTitle = memo(function KBTreeLiveTitle({
  articleId,
  fallback,
}: {
  articleId: string;
  fallback: string;
}) {
  const titleAtom = useMemo(
    () =>
      atom(get => {
        const activeId = get(kbArticleActiveIdAtom);
        if (activeId === articleId) {
          return get(kbArticleActiveTitleAtom) || fallback;
        }

        return get(kbArticleTitleOverridesAtom)[articleId] || fallback;
      }),
    [articleId, fallback]
  );
  const title = useAtomValue(titleAtom);

  return title;
});

function SortableArticleItem({
  article,
  level,
  state,
  currentArticleId,
  isSaving,
  isInteractionLocked,
  childArticles,
  onToggleExpanded,
  onSelectArticle,
  onStartEditing,
  onCancelEditing,
  onEditKeyDown,
  onCreateArticle,
  onDelete,
  editInputRef,
  renderArticle,
  treeT,
}: {
  article: KBArticleData;
  level: number;
  state: TreeItemState;
  currentArticleId: string | null;
  isSaving: boolean;
  isInteractionLocked: boolean;
  childArticles: KBArticleData[];
  onToggleExpanded: (itemId: string) => void;
  onSelectArticle: (articleId: string) => void;
  onStartEditing: (itemId: string, value: string) => void;
  onCancelEditing: () => void;
  onEditKeyDown: (e: KeyboardEvent<HTMLInputElement>, id: string) => void;
  onCreateArticle: (parentId?: string) => void;
  onDelete: (id: string) => void;
  editInputRef: React.RefObject<HTMLInputElement | null>;
  renderArticle: (article: KBArticleData, level: number) => ReactNode;
  treeT: (key: string) => string;
}) {
  const itemId = `article-${article.id}`;
  const untitled = treeT("untitled");
  const isExpanded = state.expanded.has(itemId);
  const isEditing = state.editing === itemId;
  const isActive = currentArticleId === article.id;
  const hasChildren = childArticles.length > 0;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: article.id,
    data: { type: "article", article, level },
  });

  const style = {
    transform: transform ? CSS.Transform.toString(transform) : undefined,
    transition,
  };

  return (
    <motion.div
      ref={setNodeRef}
      style={style}
      className="w-full max-w-full"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ type: "spring", bounce: 0.1, duration: 0.2 }}
    >
      <div
        className={cn(
          "group flex items-center gap-0.5 pl-1 pr-1 py-1.5 rounded-md text-sm transition-colors w-full max-w-full overflow-hidden cursor-pointer",
          isInteractionLocked && "pointer-events-none",
          isActive && "bg-accent text-accent-foreground",
          !isActive && "hover:bg-muted/50",
          isDragging && "opacity-50"
        )}
        style={{ paddingLeft: `${4 + level * 12}px` }}
        onClick={() => {
          if (isInteractionLocked) return;
          if (!isEditing) {
            onSelectArticle(article.id);
          }
        }}
        onDoubleClick={() => {
          if (isInteractionLocked) return;
          onStartEditing(itemId, article.title || untitled);
        }}
      >
        <button
          type="button"
          className={cn(
            "shrink-0 p-0 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 hover:bg-muted rounded-sm touch-manipulation",
            isInteractionLocked && "opacity-0"
          )}
          {...attributes}
          {...listeners}
          disabled={isInteractionLocked}
        >
          <GripVertical className="size-3.5 text-muted-foreground" />
        </button>

        {/* Expand/collapse for nested articles */}
        {hasChildren ? (
          <button
            type="button"
            className="p-0.5 hover:bg-muted rounded shrink-0"
            aria-expanded={isExpanded}
            aria-label={
              isExpanded ? treeT("collapseArticle") : treeT("expandArticle")
            }
            onClick={e => {
              e.stopPropagation();
              if (isInteractionLocked) return;
              onToggleExpanded(itemId);
            }}
            disabled={isInteractionLocked}
          >
            <motion.span
              animate={{ rotate: isExpanded ? 90 : 0 }}
              transition={{ type: "spring", bounce: 0.15, duration: 0.25 }}
              className="inline-block"
            >
              <ChevronRight className="size-3.5" />
            </motion.span>
          </button>
        ) : (
          <span className="w-4" />
        )}

        <FileText className="size-4 shrink-0 text-muted-foreground" />

        {isEditing ? (
          <Input
            ref={editInputRef}
            value={state.editValue}
            onChange={e => {
              onStartEditing(itemId, e.target.value);
            }}
            onKeyDown={e => onEditKeyDown(e, article.id)}
            onBlur={onCancelEditing}
            className="h-6 text-sm flex-1 min-w-0"
            disabled={isSaving || isInteractionLocked}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <div className="truncate flex-1 min-w-0 w-0">
            <KBTreeLiveTitle
              articleId={article.id}
              fallback={article.title || untitled}
            />
          </div>
        )}

        {(article.locale_status ?? article.status) === "draft" ||
        article.locale_has_draft ? (
          <Badge
            variant="secondary"
            className="text-xs px-1 py-0 shrink-0 whitespace-nowrap"
          >
            {treeT("draft")}
          </Badge>
        ) : null}

        {/* Hover actions */}
        {!isEditing && (
          <div className="flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="size-5"
              onClick={e => {
                e.stopPropagation();
                if (isInteractionLocked) return;
                onCreateArticle(article.id);
              }}
              title={treeT("addSubArticle")}
              aria-label={treeT("addSubArticle")}
              disabled={isInteractionLocked}
            >
              <Plus className="size-3" />
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-5"
                  onClick={e => e.stopPropagation()}
                  disabled={isInteractionLocked}
                >
                  <MoreHorizontal className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem
                  onClick={e => {
                    e.stopPropagation();
                    onStartEditing(itemId, article.title || untitled);
                  }}
                >
                  <Pencil className="mr-2 size-3.5" />
                  {treeT("rename")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={e => {
                    e.stopPropagation();
                    onDelete(article.id);
                  }}
                >
                  <Trash2 className="mr-2 size-3.5" />
                  {treeT("delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      {/* Render child articles */}
      {isExpanded && hasChildren && (
        <SortableContext
          items={childArticles.map(a => a.id)}
          strategy={verticalListSortingStrategy}
        >
          {childArticles.map(child => renderArticle(child, level + 1))}
        </SortableContext>
      )}
    </motion.div>
  );
}

export function KBAdminTree({
  articles,
  currentArticleId,
  onSelectArticle,
  onCreateArticle,
  onRefresh,
  onDeleteArticle,
  isInteractionLocked = false,
}: KBAdminTreeProps) {
  const treeT = useTranslations("KnowledgeBase.adminTree");
  const [state, setState] = useState<TreeItemState>({
    expanded: new Set<string>(),
    editing: null,
    editValue: "",
  });
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [optimisticArticles, setOptimisticArticles] = useState<
    KBArticleData[] | null
  >(null);
  const [previousArticles, setPreviousArticles] = useState(articles);
  if (previousArticles !== articles) {
    setOptimisticArticles(null);
    setPreviousArticles(articles);
  }
  const visibleArticles = optimisticArticles ?? articles;

  const sharedActiveId = useAtomValue(kbArticleActiveIdAtom);
  const setSharedActiveTitle = useSetAtom(kbArticleActiveTitleAtom);
  const setTitleOverrides = useSetAtom(kbArticleTitleOverridesAtom);

  const editInputRef = useRef<HTMLInputElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  const updateVisibleArticlesOptimistically = useCallback(
    (updater: (currentArticles: KBArticleData[]) => KBArticleData[]) => {
      setOptimisticArticles(currentArticles =>
        updater(currentArticles ?? visibleArticles)
      );
    },
    [visibleArticles]
  );

  // Auto-expand current article and its parents
  useEffect(() => {
    if (currentArticleId) {
      setState(prev => {
        const newExpanded = new Set(prev.expanded);
        const findArticle = (id: string | null): KBArticleData | null =>
          visibleArticles.find(a => a.id === id) || null;

        let current: KBArticleData | null = findArticle(currentArticleId);
        while (current) {
          newExpanded.add(`article-${current.id}`);
          current = current.parent_id ? findArticle(current.parent_id) : null;
        }
        return { ...prev, expanded: newExpanded };
      });
    }
  }, [currentArticleId, visibleArticles]);

  useEffect(() => {
    if (state.editing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [state.editing]);

  const getArticleChildren = useCallback(
    (parentId: string | null = null): KBArticleData[] => {
      return buildArticleTree(visibleArticles, parentId);
    },
    [visibleArticles]
  );

  const toggleExpanded = useCallback((itemId: string) => {
    setState(prev => {
      const newExpanded = new Set(prev.expanded);
      if (newExpanded.has(itemId)) {
        newExpanded.delete(itemId);
      } else {
        newExpanded.add(itemId);
      }
      return { ...prev, expanded: newExpanded };
    });
  }, []);

  const startEditing = useCallback((itemId: string, currentValue: string) => {
    setState(prev => ({
      ...prev,
      editing: itemId,
      editValue: currentValue,
    }));
  }, []);

  const cancelEditing = useCallback(() => {
    setState(prev => ({ ...prev, editing: null, editValue: "" }));
  }, []);

  const handleEditKeyDown = useCallback(
    async (e: KeyboardEvent<HTMLInputElement>, itemId: string) => {
      if (e.key === "Escape") {
        cancelEditing();
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        const newValue = state.editValue.trim();
        if (!newValue) {
          cancelEditing();
          return;
        }

        const article = visibleArticles.find(a => a.id === itemId);
        if (article && (article.title || "").trim() === newValue) {
          cancelEditing();
          return;
        }

        setIsSaving(true);
        try {
          if (article) {
            const response = await fetch(`/api/kb/${article.id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title: newValue }),
            });
            if (!response.ok) throw new Error("Failed to update article");

            updateVisibleArticlesOptimistically(currentArticles =>
              currentArticles.map(item =>
                item.id === article.id ? { ...item, title: newValue } : item
              )
            );
            setTitleOverrides(prev => ({ ...prev, [article.id]: newValue }));

            // If this is the active article being edited, update the shared atom too
            if (article.id === sharedActiveId) {
              setSharedActiveTitle(newValue);
            }
          }

          onRefresh();
        } catch (error) {
          console.error("Error updating:", error);
          toast.error(treeT("failedToUpdate"));
        } finally {
          setIsSaving(false);
          cancelEditing();
        }
      }
    },
    [
      state.editValue,
      cancelEditing,
      onRefresh,
      visibleArticles,
      updateVisibleArticlesOptimistically,
      setTitleOverrides,
      sharedActiveId,
      treeT,
    ]
  );

  const handleDeleteClick = useCallback(
    (itemId: string) => {
      const article = visibleArticles.find(a => a.id === itemId);
      if (article) {
        setDeleteTarget({
          id: article.id,
          title: article.title || treeT("untitled"),
        });
      }
    },
    [visibleArticles, treeT]
  );

  const handleDeleteConfirm = useCallback(() => {
    if (!deleteTarget) return;
    onDeleteArticle(deleteTarget.id);
    setDeleteTarget(null);
  }, [deleteTarget, onDeleteArticle]);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      if (isInteractionLocked) {
        return;
      }
      const { active, over } = event;

      if (!over || active.id === over.id) return;

      const activeData = active.data.current;
      const overData = over.data.current;

      if (!activeData || !overData) return;

      if (activeData.type === "article" && overData.type === "article") {
        const activeArticle = activeData.article as KBArticleData;
        const overArticle = overData.article as KBArticleData;

        if (activeArticle.parent_id !== overArticle.parent_id) {
          return;
        }

        const childArticles = getArticleChildren(activeArticle.parent_id);
        const oldIndex = childArticles.findIndex(a => a.id === active.id);
        const newIndex = childArticles.findIndex(a => a.id === over.id);

        if (oldIndex !== -1 && newIndex !== -1) {
          const previousArticles = visibleArticles;
          const reorderedArticles = [...childArticles];
          const [movedArticle] = reorderedArticles.splice(oldIndex, 1);
          reorderedArticles.splice(newIndex, 0, movedArticle);

          const items = reorderedArticles.map((a, index) => ({
            id: a.id,
            sort_order: index,
          }));

          const sortOrderById = new Map(
            items.map(item => [item.id, item.sort_order])
          );

          updateVisibleArticlesOptimistically(currentArticles =>
            currentArticles.map(item => {
              const nextSortOrder = sortOrderById.get(item.id);
              if (nextSortOrder === undefined) return item;
              return { ...item, sort_order: nextSortOrder };
            })
          );

          try {
            const response = await fetch("/api/kb/reorder", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ type: "article", items }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
              throw new Error(payload.error || "Failed to reorder");
            }
            onRefresh();
          } catch (error) {
            setOptimisticArticles(previousArticles);
            console.error("Error reordering articles:", error);
            const message =
              error instanceof Error ? error.message : treeT("failedToReorder");
            toast.error(message);
          }
        }
      }
    },
    [
      getArticleChildren,
      isInteractionLocked,
      onRefresh,
      visibleArticles,
      setOptimisticArticles,
      updateVisibleArticlesOptimistically,
      treeT,
    ]
  );

  const renderArticle = useCallback(
    (article: KBArticleData, level: number): ReactNode => {
      const childArticles = getArticleChildren(article.id);

      return (
        <SortableArticleItem
          key={article.id}
          article={article}
          level={level}
          state={state}
          currentArticleId={currentArticleId}
          isSaving={isSaving}
          isInteractionLocked={isInteractionLocked}
          childArticles={childArticles}
          onToggleExpanded={toggleExpanded}
          onSelectArticle={onSelectArticle}
          onStartEditing={startEditing}
          onCancelEditing={cancelEditing}
          onEditKeyDown={handleEditKeyDown}
          onCreateArticle={onCreateArticle}
          onDelete={handleDeleteClick}
          editInputRef={editInputRef}
          renderArticle={renderArticle}
          treeT={treeT}
        />
      );
    },
    [
      getArticleChildren,
      state,
      currentArticleId,
      isSaving,
      isInteractionLocked,
      toggleExpanded,
      onSelectArticle,
      startEditing,
      cancelEditing,
      handleEditKeyDown,
      onCreateArticle,
      handleDeleteClick,
      treeT,
    ]
  );

  // Get root articles (parent_id = null)
  const rootArticles = useMemo(
    () => buildArticleTree(visibleArticles, null),
    [visibleArticles]
  );

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={rootArticles.map(article => article.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-0.5">
            {rootArticles.map(article => renderArticle(article, 0))}
          </div>
        </SortableContext>
      </DndContext>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={open => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{treeT("deleteConfirm")}</AlertDialogTitle>
            <AlertDialogDescription>
              {treeT("deleteConfirmDescription") ||
                "This permanently deletes the article and its translations."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{treeT("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {treeT("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

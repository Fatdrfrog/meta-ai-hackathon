"use client";

import { convertContentToHtml } from "@/lib/kb/content-utils";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useKBEntityEditor } from "@/hooks/use-kb-entity-editor";
import { isLocale, type Locale } from "@/i18n/locales";
import { companySlugAtom } from "@/lib/navigation/company-slug-state";
import {
  kbArticleActiveTitleAtom,
  kbArticleEditorIsPublishingAtom,
  kbArticleEditorPublishHandlerAtom,
  kbArticleEditorSaveStatusAtom,
  kbArticleEditorStatusAtom,
  kbArticlePublishModeAtom,
  kbArticleRoutePendingAtom,
  kbArticleRouteTargetIdAtom,
  kbArticleSaveDraftBeforeNavigateAtom,
  kbArticleTitleOverridesAtom,
  kbTreeRefreshCallbackAtom,
} from "@/lib/kb/kb-editor-state";
import {
  dispatchKbChunkPreviewRedraw,
  kbChunkPreviewController,
} from "@/lib/kb/kb-chunk-preview-controller";
import { shouldHydrateKBEditorEntity } from "@/lib/kb/kb-editor-hydration";
import { getKBEditorRagPreviewClassNames } from "@/lib/kb/kb-editor-rag-preview-ui";
import {
  ensureKBGoogleFontsLoaded,
  extractKBGoogleFontFamilies,
} from "@/lib/kb/kb-google-fonts";
import {
  areKBLocalizationMetadataEqual,
  normalizeKBLocale,
  upsertKBLocalizationMetadata,
  type KBArticleLocalizationMeta,
} from "@/lib/kb/kb-localization-actions";
import {
  getKBEffectiveArticleTitle,
  isKBPlaceholderTitle,
} from "@/lib/kb/kb-title-overrides";
import {
  buildMarkdownImport,
  isMarkdownImportFile,
} from "@/lib/kb/markdown-import";
import type { EditorView } from "@tiptap/pm/view";
import { EditorContent } from "@tiptap/react";
import { useAtomValue, useSetAtom } from "jotai";
import { AlertCircle, Check, Clock3, Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { toast } from "sonner";
import {
  buildKBDraftUpdatePayload,
  createKBDraftSnapshot,
  isKBDraftSnapshotCurrent,
  normalizeEditorHtml,
  type KBDraftSnapshot,
} from "./article-editor-draft-state";
import { getKBEditorSaveStatusText } from "./article-editor-save-status";
import { useKBArticleEditor } from "./kb-article-editor-context";
import { KBArticleLanguageControl } from "./kb-article-language-control";
import { KBEditorContextMenu } from "./kb-editor-context-menu";
import { KBEditorLayout } from "./kb-editor-layout";
import { KBEditorChunkHeadingHint, KBEditorMenus } from "./kb-editor-menus";
import { LinkEditDialog } from "./link-edit-dialog";
import { PublishDropdown } from "./publish-dropdown";

type KbApiErrorBody = {
  error?: string;
};

function kbApiErrorMessage(body: unknown, fallback: string): string {
  const error =
    body && typeof body === "object" && "error" in body
      ? (body as KbApiErrorBody).error
      : undefined;
  return typeof error === "string" && error.trim() ? error : fallback;
}

async function readKbApiJson<T>(
  response: Response,
  fallbackError: string
): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(kbApiErrorMessage(body, fallbackError));
  }
  return (await response.json()) as T;
}

type Props = {
  parentArticleId?: string;
  breadcrumbSlot?: React.ReactNode;
  initial?: {
    id?: string;
    title?: string;
    content_mdx?: string;
    status?: string;
    published_at?: string | null;
    is_featured?: boolean | null;
    locale?: Locale;
    defaultLocale?: Locale;
    availableLocales?: readonly string[];
    localizations?: readonly KBArticleLocalizationMeta[];
    hasLocalization?: boolean;
  };
};

const KBEditorTitleInput = memo(function KBEditorTitleInput({
  setTitle,
  placeholder,
  textareaRef,
  readOnly,
}: {
  setTitle: (val: string) => void;
  placeholder: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  readOnly: boolean;
}) {
  const title = useAtomValue(kbArticleActiveTitleAtom);
  const resizeVersionRef = useRef(0);

  const updateTitleHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const resizeVersion = resizeVersionRef.current + 1;
    resizeVersionRef.current = resizeVersion;
    textarea.style.height = "auto";
    const nextHeight = textarea.scrollHeight;

    queueMicrotask(() => {
      if (
        resizeVersionRef.current === resizeVersion &&
        textareaRef.current === textarea
      ) {
        textarea.style.height = `${nextHeight}px`;
      }
    });
  }, [textareaRef]);

  useEffect(() => {
    updateTitleHeight();
  }, [title, updateTitleHeight]);

  return (
    <textarea
      ref={textareaRef}
      value={title}
      onChange={e => setTitle(e.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      className="w-full text-4xl font-bold bg-transparent border-none outline-none placeholder:text-muted-foreground/50 mb-4 resize-none overflow-hidden min-h-[3rem] leading-tight disabled:cursor-not-allowed disabled:opacity-80"
      rows={1}
      readOnly={readOnly}
      disabled={readOnly}
    />
  );
});

const KB_CHUNK_PREVIEW_LS = "kb-editor-rag-chunk-preview";
const ragPreviewClassNames = getKBEditorRagPreviewClassNames();

const KBEditorSaveIndicator = memo(function KBEditorSaveIndicator({
  t,
}: {
  t: ReturnType<typeof useTranslations>;
}) {
  const saveStatus = useAtomValue(kbArticleEditorSaveStatusAtom);

  function getSaveStatusIcon() {
    switch (saveStatus) {
      case "saving":
        return <Loader2 className="size-4 animate-spin" />;
      case "saved":
        return <Check className="size-4 text-green-600" />;
      case "error":
        return <AlertCircle className="size-4 text-red-600" />;
      case "unsaved":
        return <Clock3 className="size-4 text-amber-600" />;
      default:
        return null;
    }
  }

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {getSaveStatusIcon()}
      <span>{getKBEditorSaveStatusText(saveStatus, t)}</span>
    </div>
  );
});

const KBEditorTitleRefSync = memo(function KBEditorTitleRefSync({
  titleRef,
  lastSyncedTitleRef,
}: {
  titleRef: RefObject<string>;
  lastSyncedTitleRef: RefObject<string>;
}) {
  const liveTitle = useAtomValue(kbArticleActiveTitleAtom);

  useEffect(() => {
    if (lastSyncedTitleRef.current === liveTitle) return;
    lastSyncedTitleRef.current = liveTitle;
    titleRef.current = liveTitle;
  }, [lastSyncedTitleRef, liveTitle, titleRef]);

  return null;
});

type SaveDraftOutcome = {
  id: string;
  snapshot: KBDraftSnapshot;
};

function findMarkdownImportFile(
  files: Iterable<File> | ArrayLike<File> | null | undefined
): File | undefined {
  if (!files) return undefined;
  return Array.from(files).find(file => isMarkdownImportFile(file));
}

const KBEditorBlockingLoader = memo(function KBEditorBlockingLoader({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-md">
      <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-6 animate-spin text-primary" />
        <span>{children}</span>
      </div>
    </div>
  );
});

function getPublishedLocalizationMeta({
  payload,
  fallbackLocale,
  defaultLocale,
}: {
  payload: unknown;
  fallbackLocale: Locale;
  defaultLocale: Locale;
}): KBArticleLocalizationMeta {
  const record =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  const locale = normalizeKBLocale(record.locale) ?? fallbackLocale;

  return {
    locale,
    status: typeof record.status === "string" ? record.status : "published",
    published_at:
      typeof record.published_at === "string" ? record.published_at : null,
    updated_at:
      typeof record.updated_at === "string" ? record.updated_at : null,
    hasDraft: false,
    isDefault:
      typeof record.isDefault === "boolean"
        ? record.isDefault
        : locale === defaultLocale,
  };
}

const ArticleEditorContent = memo(function ArticleEditorContent({
  parentArticleId,
  breadcrumbSlot,
  initial,
}: Props) {
  const params = useParams<{ workspaceId?: string }>();
  const workspaceId = params.workspaceId;
  const currentLocale = useLocale();
  const editorLocale: Locale =
    initial?.locale ?? (isLocale(currentLocale) ? currentLocale : "en");
  const defaultLocale = initial?.defaultLocale ?? "en";
  const editorEntityKey = `${initial?.id ?? "new"}:${editorLocale}`;
  const publishedLocalizationOverrideKey = `${initial?.id ?? "new"}:${editorLocale}`;
  const sync = useKBArticleEditor();
  const refreshTree = useAtomValue(kbTreeRefreshCallbackAtom);
  const companySlug = useAtomValue(companySlugAtom);
  const t = useTranslations("KnowledgeBase.articleEditor");
  const editorTranslations = useTranslations("EnhancedMarkdownEditor");
  const saveStatus = useAtomValue(kbArticleEditorSaveStatusAtom);
  const isPublishing = useAtomValue(kbArticleEditorIsPublishingAtom);
  const onPublish = useAtomValue(kbArticleEditorPublishHandlerAtom);
  const titleOverrides = useAtomValue(kbArticleTitleOverridesAtom);
  const setLiveTitle = useSetAtom(kbArticleActiveTitleAtom);
  const setTitleOverrides = useSetAtom(kbArticleTitleOverridesAtom);
  const setSaveBeforeNavigate = useSetAtom(
    kbArticleSaveDraftBeforeNavigateAtom
  );
  const setArticleStatus = useSetAtom(kbArticleEditorStatusAtom);
  const articleStatus = useAtomValue(kbArticleEditorStatusAtom);
  const publishMode = useAtomValue(kbArticlePublishModeAtom);
  const setPublishMode = useSetAtom(kbArticlePublishModeAtom);
  const isRoutePending = useAtomValue(kbArticleRoutePendingAtom);
  const pendingRouteTargetId = useAtomValue(kbArticleRouteTargetIdAtom);
  const setRoutePending = useSetAtom(kbArticleRoutePendingAtom);
  const setRouteTargetId = useSetAtom(kbArticleRouteTargetIdAtom);

  const [showRagChunkPreview, setShowRagChunkPreview] = useState(false);
  const [isImportingMarkdown, setIsImportingMarkdown] = useState(false);
  const [isUnpublishing, setIsUnpublishing] = useState(false);
  const [publishedLocalizationOverrides, setPublishedLocalizationOverrides] =
    useState<Record<string, KBArticleLocalizationMeta>>({});
  const serverInitialTitle = initial?.title ?? "";
  const effectiveInitialTitle = getKBEffectiveArticleTitle({
    articleId: initial?.id,
    initialTitle: initial?.title,
    titleOverrides,
  });
  const lastSyncedLiveTitleRef = useRef(effectiveInitialTitle);

  useEffect(() => {
    try {
      if (
        typeof window !== "undefined" &&
        localStorage.getItem(KB_CHUNK_PREVIEW_LS) === "1"
      ) {
        setShowRagChunkPreview(true);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const {
    setTitle: setEditorTitle,
    titleRef,
    getContent,
    editor,
    editorRef,
    isUploadingImage,
    setIsUploadingImage,
    titleTextareaRef,
    initialValuesRef,
    performSafeAction,
    registerPublishHandler,
    linkDialogOpen,
    setLinkDialogOpen,
    linkDialogUrl,
    linkDialogText,
    handleLinkEdit,
    handleLinkSave,
    registerAutoSaveHandler,
  } = useKBEntityEditor({
    initial: {
      title: effectiveInitialTitle,
      content_mdx: initial?.content_mdx,
    },
    entityKey: editorEntityKey,
    sync,
    placeholder: t("writeContentPlaceholder"),
  });

  const displayedLocalizations = useMemo(
    () =>
      upsertKBLocalizationMetadata(
        initial?.localizations ?? [],
        publishedLocalizationOverrides[publishedLocalizationOverrideKey]
      ),
    [
      initial?.localizations,
      publishedLocalizationOverrideKey,
      publishedLocalizationOverrides,
    ]
  );
  const currentLocalizationMeta = displayedLocalizations.find(
    localization => localization.locale === editorLocale
  );

  const hasLocalTitleChangesRef = useRef(false);
  const setTitle = useCallback(
    (nextTitle: string) => {
      hasLocalTitleChangesRef.current = true;
      setEditorTitle(nextTitle);
      if (showRagChunkPreview) {
        dispatchKbChunkPreviewRedraw(editor ?? null);
      }
    },
    [editor, setEditorTitle, showRagChunkPreview]
  );

  useEffect(() => {
    kbChunkPreviewController.enabled = showRagChunkPreview;
    kbChunkPreviewController.getArticleTitle = () =>
      titleRef.current.trim() || t("enterArticleTitle") || "Article";
    dispatchKbChunkPreviewRedraw(editor ?? null);
  }, [showRagChunkPreview, titleRef, editor, t]);

  const lastHydratedTitleEntityKeyRef = useRef<string | null>(null);

  // Hydrate title only when opening another article/locale. Same-route
  // revalidation can carry stale server props while the user is typing.
  useEffect(() => {
    const isDifferentEntity = shouldHydrateKBEditorEntity({
      lastHydratedEntityKey: lastHydratedTitleEntityKeyRef.current,
      nextEntityKey: editorEntityKey,
    });
    const nextTitle = effectiveInitialTitle;

    if (!isDifferentEntity && nextTitle === titleRef.current) {
      lastHydratedTitleEntityKeyRef.current = editorEntityKey;
      if (serverInitialTitle === titleRef.current) {
        hasLocalTitleChangesRef.current = false;
      }
      return;
    }

    if (!isDifferentEntity && hasLocalTitleChangesRef.current) {
      return;
    }

    lastHydratedTitleEntityKeyRef.current = editorEntityKey;
    hasLocalTitleChangesRef.current = false;
    setLiveTitle(nextTitle);
    lastSyncedLiveTitleRef.current = nextTitle;
    titleRef.current = nextTitle;
    initialValuesRef.current.title = nextTitle;
  }, [
    editorEntityKey,
    effectiveInitialTitle,
    serverInitialTitle,
    setLiveTitle,
    titleRef,
    initialValuesRef,
  ]);

  useEffect(() => {
    setArticleStatus(initial?.status ?? null);
  }, [initial?.status, setArticleStatus]);

  useEffect(() => {
    if (initial?.status !== "published") {
      setPublishMode("public_with_auto_link");
      return;
    }
    if (!initial?.published_at) {
      setPublishMode("ai_context_only");
      return;
    }
    setPublishMode(
      initial?.is_featured
        ? "public_without_auto_link"
        : "public_with_auto_link"
    );
  }, [
    initial?.is_featured,
    initial?.published_at,
    initial?.status,
    setPublishMode,
  ]);

  const lastPersistedTitleRef = useRef(effectiveInitialTitle);
  const lastPersistedContentRef = useRef(
    normalizeEditorHtml(convertContentToHtml(initial?.content_mdx))
  );
  const rememberPersistedDraftSnapshot = useCallback(
    (snapshot: KBDraftSnapshot) => {
      initialValuesRef.current = {
        title: snapshot.title,
        content: snapshot.content,
      };
      lastPersistedTitleRef.current = snapshot.title;
      lastPersistedContentRef.current = snapshot.normalizedContent;
    },
    [initialValuesRef]
  );

  const [articleId, setArticleId] = useState<string | undefined>(initial?.id);
  const articleIdRef = useRef<string | undefined>(initial?.id);

  const setCurrentArticleId = useCallback((nextArticleId?: string) => {
    articleIdRef.current = nextArticleId;
    setArticleId(nextArticleId);
  }, []);

  useEffect(() => {
    setCurrentArticleId(initial?.id);
  }, [initial?.id, setCurrentArticleId]);

  useEffect(() => {
    lastPersistedTitleRef.current = effectiveInitialTitle;
    lastPersistedContentRef.current = normalizeEditorHtml(
      convertContentToHtml(initial?.content_mdx)
    );
  }, [effectiveInitialTitle, initial?.content_mdx]);

  useEffect(() => {
    ensureKBGoogleFontsLoaded(
      extractKBGoogleFontFamilies(convertContentToHtml(initial?.content_mdx))
    );
  }, [initial?.content_mdx]);

  useEffect(() => {
    if (!initial?.id || !isRoutePending || !pendingRouteTargetId) return;
    if (pendingRouteTargetId === initial.id) {
      setRoutePending(false);
      setRouteTargetId(null);
    }
  }, [
    initial?.id,
    isRoutePending,
    pendingRouteTargetId,
    setRoutePending,
    setRouteTargetId,
  ]);

  // Sync active article ID to atom
  useEffect(() => {
    sync.setActiveId?.(articleId || null);
    // Also sync the title to the atom when switching articles
    if (articleId) {
      sync.setActiveTitle?.(titleRef.current);
    }
  }, [articleId, sync.setActiveId, sync.setActiveTitle, titleRef]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const markdownFileInputRef = useRef<HTMLInputElement | null>(null);

  const saveDraft = useCallback(
    async (isSilent = false): Promise<string | undefined> => {
      let nextSaveIsSilent = isSilent;

      while (true) {
        const result = await performSafeAction(
          async (): Promise<SaveDraftOutcome | undefined> => {
            const currentTitle = titleRef.current;
            if (!currentTitle.trim()) {
              if (!nextSaveIsSilent) toast.error("Title is required");
              return undefined;
            }

            const snapshot = createKBDraftSnapshot(currentTitle, getContent());
            const currentArticleId = articleIdRef.current;

            if (!currentArticleId) {
              const res = await fetch(`/api/kb`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  title: snapshot.title,
                  content_mdx: snapshot.content,
                  parent_id: parentArticleId || null,
                  locale: editorLocale,
                }),
              });
              let data: { article?: { id?: string; status?: string } };
              try {
                data = await readKbApiJson(res, "Failed to create article");
              } catch (error) {
                const errorMsg =
                  error instanceof Error
                    ? error.message
                    : "Failed to create article";
                if (!nextSaveIsSilent) toast.error(errorMsg);
                throw error instanceof Error ? error : new Error(errorMsg);
              }
              const newId = data.article?.id;
              if (!newId) {
                throw new Error(
                  "Create article response is missing article id"
                );
              }

              setCurrentArticleId(newId);
              if (data.article?.status) {
                setArticleStatus(data.article.status);
              } else {
                setArticleStatus("draft");
              }

              const currentPath = window.location.pathname;
              const newUrl = currentPath.replace(/\/[^/]+$/, `/${newId}`);
              window.history.replaceState(
                { ...window.history.state, as: newUrl, url: newUrl },
                "",
                newUrl
              );

              rememberPersistedDraftSnapshot(snapshot);
              setTitleOverrides(prev => ({ ...prev, [newId]: snapshot.title }));

              try {
                await refreshTree?.();
              } catch (revalidateError) {
                console.error(
                  "Failed to revalidate KB tree after article create:",
                  revalidateError
                );
              }

              return {
                id: newId,
                snapshot,
              };
            }

            const draftUpdate = buildKBDraftUpdatePayload({
              previousTitle: lastPersistedTitleRef.current,
              previousNormalizedContent: lastPersistedContentRef.current,
              snapshot,
            });

            if (!draftUpdate.hasChanges) {
              return {
                id: currentArticleId,
                snapshot,
              };
            }

            const updatePayload: {
              locale: Locale;
              title?: string;
              content_mdx?: string;
            } = { locale: editorLocale, ...draftUpdate.payload };

            const res = await fetch(`/api/kb/${currentArticleId}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(updatePayload),
            });
            let data: { success?: boolean; error?: string };
            try {
              data = await readKbApiJson(res, "Failed to update article");
            } catch (error) {
              sync.setSaveStatus("error");
              const errorMsg =
                error instanceof Error
                  ? error.message
                  : "Failed to update article";
              if (!nextSaveIsSilent) toast.error(errorMsg);
              throw error instanceof Error ? error : new Error(errorMsg);
            }

            if (!data.success) {
              sync.setSaveStatus("error");
              const errorMsg = data.error || "Failed to update article";
              if (!nextSaveIsSilent) toast.error(errorMsg);
              throw new Error(errorMsg);
            }

            rememberPersistedDraftSnapshot(snapshot);
            setTitleOverrides(prev => ({
              ...prev,
              [currentArticleId]: snapshot.title,
            }));

            if (draftUpdate.hasTitleChanged) {
              try {
                await refreshTree?.();
              } catch (revalidateError) {
                console.error(
                  "Failed to revalidate KB tree after article title update:",
                  revalidateError
                );
              }
            }

            return {
              id: currentArticleId,
              snapshot,
            };
          },
          { isSilent: nextSaveIsSilent }
        );

        if (!result) {
          return undefined;
        }

        const latestSnapshot = createKBDraftSnapshot(
          titleRef.current,
          getContent()
        );

        if (isKBDraftSnapshotCurrent(result.snapshot, latestSnapshot)) {
          rememberPersistedDraftSnapshot(result.snapshot);
          sync.setSaveStatus("saved");
          return result.id;
        }

        sync.setSaveStatus("unsaved");
        nextSaveIsSilent = true;
      }
    },
    [
      articleIdRef,
      getContent,
      performSafeAction,
      parentArticleId,
      initialValuesRef,
      lastPersistedContentRef,
      lastPersistedTitleRef,
      rememberPersistedDraftSnapshot,
      titleRef,
      sync,
      setCurrentArticleId,
      setArticleStatus,
      setTitleOverrides,
      refreshTree,
      editorLocale,
    ]
  );

  const handleImageUpload = useCallback(
    async (files: FileList) => {
      if (!files || files.length === 0) return;

      const file = files[0];
      if (!file.type.startsWith("image/")) {
        toast.error("Please select an image file (JPEG, PNG, GIF, WebP)");
        return;
      }

      if (!articleId) {
        toast.error("Please save the article first before uploading images");
        return;
      }

      setIsUploadingImage(true);

      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("title", file.name);

        const res = await fetch(`/api/kb/${articleId}/images`, {
          method: "POST",
          body: formData,
        });
        const data = await readKbApiJson<{
          attachment?: { file_url?: string };
        }>(res, "Failed to upload image");
        const fileUrl = data.attachment?.file_url;
        if (!fileUrl) {
          throw new Error("Failed to upload image");
        }

        const editorInstance = editorRef.current;
        if (editorInstance) {
          editorInstance
            .chain()
            .focus()
            .setImage({ src: fileUrl, alt: file.name })
            .run();
        }
        toast.success("Image uploaded successfully");
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : "Failed to upload image. Please try again.";
        toast.error(errorMessage);
      } finally {
        setIsUploadingImage(false);
      }
    },
    [articleId, saveDraft, editorRef]
  );

  const handleImageUploadRef = useRef(handleImageUpload);
  const handleMarkdownImport = useCallback(
    async (file: File) => {
      if (!isMarkdownImportFile(file)) {
        toast.error("Please select a Markdown file (.md or .markdown)");
        return;
      }

      const editorInstance = editorRef.current;
      if (!editorInstance) {
        toast.error("Editor is not ready yet");
        return;
      }

      setIsImportingMarkdown(true);
      try {
        const result = await buildMarkdownImport(file);
        const shouldSetTitle =
          !titleRef.current.trim() &&
          !normalizeEditorHtml(editorInstance.getHTML());

        editorInstance.chain().focus().insertContent(result.html).run();

        if (shouldSetTitle && result.title) {
          setTitle(result.title);
        }

        toast.success(
          `${editorTranslations("importMarkdownSuccess") || "Markdown imported"}: ${
            result.sourceName
          }`
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : "Failed to import Markdown file";
        toast.error(errorMessage);
      } finally {
        setIsImportingMarkdown(false);
      }
    },
    [editorRef, editorTranslations, setTitle, titleRef]
  );

  const handleMarkdownImportRef = useRef(handleMarkdownImport);
  useEffect(() => {
    handleImageUploadRef.current = handleImageUpload;
    handleMarkdownImportRef.current = handleMarkdownImport;
    if (editor) {
      editor.setOptions({
        editorProps: {
          handleDrop: (_view: EditorView, event: DragEvent) => {
            const files = event.dataTransfer?.files;
            if (files && files.length > 0) {
              const firstFile = files[0];
              if (firstFile?.type.startsWith("image/")) {
                event.preventDefault();
                void handleImageUploadRef.current(files);
                return true;
              }

              const markdownFile = findMarkdownImportFile(files);
              if (markdownFile) {
                event.preventDefault();
                void handleMarkdownImportRef.current(markdownFile);
                return true;
              }
            }
            return false;
          },
          handlePaste: (_view: EditorView, event: ClipboardEvent) => {
            if (!event.clipboardData) return false;
            const files: File[] = [];
            for (const item of Array.from(event.clipboardData.items)) {
              const file = item.getAsFile();
              if (file && file.type.startsWith("image/")) {
                files.push(file);
              }
            }
            if (files.length > 0) {
              const dataTransfer = new DataTransfer();
              files.forEach(file => dataTransfer.items.add(file));
              void handleImageUploadRef.current(dataTransfer.files);
              return true;
            }

            const markdownFile = findMarkdownImportFile(
              event.clipboardData.files
            );
            if (markdownFile) {
              event.preventDefault();
              void handleMarkdownImportRef.current(markdownFile);
              return true;
            }

            const pastedText = event.clipboardData.getData("text/plain").trim();
            if (pastedText) {
              const insertedYoutube = editor
                .chain()
                .focus()
                .setYoutubeVideo({ src: pastedText })
                .run();

              if (insertedYoutube) {
                event.preventDefault();
                return true;
              }
            }

            return false;
          },
        },
      });
    }
  }, [handleImageUpload, handleMarkdownImport, editor]);

  const publish = useCallback(async () => {
    if (isKBPlaceholderTitle(titleRef.current)) {
      toast.error(t("titleRequired") || "Add a title before publishing");
      return;
    }

    const id = await saveDraft(false);
    if (!id) {
      toast.error(t("saveFirst") || "Please save the article first");
      return;
    }
    setCurrentArticleId(id);

    const publishOutcome = await performSafeAction(
      async () => {
        try {
          const publishingTitle = titleRef.current;
          const publishingSnapshot = createKBDraftSnapshot(
            publishingTitle,
            getContent()
          );

          const res = await fetch(`/api/kb/${id}/publish`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ publishMode, locale: editorLocale }),
          });
          let data: {
            publishedLocalization?: unknown;
            isFirstPublishedInWorkspace?: boolean;
            error?: string;
          };
          try {
            data = await readKbApiJson(res, "Failed to publish");
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "Failed to publish";
            toast.error(errorMessage);
            sync.setSaveStatus("error");
            throw error instanceof Error ? error : new Error(errorMessage);
          }
          initialValuesRef.current = {
            title: publishingSnapshot.title,
            content: publishingSnapshot.content,
          };

          const latestSnapshot = createKBDraftSnapshot(
            titleRef.current,
            getContent()
          );
          if (isKBDraftSnapshotCurrent(publishingSnapshot, latestSnapshot)) {
            sync.setSaveStatus("saved");
          } else {
            sync.setSaveStatus("unsaved");
            void saveDraft(true);
          }

          const publishedLocalization = getPublishedLocalizationMeta({
            payload: data?.publishedLocalization,
            fallbackLocale: editorLocale,
            defaultLocale,
          });
          setPublishedLocalizationOverrides(prev => {
            if (
              areKBLocalizationMetadataEqual(
                prev[publishedLocalizationOverrideKey],
                publishedLocalization
              )
            ) {
              return prev;
            }

            return {
              ...prev,
              [publishedLocalizationOverrideKey]: publishedLocalization,
            };
          });
          setArticleStatus("published");
          toast.success(
            t("publishSuccess") || "Article published successfully"
          );

          if (data?.isFirstPublishedInWorkspace && workspaceId) {
            const settingsPath = `/panel/w/${workspaceId}/settings/ai-context`;
            toast.success(
              t("firstPublishOnboardingTitle") || "Knowledge base is live",
              {
                description:
                  t("firstPublishOnboardingDescription", { settingsPath }) ||
                  `Enable Airi bot for all chats in Settings -> AI controls: ${settingsPath}`,
              }
            );
          }

          await refreshTree?.();
        } catch (error) {
          sync.setSaveStatus("error");
          toast.error(
            `Failed to publish: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          throw error;
        }
      },
      { isPublish: true }
    );
    if (publishOutcome === null) {
      return;
    }
  }, [
    saveDraft,
    t,
    getContent,
    performSafeAction,
    setCurrentArticleId,
    titleRef,
    sync,
    refreshTree,
    setArticleStatus,
    publishMode,
    workspaceId,
    editorLocale,
    defaultLocale,
    publishedLocalizationOverrideKey,
  ]);

  const unpublish = useCallback(async () => {
    const id = articleIdRef.current;
    if (!id) {
      toast.error(t("saveFirst") || "Please save the article first");
      return;
    }

    const savedId = await saveDraft(true);
    if (!savedId) {
      return;
    }

    setIsUnpublishing(true);
    try {
      const res = await fetch(
        `/api/kb/${id}/localizations/${editorLocale}/unpublish`,
        { method: "POST" }
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(kbApiErrorMessage(data, "Failed to unpublish"));
      }

      setArticleStatus("draft");
      setPublishedLocalizationOverrides(prev => ({
        ...prev,
        [publishedLocalizationOverrideKey]: {
          locale: editorLocale,
          status: "draft",
          published_at: null,
          updated_at: new Date().toISOString(),
          hasDraft: true,
          isDefault: editorLocale === defaultLocale,
        },
      }));
      toast.success(t("unpublishSuccess") || "Unpublished this language");
      await refreshTree?.();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t("unpublishFailed") || "Could not unpublish";
      toast.error(message);
      throw error;
    } finally {
      setIsUnpublishing(false);
    }
  }, [
    t,
    saveDraft,
    editorLocale,
    defaultLocale,
    publishedLocalizationOverrideKey,
    refreshTree,
    setArticleStatus,
  ]);

  const saveBeforeNavigate = useCallback(async (): Promise<boolean> => {
    const savedId = await saveDraft(false);
    return Boolean(savedId);
  }, [saveDraft]);

  useEffect(() => {
    setSaveBeforeNavigate(() => saveBeforeNavigate);
    return () => setSaveBeforeNavigate(null);
  }, [saveBeforeNavigate, setSaveBeforeNavigate]);

  useEffect(() => {
    registerPublishHandler(publish);
    registerAutoSaveHandler(isSilent => saveDraft(isSilent).then(() => {}));
  }, [publish, saveDraft, registerPublishHandler, registerAutoSaveHandler]);

  useEffect(() => {
    if (typeof window === "undefined" || isRoutePending) return;

    const handleSaveShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== "s") return;

      event.preventDefault();
      void saveDraft(false);
    };

    window.addEventListener("keydown", handleSaveShortcut);
    return () => {
      window.removeEventListener("keydown", handleSaveShortcut);
    };
  }, [isRoutePending, saveDraft]);

  useEffect(() => {
    if (!editor) return;
    if (isRoutePending) {
      editor.commands.blur();
    }
  }, [editor, isRoutePending]);

  useEffect(() => {
    const hasPendingChanges =
      saveStatus === "unsaved" || saveStatus === "saving";

    if (!hasPendingChanges || typeof window === "undefined") {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [saveStatus]);

  const showUnifiedLoader = isRoutePending || !editor;

  return (
    <KBEditorLayout
      statusIndicatorSlot={<KBEditorSaveIndicator t={t} />}
      titleSlot={
        <>
          {breadcrumbSlot}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <KBArticleLanguageControl
              articleId={articleId}
              currentLocale={editorLocale}
              defaultLocale={defaultLocale}
              localizations={displayedLocalizations}
              hasLocalization={initial?.hasLocalization !== false}
              saveBeforeNavigate={saveBeforeNavigate}
              onLocalizationChanged={refreshTree ?? undefined}
              companySlug={companySlug}
            />
            <PublishDropdown
              onPublish={onPublish || undefined}
              isPublishing={isPublishing}
              saveStatus={saveStatus}
              publishMode={publishMode}
              onPublishModeChange={setPublishMode}
              articleId={articleId}
              articleStatus={currentLocalizationMeta?.status ?? articleStatus}
              locale={editorLocale}
              hasLocaleDraft={Boolean(currentLocalizationMeta?.hasDraft)}
              onUnpublish={unpublish}
              isUnpublishing={isUnpublishing}
            />
          </div>
          <KBEditorTitleInput
            setTitle={setTitle}
            placeholder={t("enterArticleTitle") || "Untitled"}
            textareaRef={titleTextareaRef}
            readOnly={isRoutePending}
          />
        </>
      }
      dialogsSlot={
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={event => {
              if (event.target.files) {
                void handleImageUpload(event.target.files);
              }
              event.target.value = "";
            }}
            disabled={isUploadingImage}
          />
          <input
            ref={markdownFileInputRef}
            type="file"
            accept=".md,.markdown,text/markdown,text/x-markdown"
            className="hidden"
            onChange={event => {
              const file = event.target.files?.[0];
              if (file) {
                void handleMarkdownImport(file);
              }
              event.target.value = "";
            }}
            disabled={isImportingMarkdown}
          />
          <LinkEditDialog
            open={linkDialogOpen}
            onOpenChange={setLinkDialogOpen}
            initialUrl={linkDialogUrl}
            initialText={linkDialogText}
            onSave={handleLinkSave}
          />
        </>
      }
    >
      <KBEditorTitleRefSync
        titleRef={titleRef}
        lastSyncedTitleRef={lastSyncedLiveTitleRef}
      />
      {editor ? (
        <>
          <KBEditorMenus
            editor={editor}
            enableTables={true}
            enableImages={true}
            enableUndoRedo={true}
            enableJustify={true}
            isUploadingImage={isUploadingImage}
            isImportingMarkdown={isImportingMarkdown}
            onImageClick={() => fileInputRef.current?.click()}
            onMarkdownImportClick={() => markdownFileInputRef.current?.click()}
            onLinkEdit={handleLinkEdit}
          />
          <div className={ragPreviewClassNames.container}>
            <div className={ragPreviewClassNames.row}>
              <div className={ragPreviewClassNames.toggleGroup}>
                <Checkbox
                  id="kb-rag-chunk-preview"
                  className={ragPreviewClassNames.checkbox}
                  checked={showRagChunkPreview}
                  onCheckedChange={value => {
                    const next = value === true;
                    setShowRagChunkPreview(next);
                    try {
                      localStorage.setItem(
                        KB_CHUNK_PREVIEW_LS,
                        next ? "1" : "0"
                      );
                    } catch {
                      /* ignore */
                    }
                  }}
                />
                <Label
                  htmlFor="kb-rag-chunk-preview"
                  className={ragPreviewClassNames.label}
                >
                  {t("chunkPreview.label")}
                </Label>
              </div>
              <p className={ragPreviewClassNames.hint}>
                {t("chunkPreview.hint")}
              </p>
            </div>
            {showRagChunkPreview ? (
              <KBEditorChunkHeadingHint editor={editor} />
            ) : null}
          </div>
        </>
      ) : null}
      {editor ? (
        <KBEditorContextMenu
          editor={editor}
          disabled={isRoutePending}
          enableImages={true}
          isUploadingImage={isUploadingImage}
          onImageClick={() => fileInputRef.current?.click()}
        >
          <EditorContent
            editor={editor}
            className={`kb-editor min-h-[520px] prose prose-neutral dark:prose-invert max-w-none px-4 py-6 focus:outline-none ${
              isRoutePending ? "pointer-events-none select-none opacity-70" : ""
            }`}
          />
        </KBEditorContextMenu>
      ) : (
        <div className="h-[520px]" aria-hidden="true" />
      )}

      {showUnifiedLoader && (
        <KBEditorBlockingLoader>
          {t("loadingEditor") || "Opening article..."}
        </KBEditorBlockingLoader>
      )}

      {isUploadingImage && (
        <KBEditorBlockingLoader>
          {editorTranslations("uploadingImage")}
        </KBEditorBlockingLoader>
      )}

      {isImportingMarkdown && (
        <KBEditorBlockingLoader>
          {editorTranslations("importingMarkdown") || "Importing Markdown..."}
        </KBEditorBlockingLoader>
      )}
    </KBEditorLayout>
  );
});

export const ArticleEditor = ArticleEditorContent;

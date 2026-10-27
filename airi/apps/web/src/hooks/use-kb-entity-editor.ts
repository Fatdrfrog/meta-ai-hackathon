"use client";

import { type SaveStatus } from "@/components/kb/save-status-badge";
import { useKBEditor } from "@/hooks/use-kb-editor";
import { createKBEditorExtensions } from "@/lib/kb/editor-extensions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface SyncResult {
  setSaveStatus: (
    status: SaveStatus | ((prev: SaveStatus) => SaveStatus)
  ) => void;
  setActiveId?: (id: string | null) => void;
  setActiveTitle?: (title: string) => void;
  performSafeAction: <T>(
    action: () => Promise<T>,
    options?: { isPublish?: boolean; isSilent?: boolean }
  ) => Promise<T | null>;
  registerPublishHandler: (handler: () => Promise<void>) => void;
}

interface UseKBEntityEditorOptions {
  initial: {
    title?: string;
    content_mdx?: string;
  };
  entityKey?: string;
  sync: SyncResult;
  placeholder: string;
  enableTables?: boolean;
  minHeight?: number;
  proseClassName?: string;
}

export function useKBEntityEditor({
  initial,
  entityKey,
  sync,
  placeholder,
  enableTables = true,
  minHeight = 500,
  proseClassName = "prose prose-neutral dark:prose-invert max-w-none focus:outline-none px-4 py-6",
}: UseKBEntityEditorOptions) {
  const titleRef = useRef(initial.title || "");

  const [isUploadingImage, setIsUploadingImage] = useState(false);

  const onAutoSaveRef = useRef<((isSilent?: boolean) => Promise<void>) | null>(
    null
  );
  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);

  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkDialogUrl, setLinkDialogUrl] = useState("");
  const [linkDialogText, setLinkDialogText] = useState("");

  const titleTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const initialValuesRef = useRef({
    title: initial.title || "",
    content: "",
  });

  // Stable extensions
  const extensions = useMemo(
    () => createKBEditorExtensions({ placeholder, enableTables, minHeight }),
    [placeholder, enableTables, minHeight]
  );

  const { setSaveStatus } = sync;
  const handleSaveStatusChange = useCallback(
    (status: SaveStatus) => setSaveStatus(status),
    [setSaveStatus]
  );

  const triggerAutoSave = useCallback((isSilent = true) => {
    void onAutoSaveRef.current?.(isSilent);
  }, []);

  const scheduleAutoSave = useCallback(
    (delayMs = 2000, isSilent = true) => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      if (onAutoSaveRef.current) {
        autoSaveTimerRef.current = setTimeout(() => {
          triggerAutoSave(isSilent);
        }, delayMs);
      }
    },
    [triggerAutoSave]
  );

  const { editor, editorRef, getContent } = useKBEditor({
    initialContentMdx: initial.content_mdx || "",
    entityKey,
    extensions,
    proseClassName,
    onContentChange: html => {
      initialValuesRef.current.content = html;

      // useKBEditor already debounces content updates; avoid stacking another delay.
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      triggerAutoSave(true);
    },
    onSaveStatusChange: handleSaveStatusChange,
  });

  const registerAutoSaveHandler = useCallback(
    (handler: (isSilent?: boolean) => Promise<void>) => {
      onAutoSaveRef.current = handler;
    },
    []
  );

  useEffect(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, [entityKey]);

  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, []);

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      titleRef.current = newTitle;
      sync.setActiveTitle?.(newTitle);
      sync.setSaveStatus((prev: SaveStatus) =>
        prev === "saving" ? prev : "unsaved"
      );

      scheduleAutoSave(2000, true);
    },
    [scheduleAutoSave, sync]
  );

  // Link editing
  const handleLinkEdit = useCallback((url?: string, text?: string) => {
    setLinkDialogUrl(url || "");
    setLinkDialogText(text || "");
    setLinkDialogOpen(true);
  }, []);

  const handleLinkSave = useCallback(
    (url: string, text?: string) => {
      if (!editor) return;
      const normalizedUrl = url.trim();

      if (normalizedUrl) {
        const insertedYoutube = editor
          .chain()
          .focus()
          .setYoutubeVideo({ src: normalizedUrl })
          .run();

        if (insertedYoutube) {
          setLinkDialogOpen(false);
          return;
        }

        editor
          .chain()
          .focus()
          .extendMarkRange("link")
          .setLink({ href: normalizedUrl })
          .run();
        if (
          text &&
          text !== editor.state.selection.$anchor.parent.textContent
        ) {
          const { from, to } = editor.state.selection;
          editor.chain().focus().insertContentAt({ from, to }, text).run();
        }
      }
      setLinkDialogOpen(false);
    },
    [editor]
  );

  return {
    // State
    setTitle: handleTitleChange,
    titleRef,
    getContent,
    editor,
    editorRef,
    isUploadingImage,
    setIsUploadingImage,

    // Refs
    titleTextareaRef,
    initialValuesRef,

    // Sync
    ...sync,

    // Link Dialog
    linkDialogOpen,
    setLinkDialogOpen,
    linkDialogUrl,
    linkDialogText,
    handleLinkEdit,
    handleLinkSave,
    registerAutoSaveHandler,
  };
}

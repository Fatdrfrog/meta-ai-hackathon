"use client";

import { convertContentToHtml } from "@/lib/kb/content-utils";
import type { SaveStatus } from "@/components/kb/save-status-badge";
import { shouldHydrateKBEditorEntity } from "@/lib/kb/kb-editor-hydration";
import type { Editor, Extensions } from "@tiptap/react";
import { useEditor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef } from "react";

export interface UseKBEditorOptions {
  initialContentMdx: string;
  entityKey?: string;
  extensions: Extensions;
  onContentChange?: (html: string) => void;
  onSaveStatusChange?: (status: SaveStatus) => void;
  editorProps?: {
    handleDrop?: (view: unknown, event: DragEvent) => boolean;
    handlePaste?: (view: unknown, event: ClipboardEvent) => boolean;
    attributes?: Record<string, string>;
    [key: string]: unknown;
  };
  proseClassName?: string;
}

export interface UseKBEditorReturn {
  editor: Editor | null;
  getContent: () => string;
  isSettingContent: boolean;
  editorRef: React.RefObject<Editor | null>;
}

export function useKBEditor({
  initialContentMdx,
  entityKey = "__kb-editor__",
  extensions,
  onContentChange,
  onSaveStatusChange,
  editorProps,
  proseClassName = "prose prose-neutral dark:prose-invert max-w-none focus:outline-none",
}: UseKBEditorOptions): UseKBEditorReturn {
  const normalizedInitialContent = useMemo(
    () => convertContentToHtml(initialContentMdx),
    [initialContentMdx]
  );

  const editorRef = useRef<Editor | null>(null);
  const isSettingContentRef = useRef(false);
  const hasLocalChangesRef = useRef(false);
  const updateTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastHydratedEntityKeyRef = useRef<string | null>(null);

  // Store callbacks in refs to prevent them from causing re-renders
  const onContentChangeRef = useRef(onContentChange);
  const onSaveStatusChangeRef = useRef(onSaveStatusChange);

  // Update refs when callbacks change
  useEffect(() => {
    onContentChangeRef.current = onContentChange;
    onSaveStatusChangeRef.current = onSaveStatusChange;
  }, [onContentChange, onSaveStatusChange]);

  const editor = useEditor(
    {
      extensions,
      immediatelyRender: false,
      shouldRerenderOnTransaction: false,
      content: normalizedInitialContent || "<p></p>",
      editorProps: {
        attributes: {
          class: proseClassName,
          role: "textbox",
          "aria-label": "Editor content",
          "aria-multiline": "true",
          "data-placeholder":
            editorProps?.attributes?.["data-placeholder"] || "",
        },
        ...editorProps,
      },
      onUpdate({ editor }) {
        editorRef.current = editor;

        if (!isSettingContentRef.current) {
          hasLocalChangesRef.current = true;

          // Immediately notify of unsaved status
          onSaveStatusChangeRef.current?.("unsaved");

          // Debounce the content persistence
          if (updateTimerRef.current) {
            clearTimeout(updateTimerRef.current);
          }

          updateTimerRef.current = setTimeout(() => {
            const html = editor.getHTML();
            onContentChangeRef.current?.(html);
          }, 1000); // 1s debounce for content sync
        }
      },
    },
    [extensions] // Only include dependencies that affect editor configuration
  );

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (updateTimerRef.current) {
        clearTimeout(updateTimerRef.current);
      }
    };
  }, []);

  // Hydrate from server props unless the same article/locale has local edits.
  // Revalidating the same route can send older initial props while the user is
  // typing; reapplying them would overwrite active editor state.
  useEffect(() => {
    if (!editor) return;

    const isDifferentEntity = shouldHydrateKBEditorEntity({
      lastHydratedEntityKey: lastHydratedEntityKeyRef.current,
      nextEntityKey: entityKey,
    });

    // Normalize for comparison
    const normalizeHtml = (html: string) => {
      const trimmed = html.trim();
      if (
        trimmed === "" ||
        trimmed === "<p></p>" ||
        trimmed === "<p><br></p>"
      ) {
        return "";
      }
      return trimmed;
    };

    const targetHtml = normalizeHtml(normalizedInitialContent || "<p></p>");
    const currentHtml = normalizeHtml(editor.getHTML());

    if (targetHtml === currentHtml) {
      lastHydratedEntityKeyRef.current = entityKey;
      hasLocalChangesRef.current = false;
      return;
    }

    if (!isDifferentEntity && hasLocalChangesRef.current) {
      return;
    }

    try {
      isSettingContentRef.current = true;
      lastHydratedEntityKeyRef.current = entityKey;
      hasLocalChangesRef.current = false;

      // Use setContent with emitUpdate: false to prevent triggering onUpdate callback
      // This prevents the loop where setContent triggers onUpdate which updates state
      editor.commands.setContent(normalizedInitialContent || "<p></p>", {
        emitUpdate: false,
      });
    } finally {
      isSettingContentRef.current = false;
    }
  }, [editor, entityKey, normalizedInitialContent]);

  return {
    editor,
    getContent: useCallback(() => editor?.getHTML() || "", [editor]),
    isSettingContent: isSettingContentRef.current,
    editorRef,
  };
}

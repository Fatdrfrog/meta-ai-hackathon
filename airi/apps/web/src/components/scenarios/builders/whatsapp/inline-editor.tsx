"use client";

import {
  parseExactScenarioVariableSnippet,
  resolveScenarioTokenLabel,
} from "@/components/scenarios/view/scenario-template-utils";
import {
  serializeWhatsAppFlowText,
  type WhatsAppFlowTextFormat,
} from "@/lib/scenarios/whatsapp-flow-config";
import { cn } from "@/lib/utils";
import { textToEditorHtml } from "@/lib/whatsapp-format";
import Placeholder from "@tiptap/extension-placeholder";
import type { Extensions } from "@tiptap/react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import { WhatsAppInlineEditorFallback } from "./inline-editor-fallback";
import { WHATSAPP_INLINE_EDITOR_CONTENT_CLASS } from "./inline-editor-classes";
import { ScenarioVariableExtension } from "./scenario-variable-extension";

function createExtensions(placeholderText: string): Extensions {
  return [
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      link: false,
      listItem: false,
      orderedList: false,
      code: {},
    }),
    Placeholder.configure({
      placeholder: placeholderText,
      showOnlyWhenEditable: true,
    }),
    ScenarioVariableExtension,
  ];
}

export type WhatsAppInlineEditorInsertApi = {
  insertText: (text: string) => void;
  insertVariable: (token: string, label?: string) => void;
};

export type WhatsAppInlineEditorProps = {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  /** Accessible name. Callers pass a label, e.g. t("scenarioMessageEditorLabel"). */
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
  error?: string;
  outputFormat?: WhatsAppFlowTextFormat;
  /** When true, Enter creates newline. When false, single-line behavior. */
  multiline?: boolean;
  /** Optional handle for inserting text at the current caret. */
  onInsertApiChange?: (api: WhatsAppInlineEditorInsertApi | null) => void;
  /** Optional i18n resolver for variable chip labels. */
  resolveVariableLabel?: (token: string) => string;
};

export function WhatsAppInlineEditor({
  value,
  onChange,
  onBlur,
  ariaLabel,
  placeholder,
  className,
  error,
  outputFormat = "whatsapp",
  multiline = true,
  onInsertApiChange,
  resolveVariableLabel,
}: WhatsAppInlineEditorProps) {
  const lastValueRef = useRef<string>(value);
  const errorId = useId();

  const resolveLabel = useCallback(
    (token: string) =>
      resolveVariableLabel?.(token) ?? resolveScenarioTokenLabel(token),
    [resolveVariableLabel]
  );

  const extensions = useMemo(
    () => createExtensions(placeholder ?? ""),
    [placeholder]
  );

  const toEditorHtml = useCallback(
    (nextValue: string) =>
      textToEditorHtml(nextValue, { resolveVariableLabel: resolveLabel }),
    [resolveLabel]
  );

  const editor = useEditor({
    extensions,
    content: toEditorHtml(value),
    editorProps: {
      attributes: {
        role: "textbox",
        ...(ariaLabel || placeholder
          ? { "aria-label": ariaLabel || placeholder || "" }
          : {}),
        "aria-multiline": String(multiline),
        "aria-invalid": String(Boolean(error)),
        ...(error ? { "aria-describedby": errorId } : {}),
        class: WHATSAPP_INLINE_EDITOR_CONTENT_CLASS,
      },
      handleKeyDown: (_, event) => {
        event.stopPropagation();
        if (!multiline && event.key === "Enter") {
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      const nextValue = serializeWhatsAppFlowText(
        editor.getHTML(),
        outputFormat
      );
      lastValueRef.current = nextValue;
      onChange(nextValue);
    },
    immediatelyRender: false,
  });

  useEffect(() => {
    if (!editor) return;
    const normalized = toEditorHtml(value);
    const current = editor.getHTML();
    const currentNorm = current.trim() || "<p></p>";
    const targetNorm = normalized.trim() || "<p></p>";
    if (currentNorm === targetNorm || lastValueRef.current === value) return;
    editor.commands.setContent(normalized, { emitUpdate: false });
    lastValueRef.current = value;
  }, [editor, toEditorHtml, value]);

  useEffect(() => {
    if (!onInsertApiChange) return;
    if (!editor) {
      onInsertApiChange(null);
      return;
    }

    const insertVariable = (token: string, label?: string) => {
      editor
        .chain()
        .focus()
        .insertScenarioVariable({
          token,
          label: label || resolveLabel(token),
        })
        .run();
    };

    onInsertApiChange({
      insertVariable,
      insertText: text => {
        const token = parseExactScenarioVariableSnippet(text);
        if (token) {
          insertVariable(token);
          return;
        }
        editor.chain().focus().insertContent(text).run();
      },
    });

    return () => {
      onInsertApiChange(null);
    };
  }, [editor, onInsertApiChange, resolveLabel]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
  }, []);

  // The editor exists only after its first effect: keep the text laid out
  // until then, so the node does not collapse and grow again.
  if (!editor) {
    return (
      <WhatsAppInlineEditorFallback
        value={value}
        placeholder={placeholder}
        className={className}
        error={error}
        resolveVariableLabel={resolveVariableLabel}
      />
    );
  }

  return (
    <div
      className="w-full"
      onPointerDown={handlePointerDown}
      onBlurCapture={onBlur}
    >
      <style>{`
        .whatsapp-inline-editor p.is-editor-empty:first-child::before,
        .whatsapp-inline-editor p.is-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          height: 0;
          pointer-events: none;
          color: inherit;
          opacity: 0.4;
        }
      `}</style>
      <div
        className={cn(
          "whatsapp-inline-editor w-full min-h-[1.5em] overflow-visible",
          "bg-transparent outline-none text-wrap break-words",
          error && "text-destructive",
          className
        )}
      >
        <EditorContent editor={editor} />
      </div>
      {error && (
        <p id={errorId} className="mt-0.5 text-[10px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { shouldPortalKbBlockTypeDropdown } from "@/lib/kb/editor-menu-positioning";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useCallback } from "react";

function formatShortcut(shortcut: string): string {
  if (typeof window === "undefined") return shortcut;
  const isMacOS = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  return shortcut
    .replace(/Mod-/g, isMacOS ? "⌘" : "Ctrl+")
    .replace(/Shift-/g, "Shift+")
    .replace(/Alt-/g, isMacOS ? "⌥" : "Alt+")
    .toUpperCase();
}

function applyBlockType(editor: Editor, target: "paragraph" | 1 | 2 | 3) {
  if (target === "paragraph") {
    editor.chain().focus().setParagraph().run();
    return;
  }
  if (editor.isActive("heading", { level: target })) {
    return;
  }
  editor.chain().focus().toggleHeading({ level: target }).run();
}

export interface KbBlockTypeDropdownProps {
  editor: Editor | null;
  /** Use compact trigger (e.g. floating menus) */
  compact?: boolean;
}

function KbBlockTypeDropdownLive({
  editor,
  compact,
}: {
  editor: Editor;
  compact: boolean;
}) {
  const t = useTranslations("EnhancedMarkdownEditor");

  const { labelKey } = useEditorState({
    editor,
    selector: ctx => {
      const e = ctx.editor;
      const active1 = e.isActive("heading", { level: 1 });
      const active2 = e.isActive("heading", { level: 2 });
      const active3 = e.isActive("heading", { level: 3 });
      let labelKey: "normalText" | "heading1" | "heading2" | "heading3" =
        "normalText";
      if (active1) labelKey = "heading1";
      else if (active2) labelKey = "heading2";
      else if (active3) labelKey = "heading3";
      return { labelKey };
    },
  });

  const onSelect = useCallback(
    (target: "paragraph" | 1 | 2 | 3) => {
      applyBlockType(editor, target);
    },
    [editor]
  );

  const triggerLabel =
    labelKey === "normalText"
      ? t("normalText")
      : labelKey === "heading1"
        ? t("heading1")
        : labelKey === "heading2"
          ? t("heading2")
          : t("heading3");

  const portalled = shouldPortalKbBlockTypeDropdown({ compact });

  return (
    <div
      className={
        compact
          ? "relative z-50 inline-flex max-w-full shrink-0"
          : "relative z-50 inline-flex max-w-full"
      }
    >
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            title={t("blockTypeHint")}
            onMouseDown={event => event.preventDefault()}
            className={
              compact
                ? "h-8 min-w-[7rem] justify-between px-2"
                : "h-8 min-w-[9rem] justify-between px-2"
            }
            aria-label={t("blockType")}
            aria-haspopup="menu"
          >
            <span className="truncate text-xs font-medium">{triggerLabel}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="start"
          className="w-52"
          portalled={portalled}
          side="bottom"
          sideOffset={6}
          onCloseAutoFocus={event => event.preventDefault()}
        >
          <DropdownMenuLabel>{t("blockType")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={event => {
              event.preventDefault();
              onSelect("paragraph");
            }}
          >
            <span className="flex w-full items-center justify-between gap-2">
              <span>{t("normalText")}</span>
              <span className="text-xs text-muted-foreground">
                {formatShortcut("Mod-Alt-0")}
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={event => {
              event.preventDefault();
              onSelect(1);
            }}
          >
            <span className="flex w-full items-center justify-between gap-2">
              <span>{t("heading1")}</span>
              <span className="text-xs text-muted-foreground">
                {formatShortcut("Mod-Alt-1")}
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={event => {
              event.preventDefault();
              onSelect(2);
            }}
          >
            <span className="flex w-full items-center justify-between gap-2">
              <span>{t("heading2")}</span>
              <span className="text-xs text-muted-foreground">
                {formatShortcut("Mod-Alt-2")}
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={event => {
              event.preventDefault();
              onSelect(3);
            }}
          >
            <span className="flex w-full items-center justify-between gap-2">
              <span>{t("heading3")}</span>
              <span className="text-xs text-muted-foreground">
                {formatShortcut("Mod-Alt-3")}
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export const KbBlockTypeDropdown = memo(function KbBlockTypeDropdown({
  editor,
  compact = false,
}: KbBlockTypeDropdownProps) {
  const t = useTranslations("EnhancedMarkdownEditor");

  if (!editor) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled
        className={
          compact
            ? "h-8 min-w-[7rem] justify-between px-2"
            : "h-8 min-w-[9rem] justify-between px-2"
        }
        aria-label={t("blockType")}
      >
        <span className="truncate text-xs">{t("normalText")}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </Button>
    );
  }

  return <KbBlockTypeDropdownLive editor={editor} compact={compact} />;
});

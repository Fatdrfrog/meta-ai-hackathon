"use client";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  getKBEditorContextMenuItems,
  runKBEditorContextMenuAction,
  shouldOpenKBEditorContextMenu,
  type KBEditorContextMenuItemId,
} from "@/lib/kb/kb-editor-context-menu";
import type { Editor } from "@tiptap/react";
import {
  Heading2,
  Heading3,
  Image as ImageIcon,
  LayoutGrid,
  List,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Table2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { ComponentType, MouseEvent, ReactNode } from "react";
import { Fragment, memo, useCallback } from "react";

const ICONS: Record<
  KBEditorContextMenuItemId,
  ComponentType<{ className?: string }>
> = {
  paragraph: Pilcrow,
  heading2: Heading2,
  heading3: Heading3,
  bulletList: List,
  orderedList: ListOrdered,
  blockquote: Quote,
  divider: Minus,
  uploadImage: ImageIcon,
  gridLayout: LayoutGrid,
  draftTable: Table2,
};

function focusEditorAtPoint(editor: Editor, clientX: number, clientY: number) {
  const posAtCoords = editor.view.posAtCoords({
    left: clientX,
    top: clientY,
  });
  const fallbackPos = editor.state.doc.content.size;
  const nextPos = Math.max(
    0,
    Math.min(posAtCoords?.pos ?? fallbackPos, fallbackPos)
  );

  try {
    editor.chain().focus().setTextSelection(nextPos).run();
  } catch {
    editor.commands.focus();
  }
}

export type KBEditorContextMenuProps = {
  editor: Editor;
  disabled?: boolean;
  enableImages?: boolean;
  isUploadingImage?: boolean;
  onImageClick?: () => void;
  children: ReactNode;
};

export const KBEditorContextMenu = memo(function KBEditorContextMenu({
  editor,
  disabled = false,
  enableImages = false,
  isUploadingImage = false,
  onImageClick,
  children,
}: KBEditorContextMenuProps) {
  const t = useTranslations("EnhancedMarkdownEditor");
  const items = getKBEditorContextMenuItems();

  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const insideExistingMenu = Boolean(
        target?.closest('[data-slot="context-menu-content"]')
      );
      const shouldOpen = shouldOpenKBEditorContextMenu({
        isEditable: editor.isEditable && !disabled,
        insideEditorSurface: Boolean(
          target && event.currentTarget.contains(target)
        ),
        insideExistingMenu,
      });

      if (!shouldOpen) {
        event.preventDefault();
        return;
      }

      focusEditorAtPoint(editor, event.clientX, event.clientY);
    },
    [disabled, editor]
  );

  const runAction = useCallback(
    (itemId: KBEditorContextMenuItemId) => {
      if (itemId === "uploadImage") {
        onImageClick?.();
        return;
      }

      runKBEditorContextMenuAction(editor, itemId);
    },
    [editor, onImageClick]
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={disabled || !editor.isEditable}>
        <div
          className="min-h-[520px]"
          onContextMenu={handleContextMenu}
          data-kb-editor-context-surface=""
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        alignOffset={-4}
        className="w-56 rounded-lg border-border/80 p-1.5 shadow-xl"
      >
        <ContextMenuLabel className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
          {t("contextMenuLabel")}
        </ContextMenuLabel>
        <ContextMenuSeparator />
        {items.map((item, index) => {
          const Icon = ICONS[item.id];
          const needsSeparator =
            (item.id === "uploadImage" || item.id === "draftTable") &&
            index > 0;
          const itemDisabled =
            item.id === "uploadImage" &&
            (!enableImages || !onImageClick || isUploadingImage);

          return (
            <Fragment key={item.id}>
              {needsSeparator ? <ContextMenuSeparator /> : null}
              <ContextMenuItem
                onSelect={() => runAction(item.id)}
                disabled={itemDisabled}
                className="min-h-9 cursor-pointer gap-3 rounded-md px-2 text-sm"
              >
                <Icon className="h-4 w-4 text-muted-foreground" />
                <span>{t(item.labelKey)}</span>
              </ContextMenuItem>
            </Fragment>
          );
        })}
      </ContextMenuContent>
    </ContextMenu>
  );
});

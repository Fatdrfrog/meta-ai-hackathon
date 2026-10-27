"use client";

import { KbBlockTypeDropdown } from "@/components/kb/kb-block-type-dropdown";
import { KBEditorTableBorderControls } from "@/components/kb/kb-editor-table-border-controls";
import { KBFontFamilyPicker } from "@/components/kb/kb-font-family-picker";
import { KBGridControls } from "@/components/kb/kb-grid-controls";
import { KBGridLayoutMenu } from "@/components/kb/kb-grid-layout-menu";
import { KBTextColorControls } from "@/components/kb/kb-text-color-controls";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Toggle } from "@/components/ui/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  shouldShowKbFloatingMenu,
  shouldShowKbTextBubbleMenu,
} from "@/lib/kb/editor-menu-positioning";
import type { Placement } from "@floating-ui/dom";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import type { EditorState } from "@tiptap/pm/state";
import { BubbleMenu, FloatingMenu } from "@tiptap/react/menus";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  FileUp,
  Image as ImageIcon,
  Italic,
  Link,
  List as ListIcon,
  ListOrdered,
  Loader2,
  Quote,
  Redo2,
  Undo2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { memo } from "react";

const menuBarClassName =
  "flex max-w-[calc(100vw-2rem)] items-center gap-1 overflow-visible rounded-lg border border-border/60 bg-background/95 p-1 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80";

const menuFallbackPlacements: Placement[] = [
  "top-start",
  "top",
  "bottom-start",
  "bottom",
];

const menuOptions = {
  placement: "top-start" as const,
  strategy: "fixed" as const,
  offset: 12,
  flip: {
    fallbackPlacements: menuFallbackPlacements,
  },
  shift: { padding: 8 },
};

function bubbleMenuShouldShow(props: {
  editor: Editor;
  state: EditorState;
}): boolean {
  const { editor: currentEditor, state } = props;
  const selectedText = state.doc
    .textBetween(state.selection.from, state.selection.to, " ")
    .trim();
  return shouldShowKbTextBubbleMenu({
    isEditable: currentEditor.isEditable,
    isFocused: currentEditor.isFocused,
    selectionEmpty: state.selection.empty,
    isTableActive: currentEditor.isActive("table"),
    selectedText,
  });
}

function floatingMenuShouldShow(props: {
  editor: Editor;
  state: EditorState;
}): boolean {
  const { editor: currentEditor, state } = props;
  const { $anchor } = state.selection;
  const node = $anchor.parent;
  return shouldShowKbFloatingMenu({
    isEditable: currentEditor.isEditable,
    isFocused: currentEditor.isFocused,
    selectionEmpty: state.selection.empty,
    isTableActive: currentEditor.isActive("table"),
    parentNodeType: node.type.name,
    parentNodeContentSize: node.content.size,
  });
}

export interface KBEditorChunkHeadingHintProps {
  editor: Editor;
}

/** Shown when RAG chunk preview is on and the caret sits in a heading (starts a new chunk). */
export const KBEditorChunkHeadingHint = memo(function KBEditorChunkHeadingHint({
  editor,
}: KBEditorChunkHeadingHintProps) {
  const t = useTranslations("KnowledgeBase.articleEditor.chunkPreview");
  const { inHeading } = useEditorState({
    editor,
    selector: ctx => ({ inHeading: ctx.editor.isActive("heading") }),
  });
  if (!inHeading) return null;
  return (
    <p className="w-full text-xs font-medium text-amber-800 dark:text-amber-200/90">
      {t("headingLineHint")}
    </p>
  );
});

export interface KBEditorMenusProps {
  editor: Editor | null;
  enableTables?: boolean;
  enableImages?: boolean;
  enableUndoRedo?: boolean;
  enableJustify?: boolean;
  isUploadingImage?: boolean;
  isImportingMarkdown?: boolean;
  onImageClick?: () => void;
  onMarkdownImportClick?: () => void;
  onLinkEdit?: (currentUrl?: string, currentText?: string) => void;
}

export const KBEditorMenus = memo(function KBEditorMenus(
  props: KBEditorMenusProps
) {
  if (!props.editor) return null;
  return <KBEditorMenusInner {...props} editor={props.editor} />;
});

function KBEditorMenusInner({
  editor,
  enableTables = false,
  enableImages = false,
  enableUndoRedo = false,
  enableJustify = false,
  isUploadingImage = false,
  isImportingMarkdown = false,
  onImageClick,
  onMarkdownImportClick,
  onLinkEdit,
}: Omit<KBEditorMenusProps, "editor"> & { editor: Editor }) {
  const t = useTranslations("EnhancedMarkdownEditor");

  const {
    bold,
    italic,
    blockquote,
    bulletList,
    orderedList,
    link,
    alignLeft,
    alignCenter,
    alignRight,
    alignJustify,
    canAlignLeft,
    canAlignCenter,
    canAlignRight,
    canAlignJustify,
    canUndo,
    canRedo,
  } = useEditorState({
    editor,
    selector: ctx => ({
      bold: ctx.editor.isActive("bold"),
      italic: ctx.editor.isActive("italic"),
      blockquote: ctx.editor.isActive("blockquote"),
      bulletList: ctx.editor.isActive("bulletList"),
      orderedList: ctx.editor.isActive("orderedList"),
      link: ctx.editor.isActive("link"),
      alignLeft: ctx.editor.isActive({ textAlign: "left" }),
      alignCenter: ctx.editor.isActive({ textAlign: "center" }),
      alignRight: ctx.editor.isActive({ textAlign: "right" }),
      alignJustify: ctx.editor.isActive({ textAlign: "justify" }),
      canAlignLeft: ctx.editor.can().setTextAlign?.("left"),
      canAlignCenter: ctx.editor.can().setTextAlign?.("center"),
      canAlignRight: ctx.editor.can().setTextAlign?.("right"),
      canAlignJustify: ctx.editor.can().setTextAlign?.("justify"),
      canUndo: ctx.editor.can().undo(),
      canRedo: ctx.editor.can().redo(),
    }),
  });

  const bubbleBar = (
    <div className={menuBarClassName}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            size="sm"
            pressed={bold}
            onPressedChange={() => editor.chain().focus().toggleBold().run()}
            onMouseDown={event => event.preventDefault()}
            className="h-8 w-8 p-0"
            aria-label={t("bold") || "Bold"}
          >
            <Bold className="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t("bold")}</p>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            size="sm"
            pressed={italic}
            onPressedChange={() => editor.chain().focus().toggleItalic().run()}
            onMouseDown={event => event.preventDefault()}
            className="h-8 w-8 p-0"
            aria-label={t("italic") || "Italic"}
          >
            <Italic className="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t("italic")}</p>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            size="sm"
            pressed={link}
            onPressedChange={() => {
              if (editor.isActive("link")) {
                editor.chain().focus().unsetLink().run();
              } else {
                const attrs = editor.getAttributes("link");
                const currentUrl = attrs?.href || "";
                const currentText =
                  editor.state.selection.$anchor.parent.textContent || "";

                if (onLinkEdit) {
                  onLinkEdit(currentUrl, currentText);
                } else {
                  const url = window.prompt("Enter URL", currentUrl);
                  if (url) {
                    editor
                      .chain()
                      .focus()
                      .extendMarkRange("link")
                      .setLink({ href: url })
                      .run();
                  }
                }
              }
            }}
            onMouseDown={event => event.preventDefault()}
            className="h-8 w-8 p-0"
            aria-label={t("link") || "Link"}
          >
            <Link className="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t("link")}</p>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            size="sm"
            pressed={blockquote}
            onPressedChange={() =>
              editor.chain().focus().toggleBlockquote().run()
            }
            onMouseDown={event => event.preventDefault()}
            className="h-8 w-8 p-0"
            aria-label={t("quote") || "Quote"}
          >
            <Quote className="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t("quote")}</p>
        </TooltipContent>
      </Tooltip>

      {(enableImages || enableUndoRedo) && (
        <Separator orientation="vertical" className="h-6" />
      )}

      <KbBlockTypeDropdown editor={editor} compact />
      <KBFontFamilyPicker editor={editor} />
      <KBTextColorControls editor={editor} />
      <KBGridLayoutMenu editor={editor} />
      <KBGridControls editor={editor} />

      <Separator orientation="vertical" className="h-6" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            size="sm"
            pressed={bulletList}
            onPressedChange={() =>
              editor.chain().focus().toggleBulletList().run()
            }
            onMouseDown={event => event.preventDefault()}
            className="h-8 w-8 p-0"
            aria-label={t("bulletList") || "Bullet list"}
          >
            <ListIcon className="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t("bulletList")}</p>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            size="sm"
            pressed={orderedList}
            onPressedChange={() =>
              editor.chain().focus().toggleOrderedList().run()
            }
            onMouseDown={event => event.preventDefault()}
            className="h-8 w-8 p-0"
            aria-label={t("numberedList") || "Numbered list"}
          >
            <ListOrdered className="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t("numberedList")}</p>
        </TooltipContent>
      </Tooltip>

      <Separator orientation="vertical" className="h-6" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            size="sm"
            pressed={alignLeft}
            onPressedChange={() =>
              editor.chain().focus().setTextAlign("left").run()
            }
            disabled={!canAlignLeft}
            onMouseDown={event => event.preventDefault()}
            className="h-8 w-8 p-0"
            aria-label={t("alignLeft") || "Align left"}
          >
            <AlignLeft className="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t("alignLeft")}</p>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            size="sm"
            pressed={alignCenter}
            onPressedChange={() =>
              editor.chain().focus().setTextAlign("center").run()
            }
            disabled={!canAlignCenter}
            onMouseDown={event => event.preventDefault()}
            className="h-8 w-8 p-0"
            aria-label={t("alignCenter") || "Align center"}
          >
            <AlignCenter className="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t("alignCenter")}</p>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            size="sm"
            pressed={alignRight}
            onPressedChange={() =>
              editor.chain().focus().setTextAlign("right").run()
            }
            disabled={!canAlignRight}
            onMouseDown={event => event.preventDefault()}
            className="h-8 w-8 p-0"
            aria-label={t("alignRight") || "Align right"}
          >
            <AlignRight className="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t("alignRight")}</p>
        </TooltipContent>
      </Tooltip>

      {enableJustify && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle
              size="sm"
              pressed={alignJustify}
              onPressedChange={() =>
                editor.chain().focus().setTextAlign("justify").run()
              }
              disabled={!canAlignJustify}
              onMouseDown={event => event.preventDefault()}
              className="h-8 w-8 p-0"
              aria-label={t("alignJustify") || "Align justify"}
            >
              <AlignJustify className="h-4 w-4" />
            </Toggle>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t("alignJustify")}</p>
          </TooltipContent>
        </Tooltip>
      )}

      <Separator orientation="vertical" className="h-6" />

      {enableImages && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onMouseDown={event => event.preventDefault()}
              onClick={onImageClick}
              disabled={isUploadingImage}
              aria-label={t("uploadImage") || "Upload image"}
            >
              {isUploadingImage ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ImageIcon className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t("uploadImage")}</p>
          </TooltipContent>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onMouseDown={event => event.preventDefault()}
            onClick={onMarkdownImportClick}
            disabled={!onMarkdownImportClick || isImportingMarkdown}
            aria-label={t("importMarkdown") || "Import Markdown"}
          >
            {isImportingMarkdown ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileUp className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t("importMarkdown") || "Import Markdown"}</p>
        </TooltipContent>
      </Tooltip>

      {enableUndoRedo && (
        <>
          <Separator orientation="vertical" className="h-6" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onMouseDown={event => event.preventDefault()}
                onClick={() => editor.chain().focus().undo().run()}
                disabled={!canUndo}
                aria-label={t("undo") || "Undo"}
              >
                <Undo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("undo") || "Undo"}</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onMouseDown={event => event.preventDefault()}
                onClick={() => editor.chain().focus().redo().run()}
                disabled={!canRedo}
                aria-label={t("redo") || "Redo"}
              >
                <Redo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("redo") || "Redo"}</p>
            </TooltipContent>
          </Tooltip>
        </>
      )}
    </div>
  );

  const floatingBar = (
    <div className={menuBarClassName}>
      <KbBlockTypeDropdown editor={editor} compact />
      <KBFontFamilyPicker editor={editor} />
      <KBTextColorControls editor={editor} />
      <KBGridLayoutMenu editor={editor} />
      <KBGridControls editor={editor} />
      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            size="sm"
            pressed={bulletList}
            onPressedChange={() =>
              editor.chain().focus().toggleBulletList().run()
            }
            onMouseDown={event => event.preventDefault()}
            className="h-8 w-8 shrink-0 p-0"
            aria-label={t("bulletList") || "Bullet list"}
          >
            <ListIcon className="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t("bulletList")}</p>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            size="sm"
            pressed={orderedList}
            onPressedChange={() =>
              editor.chain().focus().toggleOrderedList().run()
            }
            onMouseDown={event => event.preventDefault()}
            className="h-8 w-8 shrink-0 p-0"
            aria-label={t("numberedList") || "Numbered list"}
          >
            <ListOrdered className="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t("numberedList")}</p>
        </TooltipContent>
      </Tooltip>

      <Separator orientation="vertical" className="h-6 shrink-0" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            size="sm"
            pressed={blockquote}
            onPressedChange={() =>
              editor.chain().focus().toggleBlockquote().run()
            }
            onMouseDown={event => event.preventDefault()}
            className="h-8 w-8 shrink-0 p-0"
            aria-label={t("quote") || "Quote"}
          >
            <Quote className="h-4 w-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t("quote")}</p>
        </TooltipContent>
      </Tooltip>

      {enableImages && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 shrink-0 p-0"
              onMouseDown={event => event.preventDefault()}
              onClick={onImageClick}
              disabled={isUploadingImage}
              aria-label={t("uploadImage") || "Upload image"}
            >
              {isUploadingImage ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ImageIcon className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t("uploadImage")}</p>
          </TooltipContent>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 shrink-0 p-0"
            onMouseDown={event => event.preventDefault()}
            onClick={onMarkdownImportClick}
            disabled={!onMarkdownImportClick || isImportingMarkdown}
            aria-label={t("importMarkdown") || "Import Markdown"}
          >
            {isImportingMarkdown ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileUp className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t("importMarkdown") || "Import Markdown"}</p>
        </TooltipContent>
      </Tooltip>

      {enableUndoRedo && (
        <>
          <Separator orientation="vertical" className="h-6 shrink-0" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 shrink-0 p-0"
                onMouseDown={event => event.preventDefault()}
                onClick={() => editor.chain().focus().undo().run()}
                disabled={!canUndo}
                aria-label={t("undo") || "Undo"}
              >
                <Undo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("undo") || "Undo"}</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 shrink-0 p-0"
                onMouseDown={event => event.preventDefault()}
                onClick={() => editor.chain().focus().redo().run()}
                disabled={!canRedo}
                aria-label={t("redo") || "Redo"}
              >
                <Redo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("redo") || "Redo"}</p>
            </TooltipContent>
          </Tooltip>
        </>
      )}
    </div>
  );

  return (
    <TooltipProvider>
      <BubbleMenu
        editor={editor}
        shouldShow={bubbleMenuShouldShow}
        options={menuOptions}
      >
        {bubbleBar}
      </BubbleMenu>
      <FloatingMenu
        editor={editor}
        shouldShow={floatingMenuShouldShow}
        options={menuOptions}
      >
        {floatingBar}
      </FloatingMenu>
      {enableTables ? <KBEditorTableBorderControls editor={editor} /> : null}
    </TooltipProvider>
  );
}

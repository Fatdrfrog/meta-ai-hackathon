import type { Editor } from "@tiptap/react";

export type KBEditorContextMenuItemId =
  | "paragraph"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "orderedList"
  | "blockquote"
  | "divider"
  | "uploadImage"
  | "gridLayout"
  | "draftTable";

export type KBEditorContextMenuItem = {
  id: KBEditorContextMenuItemId;
  labelKey: string;
};

export function shouldOpenKBEditorContextMenu({
  isEditable,
  insideEditorSurface,
  insideExistingMenu,
}: {
  isEditable: boolean;
  insideEditorSurface: boolean;
  insideExistingMenu: boolean;
}): boolean {
  return isEditable && insideEditorSurface && !insideExistingMenu;
}

export function getKBEditorContextMenuItems(): KBEditorContextMenuItem[] {
  return [
    { id: "paragraph", labelKey: "normalText" },
    { id: "heading2", labelKey: "heading2" },
    { id: "heading3", labelKey: "heading3" },
    { id: "bulletList", labelKey: "bulletList" },
    { id: "orderedList", labelKey: "numberedList" },
    { id: "blockquote", labelKey: "quote" },
    { id: "divider", labelKey: "divider" },
    { id: "uploadImage", labelKey: "uploadImage" },
    { id: "gridLayout", labelKey: "gridLayout" },
    { id: "draftTable", labelKey: "draftTable" },
  ];
}

export function runKBEditorContextMenuAction(
  editor: Editor,
  itemId: KBEditorContextMenuItemId
): boolean {
  const chain = editor.chain().focus();

  switch (itemId) {
    case "paragraph":
      return chain.setParagraph().run();
    case "heading2":
      return chain.toggleHeading({ level: 2 }).run();
    case "heading3":
      return chain.toggleHeading({ level: 3 }).run();
    case "bulletList":
      return chain.toggleBulletList().run();
    case "orderedList":
      return chain.toggleOrderedList().run();
    case "blockquote":
      return chain.toggleBlockquote().run();
    case "divider":
      return chain.setHorizontalRule().run();
    case "uploadImage":
      return false;
    case "gridLayout":
      return chain.insertKBGrid({ columns: 2 }).run();
    case "draftTable":
      return chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  }
}

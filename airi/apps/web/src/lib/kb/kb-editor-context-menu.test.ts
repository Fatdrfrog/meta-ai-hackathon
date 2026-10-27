import {
  getKBEditorContextMenuItems,
  runKBEditorContextMenuAction,
  shouldOpenKBEditorContextMenu,
} from "./kb-editor-context-menu";
import type { Editor } from "@tiptap/react";

describe("kb editor context menu", () => {
  test("opens only for editable editor surface context clicks", () => {
    expect(
      shouldOpenKBEditorContextMenu({
        isEditable: true,
        insideEditorSurface: true,
        insideExistingMenu: false,
      })
    ).toBe(true);

    expect(
      shouldOpenKBEditorContextMenu({
        isEditable: false,
        insideEditorSurface: true,
        insideExistingMenu: false,
      })
    ).toBe(false);

    expect(
      shouldOpenKBEditorContextMenu({
        isEditable: true,
        insideEditorSurface: false,
        insideExistingMenu: false,
      })
    ).toBe(false);

    expect(
      shouldOpenKBEditorContextMenu({
        isEditable: true,
        insideEditorSurface: true,
        insideExistingMenu: true,
      })
    ).toBe(false);
  });

  test("offers stable block insert items including draft table", () => {
    const items = getKBEditorContextMenuItems();
    const ids = items.map(item => item.id);

    expect(ids).toEqual([
      "paragraph",
      "heading2",
      "heading3",
      "bulletList",
      "orderedList",
      "blockquote",
      "divider",
      "uploadImage",
      "gridLayout",
      "draftTable",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(items.find(item => item.id === "draftTable")?.labelKey).toBe(
      "draftTable"
    );
    expect(items.find(item => item.id === "uploadImage")?.labelKey).toBe(
      "uploadImage"
    );
  });

  test("runs the expected editor command for draft tables, grids, and headings", () => {
    const run = jest.fn(() => true);
    const chain: Record<string, jest.Mock> = {
      focus: jest.fn(() => chain),
      setParagraph: jest.fn(() => chain),
      toggleHeading: jest.fn(() => chain),
      toggleBulletList: jest.fn(() => chain),
      toggleOrderedList: jest.fn(() => chain),
      toggleBlockquote: jest.fn(() => chain),
      setHorizontalRule: jest.fn(() => chain),
      insertKBGrid: jest.fn(() => chain),
      insertTable: jest.fn(() => chain),
      run,
    };
    const editor = {
      chain: jest.fn(() => chain),
    } as unknown as Editor;

    runKBEditorContextMenuAction(editor, "heading2");
    expect(chain.toggleHeading).toHaveBeenCalledWith({ level: 2 });

    runKBEditorContextMenuAction(editor, "draftTable");
    expect(chain.insertTable).toHaveBeenCalledWith({
      rows: 3,
      cols: 3,
      withHeaderRow: true,
    });

    runKBEditorContextMenuAction(editor, "gridLayout");
    expect(chain.insertKBGrid).toHaveBeenCalledWith({ columns: 2 });
  });
});

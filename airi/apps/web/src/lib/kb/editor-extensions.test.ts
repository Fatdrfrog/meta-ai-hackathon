jest.mock("lowlight", () => ({
  common: {},
  createLowlight: () => ({}),
}));

import { createKBEditorExtensions } from "./editor-extensions";
import {
  KB_EDITOR_DROP_CURSOR_CLASS_NAME,
  KB_EDITOR_INLINE_CODE_CLASS_NAME,
  KB_EDITOR_TABLE_CELL_CLASS_NAME,
  KB_EDITOR_TABLE_CLASS_NAME,
} from "./kb-editor-classes";

describe("createKBEditorExtensions", () => {
  it("configures inline code for backtick formatting with readable styling", () => {
    const starterKit = createKBEditorExtensions().find(
      extension => extension.name === "starterKit"
    );

    expect(starterKit?.options.code).toMatchObject({
      HTMLAttributes: {
        class: expect.stringContaining("kb-editor-inline-code"),
      },
    });
    expect(starterKit?.options.code.HTMLAttributes.class).toContain(
      KB_EDITOR_INLINE_CODE_CLASS_NAME
    );
  });

  it("configures a visible drop cursor for dragging image blocks", () => {
    const starterKit = createKBEditorExtensions().find(
      extension => extension.name === "starterKit"
    );

    expect(starterKit?.options.dropcursor).toMatchObject({
      class: KB_EDITOR_DROP_CURSOR_CLASS_NAME,
      width: 3,
    });
  });

  it("configures KB tables for visible border dragging", () => {
    const tableExtension = createKBEditorExtensions({
      enableTables: true,
    }).find(extension => extension.name === "table");

    expect(tableExtension?.options.resizable).toBe(true);
    expect(tableExtension?.options.lastColumnResizable).toBe(true);
    expect(tableExtension?.options.handleWidth).toBeGreaterThanOrEqual(6);
    expect(tableExtension?.options.cellMinWidth).toBeGreaterThanOrEqual(96);
    expect(tableExtension?.options.HTMLAttributes.class).toBe(
      KB_EDITOR_TABLE_CLASS_NAME
    );

    const tableCellExtension = createKBEditorExtensions({
      enableTables: true,
    }).find(extension => extension.name === "tableCell");

    expect(tableCellExtension?.options.HTMLAttributes.class).toBe(
      KB_EDITOR_TABLE_CELL_CLASS_NAME
    );
  });

  it("registers text style, color, font, and responsive grid extensions for article layout controls", () => {
    const extensionNames = createKBEditorExtensions({
      enableTables: true,
    }).map(extension => extension.name);

    expect(extensionNames).toContain("textStyle");
    expect(extensionNames).toContain("color");
    expect(extensionNames).toContain("backgroundColor");
    expect(extensionNames).toContain("fontFamily");
    expect(extensionNames).toContain("kbContainerDeleteShortcuts");
    expect(extensionNames).toContain("kbGrid");
    expect(extensionNames).toContain("kbGridColumn");
  });
});

import {
  KB_GRID_CSS,
  buildKBGridRenderAttributes,
  createKBGridContent,
  normalizeKBGridBorderStyle,
  normalizeKBGridBorderWidth,
  normalizeKBGridColumnCount,
} from "./kb-grid-extension";

describe("kb grid extension", () => {
  it("normalizes grid column presets to supported responsive layouts", () => {
    expect(normalizeKBGridColumnCount(2)).toBe(2);
    expect(normalizeKBGridColumnCount(3)).toBe(3);
    expect(normalizeKBGridColumnCount(4)).toBe(4);
    expect(normalizeKBGridColumnCount(1)).toBe(2);
    expect(normalizeKBGridColumnCount(10)).toBe(4);
  });

  it("creates empty editable columns for the requested grid preset", () => {
    expect(createKBGridContent({ columns: 3 })).toEqual({
      type: "kbGrid",
      attrs: { columns: 3, borderStyle: "subtle", borderWidth: 1 },
      content: [
        { type: "kbGridColumn", content: [{ type: "paragraph" }] },
        { type: "kbGridColumn", content: [{ type: "paragraph" }] },
        { type: "kbGridColumn", content: [{ type: "paragraph" }] },
      ],
    });
  });

  it("ships responsive grid CSS for editor and public article rendering", () => {
    expect(KB_GRID_CSS).toContain(".kb-editor-grid");
    expect(KB_GRID_CSS).toContain("grid-template-columns");
    expect(KB_GRID_CSS).toContain("@media (max-width: 640px)");
    expect(KB_GRID_CSS).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(KB_GRID_CSS).toContain("#8b5cf6");
  });

  it("normalizes grid border controls to safe persisted attributes", () => {
    expect(normalizeKBGridBorderStyle("solid")).toBe("solid");
    expect(normalizeKBGridBorderStyle("dashed")).toBe("dashed");
    expect(normalizeKBGridBorderStyle("none")).toBe("none");
    expect(normalizeKBGridBorderStyle("bogus")).toBe("subtle");

    expect(normalizeKBGridBorderWidth(1)).toBe(1);
    expect(normalizeKBGridBorderWidth(3)).toBe(3);
    expect(normalizeKBGridBorderWidth(99)).toBe(3);
  });

  it("renders border attributes and CSS variables for grid editing", () => {
    expect(
      buildKBGridRenderAttributes({
        columns: 4,
        borderStyle: "dashed",
        borderColor: "#ef4444",
        borderWidth: 2,
      })
    ).toMatchObject({
      "data-columns": 4,
      "data-border-style": "dashed",
      style: expect.stringContaining("--kb-grid-border-color: #ef4444"),
    });

    expect(KB_GRID_CSS).toContain("--kb-grid-border-color");
    expect(KB_GRID_CSS).toContain('[data-border-style="none"]');
  });
});

import {
  shouldPortalKbBlockTypeDropdown,
  shouldShowKbFloatingMenu,
  shouldShowKbTextBubbleMenu,
} from "./editor-menu-positioning";

describe("editor menu positioning", () => {
  test("does not show the floating toolbar on an empty paragraph", () => {
    expect(
      shouldShowKbFloatingMenu({
        isEditable: true,
        isFocused: true,
        selectionEmpty: true,
        isTableActive: false,
        parentNodeType: "paragraph",
        parentNodeContentSize: 0,
      })
    ).toBe(false);
  });

  test("does not show the floating toolbar for a cursor-only non-empty paragraph", () => {
    expect(
      shouldShowKbFloatingMenu({
        isEditable: true,
        isFocused: true,
        selectionEmpty: true,
        isTableActive: false,
        parentNodeType: "paragraph",
        parentNodeContentSize: 8,
      })
    ).toBe(false);
  });

  test("keeps compact block-type dropdown content anchored inside the bubble menu", () => {
    expect(shouldPortalKbBlockTypeDropdown({ compact: true })).toBe(false);
  });

  test("keeps regular block-type dropdown behavior unchanged", () => {
    expect(shouldPortalKbBlockTypeDropdown({ compact: false })).toBe(false);
  });

  test("shows selected-text bubble menu inside table cells", () => {
    expect(
      shouldShowKbTextBubbleMenu({
        isEditable: true,
        isFocused: true,
        selectionEmpty: false,
        isTableActive: true,
        selectedText: "Cell text",
      })
    ).toBe(true);
  });

  test("does not show selected-text bubble menu for empty selections", () => {
    expect(
      shouldShowKbTextBubbleMenu({
        isEditable: true,
        isFocused: true,
        selectionEmpty: true,
        isTableActive: false,
        selectedText: "",
      })
    ).toBe(false);
  });
});

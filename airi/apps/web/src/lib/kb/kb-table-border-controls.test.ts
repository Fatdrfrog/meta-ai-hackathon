import {
  buildKBTableBorderControlLayout,
  selectKBTableBorderTargetForPointer,
  type RectLike,
} from "./kb-table-border-controls";

describe("buildKBTableBorderControlLayout", () => {
  const tableRect: RectLike = {
    left: 100,
    top: 200,
    right: 500,
    bottom: 420,
    width: 400,
    height: 220,
  };
  const cellRect: RectLike = {
    left: 180,
    top: 250,
    right: 320,
    bottom: 330,
    width: 140,
    height: 80,
  };

  it("places row controls directly on the selected row borders", () => {
    const layout = buildKBTableBorderControlLayout({
      tableRect,
      cellRect,
      controlSize: 24,
      gap: 8,
    });

    expect(layout.addRowBefore).toMatchObject({
      actionId: "addRowBefore",
      left: 168,
      top: 238,
    });
    expect(layout.addRowAfter).toMatchObject({
      actionId: "addRowAfter",
      left: 168,
      top: 318,
    });
    expect(layout.deleteRow).toMatchObject({
      actionId: "deleteRow",
      left: 308,
      top: 278,
    });
  });

  it("places column controls directly on the selected column borders", () => {
    const layout = buildKBTableBorderControlLayout({
      tableRect,
      cellRect,
      controlSize: 24,
      gap: 8,
    });

    expect(layout.addColumnBefore).toMatchObject({
      actionId: "addColumnBefore",
      left: 168,
      top: 238,
    });
    expect(layout.addColumnAfter).toMatchObject({
      actionId: "addColumnAfter",
      left: 308,
      top: 238,
    });
    expect(layout.deleteColumn).toMatchObject({
      actionId: "deleteColumn",
      left: 238,
      top: 318,
    });
  });

  it("floats a row edit handle away from the pointer border", () => {
    const layout = buildKBTableBorderControlLayout({
      tableRect,
      cellRect,
      controlSize: 24,
      gap: 8,
    });

    const target = selectKBTableBorderTargetForPointer({
      layout,
      cellRect,
      pointerX: 220,
      pointerY: 251,
      threshold: 8,
    });

    expect(target?.controls.map(control => control.actionId)).toEqual([
      "addRowBefore",
      "deleteRow",
    ]);
    expect(target?.trigger).toMatchObject({
      left: 208,
      top: 214,
    });
  });

  it("floats a column edit handle away from the pointer border", () => {
    const layout = buildKBTableBorderControlLayout({
      tableRect,
      cellRect,
      controlSize: 24,
      gap: 8,
    });

    const target = selectKBTableBorderTargetForPointer({
      layout,
      cellRect,
      pointerX: 319,
      pointerY: 280,
      threshold: 8,
    });

    expect(target?.controls.map(control => control.actionId)).toEqual([
      "addColumnAfter",
      "deleteColumn",
    ]);
    expect(target?.trigger).toMatchObject({
      left: 344,
      top: 268,
    });
  });
});

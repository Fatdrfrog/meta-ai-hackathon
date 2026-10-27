import {
  KB_OBJECT_SELECTION_COLOR,
  buildKBAnchoredControlPosition,
  getKBObjectSelectionClassNames,
  getKBObjectResizeHandleClassName,
  type KBControlRect,
} from "./kb-object-controls";

describe("kb object controls", () => {
  const anchorRect: KBControlRect = {
    left: 240,
    top: 320,
    right: 640,
    bottom: 480,
    width: 400,
    height: 160,
  };

  it("anchors a control panel to the selected object instead of the viewport origin", () => {
    expect(
      buildKBAnchoredControlPosition({
        anchorRect,
        panelSize: { width: 224, height: 280 },
        viewport: { width: 1200, height: 900 },
        placement: "top-start",
        offset: 8,
      })
    ).toEqual({ left: 240, top: 32 });
  });

  it("flips and clamps controls into the viewport", () => {
    expect(
      buildKBAnchoredControlPosition({
        anchorRect: {
          left: -20,
          top: 12,
          right: 180,
          bottom: 80,
          width: 200,
          height: 68,
        },
        panelSize: { width: 260, height: 180 },
        viewport: { width: 320, height: 240 },
        placement: "top-start",
        offset: 8,
      })
    ).toEqual({ left: 8, top: 52 });
  });

  it("provides shared Canva-style selection chrome", () => {
    const classes = getKBObjectSelectionClassNames();

    expect(KB_OBJECT_SELECTION_COLOR).toBe("#8b5cf6");
    expect(classes.frame).toContain("kb-editor-object-selection-frame");
    expect(classes.frame).toContain("border-[#8b5cf6]");
    expect(classes.quickAction).toContain("kb-editor-object-quick-action");
    expect(classes.quickAction).toContain("bg-zinc-700");
    expect(classes.visible).toContain("block");
    expect(classes.visibleFlex).toContain("flex");
    expect(getKBObjectResizeHandleClassName("top-right")).toContain(
      "rounded-full"
    );
  });
});

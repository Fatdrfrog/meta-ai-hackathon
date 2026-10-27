import {
  KB_IMAGE_STACKING_CSS,
  buildKBImageRenderAttributes,
  calculateKBImageResize,
  getKBImageResizeControlClassNames,
  normalizeKBImageDimension,
} from "./kb-image-dimensions";

describe("kb image extension", () => {
  test("normalizes safe image dimensions for live editing", () => {
    expect(normalizeKBImageDimension("320")).toBe("320");
    expect(normalizeKBImageDimension("320px")).toBe("320px");
    expect(normalizeKBImageDimension("75%")).toBe("75%");
    expect(normalizeKBImageDimension("24rem")).toBe("24rem");
    expect(normalizeKBImageDimension("auto")).toBeNull();
    expect(normalizeKBImageDimension("")).toBeNull();
    expect(normalizeKBImageDimension("width:100%;color:red")).toBeNull();
  });

  test("renders dimensions as safe inline styles and data attributes", () => {
    expect(
      buildKBImageRenderAttributes({
        width: "320",
        height: "180px",
        class: "rounded-md",
      })
    ).toMatchObject({
      class: expect.stringContaining("kb-editor-image"),
      "data-width": "320",
      "data-height": "180px",
      style: "width: 320px; height: 180px;",
    });

    expect(
      buildKBImageRenderAttributes({
        width: "75%",
        height: null,
      })
    ).toMatchObject({
      "data-width": "75%",
      style: "width: 75%;",
    });
  });

  test("places Canva-style controls on each editable image", () => {
    const classes = getKBImageResizeControlClassNames();

    expect(classes.node).toContain("group");
    expect(classes.node).toContain("kb-editor-image-node");
    expect(classes.node).toContain("m-0");
    expect(classes.node).not.toContain("my-6");
    expect(classes.image).toContain("cursor-grab");
    expect(classes.frame).toContain("kb-editor-object-selection-frame");
    expect(classes.frame).toContain("absolute");
    expect(classes.quickAction).toContain("kb-editor-object-quick-action");
    expect(classes.quickAction).toContain("right-0");
    expect(classes.quickAction).toContain("top-0");
    expect(classes.visible).toContain("block");
    expect(classes.visibleFlex).toContain("flex");
    expect(classes.resizeHandle).toContain("kb-editor-image-resize-handle");
    expect(classes.resizeHandle).toContain("absolute");
    expect(classes.resizeHandle).toContain("rounded-full");
  });

  test("calculates freeform corner resizing with both dimensions and clamps tiny images", () => {
    expect(
      calculateKBImageResize({
        handle: "bottom-right",
        startWidth: 240,
        startHeight: 120,
        deltaX: 40,
        deltaY: 30,
      })
    ).toEqual({ width: "280px", height: "150px" });

    expect(
      calculateKBImageResize({
        handle: "top-left",
        startWidth: 240,
        startHeight: 120,
        deltaX: 40,
        deltaY: 30,
      })
    ).toEqual({ width: "200px", height: "90px" });

    expect(
      calculateKBImageResize({
        handle: "bottom-left",
        startWidth: 80,
        startHeight: 80,
        deltaX: 100,
        deltaY: -100,
      })
    ).toEqual({ width: "48px", height: "48px" });
  });

  test("allows consecutive images to stack in a row when their widths fit", () => {
    expect(KB_IMAGE_STACKING_CSS).toContain(".kb-editor .node-image");
    expect(KB_IMAGE_STACKING_CSS).toContain("display: inline-block");
    expect(KB_IMAGE_STACKING_CSS).toContain(".kb-editor > img.kb-editor-image");
    expect(KB_IMAGE_STACKING_CSS).toContain(
      ".kb-editor p > img.kb-editor-image"
    );
    expect(KB_IMAGE_STACKING_CSS).toContain("vertical-align: top");
  });
});

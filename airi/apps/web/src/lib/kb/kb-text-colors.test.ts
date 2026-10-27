import {
  getKBColorSwatches,
  readKBTextStyleColors,
  sanitizeKBColorValue,
} from "./kb-text-colors";

describe("KB text color utilities", () => {
  it("normalizes safe hex color values for persisted inline styles", () => {
    expect(sanitizeKBColorValue("#1D4ED8")).toBe("#1d4ed8");
    expect(sanitizeKBColorValue("#F0A")).toBe("#ff00aa");
  });

  it("rejects non-hex color values so picker input cannot inject CSS", () => {
    expect(sanitizeKBColorValue("red")).toBeNull();
    expect(sanitizeKBColorValue("url(javascript:alert(1))")).toBeNull();
    expect(sanitizeKBColorValue("var(--primary)")).toBeNull();
  });

  it("reads active text and highlight colors from textStyle attrs", () => {
    expect(
      readKBTextStyleColors({
        color: "#111827",
        backgroundColor: "#FEF3C7",
      })
    ).toEqual({
      textColor: "#111827",
      highlightColor: "#fef3c7",
    });
  });

  it("provides separate text and highlight swatches", () => {
    expect(getKBColorSwatches("text").length).toBeGreaterThan(6);
    expect(getKBColorSwatches("highlight").length).toBeGreaterThan(6);
    expect(getKBColorSwatches("text")).toContainEqual({
      label: "Slate",
      value: "#111827",
    });
    expect(getKBColorSwatches("highlight")).toContainEqual({
      label: "Yellow",
      value: "#fef3c7",
    });
  });
});

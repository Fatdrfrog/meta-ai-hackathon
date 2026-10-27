import {
  buildKBGoogleFontsStylesheetHref,
  extractKBGoogleFontFamilies,
  getKBGoogleFontOptions,
  sanitizeKBGoogleFontFamily,
} from "./kb-google-fonts";

describe("kb google fonts", () => {
  it("sanitizes Google font family names for inline style and stylesheet usage", () => {
    expect(sanitizeKBGoogleFontFamily("Open Sans")).toBe("Open Sans");
    expect(sanitizeKBGoogleFontFamily("  Roboto Slab  ")).toBe("Roboto Slab");
    expect(sanitizeKBGoogleFontFamily("Roboto; color:red")).toBeNull();
    expect(
      sanitizeKBGoogleFontFamily("url(https://example.com/font)")
    ).toBeNull();
  });

  it("builds a compact Google Fonts CSS2 URL for unique selected families", () => {
    expect(
      buildKBGoogleFontsStylesheetHref(["Open Sans", "Roboto", "Open Sans"])
    ).toBe(
      "https://fonts.googleapis.com/css2?family=Open+Sans&family=Roboto&display=swap"
    );
  });

  it("extracts used inline font families from saved KB article HTML", () => {
    expect(
      extractKBGoogleFontFamilies(
        '<p><span style="font-family: Open Sans">Hello</span><span style="font-family: Roboto, sans-serif">World</span></p>'
      )
    ).toEqual(["Open Sans", "Roboto"]);
  });

  it("exposes a broad searchable Google font list from metadata", () => {
    const options = getKBGoogleFontOptions();
    const families = options.map(option => option.family);

    expect(options.length).toBeGreaterThan(100);
    expect(families).toContain("Inter");
    expect(families).toContain("Roboto");
  });
});

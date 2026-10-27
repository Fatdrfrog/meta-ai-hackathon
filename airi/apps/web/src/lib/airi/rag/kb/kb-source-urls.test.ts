import { extractHttpUrlsFromKbSource } from "./kb-source-urls";

describe("kb-source-urls", () => {
  it("extracts markdown, href, and bare URLs with dedupe", () => {
    const raw = `
See [pricing](https://example.com/pricing) and https://example.com/faq#x
<a href="https://example.com/other">x</a>
`;
    const urls = extractHttpUrlsFromKbSource(raw);
    expect(urls).toContain("https://example.com/pricing");
    expect(urls).toContain("https://example.com/faq#x");
    expect(urls).toContain("https://example.com/other");
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("does not invent article URLs when body has no links", () => {
    expect(extractHttpUrlsFromKbSource("Text only")).toEqual([]);
  });
});

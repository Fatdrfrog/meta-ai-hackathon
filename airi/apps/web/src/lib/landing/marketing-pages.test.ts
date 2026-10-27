import {
  MARKETING_PAGE_IDS,
  createMarketingPageMetadata,
  findMarketingPageByPath,
  getMarketingPagePath,
  getMarketingPageSitemapEntries,
} from "./marketing-pages";

describe("product page URLs", () => {
  it("gives each language its own crawlable URL", () => {
    expect(getMarketingPagePath("mcp", "en")).toBe("/mcp");
    expect(getMarketingPagePath("mcp", "ru")).toBe("/mcp?locale=ru");
    expect(getMarketingPagePath("delivery", "kz")).toBe(
      "/whatsapp-marketing-delivery?locale=kz"
    );
    expect(findMarketingPageByPath("/meta-ads-mcp")).toBe("metaAds");
    expect(findMarketingPageByPath("/about")).toBeUndefined();
  });

  it("lists every page in every language with hreflang alternates", () => {
    const entries = MARKETING_PAGE_IDS.flatMap(getMarketingPageSitemapEntries);

    expect(entries).toHaveLength(9);
    for (const entry of entries) {
      expect(Object.keys(entry.alternates?.languages ?? {})).toEqual([
        "en",
        "ru",
        "kk",
        "x-default",
      ]);
    }
  });

  it("points canonical and alternates at the requested language", () => {
    const metadata = createMarketingPageMetadata({
      page: "delivery",
      locale: "ru",
      title: "Title",
      description: "Description",
    });

    expect(metadata.alternates?.canonical).toBe(
      "https://www.airi.chat/whatsapp-marketing-delivery?locale=ru"
    );
    expect(metadata.alternates?.languages).toMatchObject({
      kk: "https://www.airi.chat/whatsapp-marketing-delivery?locale=kz",
      "x-default": "https://www.airi.chat/whatsapp-marketing-delivery",
    });
    expect(metadata.openGraph?.locale).toBe("ru_RU");
  });
});

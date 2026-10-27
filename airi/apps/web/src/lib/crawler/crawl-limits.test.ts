import {
  CRAWL_INDEX_LIMITS,
  normalizeCrawlWebsiteSeeds,
  resolveEffectiveCrawlWebsiteSeeds,
  resolveCrawlBudget,
} from "@/lib/crawler/crawl-limits";

describe("crawler limits", () => {
  it("uses a fast default budget and clamps caller supplied page limits", () => {
    expect(resolveCrawlBudget({}).maxPagesPerSite).toBe(
      CRAWL_INDEX_LIMITS.defaultMaxPagesPerSite
    );

    expect(resolveCrawlBudget({ maxPagesPerSite: 999 }).maxPagesPerSite).toBe(
      CRAWL_INDEX_LIMITS.hardMaxPagesPerSite
    );

    expect(resolveCrawlBudget({ maxPagesPerSite: 0 }).maxPagesPerSite).toBe(1);
  });

  it("normalizes, deduplicates, and caps website crawl seeds", () => {
    expect(
      normalizeCrawlWebsiteSeeds([
        "example.com",
        "https://example.com/#top",
        "https://airi.chat",
        "https://docs.airi.chat",
        "https://blog.airi.chat",
        "https://extra.airi.chat",
      ])
    ).toEqual([
      "https://example.com/",
      "https://airi.chat/",
      "https://docs.airi.chat/",
      "https://blog.airi.chat/",
    ]);
  });

  it("uses the full indexed URL capacity when Instagram is excluded", () => {
    expect(
      resolveEffectiveCrawlWebsiteSeeds({
        websites: [
          "https://a.example",
          "https://b.example",
          "https://c.example",
          "https://d.example",
          "https://e.example",
          "https://f.example",
        ],
        includeInstagram: false,
      })
    ).toEqual([
      "https://a.example/",
      "https://b.example/",
      "https://c.example/",
      "https://d.example/",
      "https://e.example/",
    ]);
  });

  it("reserves the fifth indexed URL slot when Instagram is included", () => {
    expect(
      resolveEffectiveCrawlWebsiteSeeds({
        websites: [
          "https://a.example",
          "https://b.example",
          "https://c.example",
          "https://d.example",
          "https://e.example",
        ],
        includeInstagram: true,
      })
    ).toEqual([
      "https://a.example/",
      "https://b.example/",
      "https://c.example/",
      "https://d.example/",
    ]);
  });
});

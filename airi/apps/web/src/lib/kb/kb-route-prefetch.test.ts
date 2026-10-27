import {
  appendKBLocaleQuery,
  buildAdminKBArticleHref,
  buildKBArticleHrefs,
  buildPublicKBArticleHref,
  buildPublicKBLandingHref,
  prefetchKBArticleRoutes,
} from "./kb-route-prefetch";

describe("kb route prefetch helpers", () => {
  it("appends locale while preserving existing query params", () => {
    expect(appendKBLocaleQuery("/airichat/kb/article-1", "en")).toBe(
      "/airichat/kb/article-1?locale=en"
    );
    expect(appendKBLocaleQuery("/airichat/kb/article-1?q=refund", "ru")).toBe(
      "/airichat/kb/article-1?q=refund&locale=ru"
    );
    expect(appendKBLocaleQuery("/airichat/kb/article-1?locale=en", "kz")).toBe(
      "/airichat/kb/article-1?locale=kz"
    );
    expect(appendKBLocaleQuery("/airichat/kb/article-1", "  ")).toBe(
      "/airichat/kb/article-1"
    );
  });

  it("builds public KB landing hrefs", () => {
    expect(buildPublicKBLandingHref("airichat")).toBe("/airichat/kb");
    expect(buildPublicKBLandingHref("airichat", "ru")).toBe(
      "/airichat/kb?locale=ru"
    );
  });

  it("builds public and admin article hrefs", () => {
    expect(buildPublicKBArticleHref("airichat", "article-1")).toBe(
      "/airichat/kb/article-1"
    );
    expect(buildPublicKBArticleHref(undefined, "article-1")).toBe(
      "/kb/article-1"
    );
    expect(buildAdminKBArticleHref("workspace-1", "article-1")).toBe(
      "/panel/w/workspace-1/kb/article-1"
    );
    expect(buildAdminKBArticleHref("workspace-1", "article-1", "ru")).toBe(
      "/panel/w/workspace-1/kb/article-1?locale=ru"
    );
    expect(buildPublicKBArticleHref("airichat", "article-1", "en")).toBe(
      "/airichat/kb/article-1?locale=en"
    );
  });

  it("deduplicates and caps prefetched article routes", () => {
    const prefetch = jest.fn();

    prefetchKBArticleRoutes(
      { prefetch },
      ["/airichat/kb/a", "/airichat/kb/a", "/airichat/kb/b", "/airichat/kb/c"],
      2
    );

    expect(prefetch).toHaveBeenCalledTimes(2);
    expect(prefetch).toHaveBeenNthCalledWith(1, "/airichat/kb/a");
    expect(prefetch).toHaveBeenNthCalledWith(2, "/airichat/kb/b");
  });

  it("builds hrefs for article records", () => {
    expect(
      buildKBArticleHrefs(
        [{ id: "a" }, { id: "b" }],
        articleId => `/kb/${articleId}`
      )
    ).toEqual(["/kb/a", "/kb/b"]);
  });
});

import {
  getEffectiveKBArticleContent,
  getKBArticleUpdatedAt,
  getLatestKBArticleVersion,
  resolveActiveKBArticleContent,
} from "./article-content";

describe("article-content", () => {
  test("prefers draft content when it exists", () => {
    expect(
      getEffectiveKBArticleContent({
        draftContent: "# Draft",
        versions: [{ content_mdx: "# Published", version: 3 }],
      })
    ).toBe("# Draft");
  });

  test("falls back to the latest version content when draft content is missing", () => {
    expect(
      getEffectiveKBArticleContent({
        draftContent: null,
        versions: [
          { content_mdx: "# Old", version: 1 },
          { content_mdx: "# Latest", version: 4 },
        ],
      })
    ).toBe("# Latest");
  });

  test("supports a single embedded version object", () => {
    expect(
      getLatestKBArticleVersion({
        content_mdx: "# Single",
        version: 2,
        created_at: "2026-01-01T00:00:00.000Z",
      })
    ).toEqual({
      content_mdx: "# Single",
      version: 2,
      created_at: "2026-01-01T00:00:00.000Z",
    });
  });

  test("uses the latest version timestamp before the article timestamp", () => {
    expect(
      getKBArticleUpdatedAt({
        articleUpdatedAt: "2026-01-01T00:00:00.000Z",
        versions: [
          {
            content_mdx: "# Latest",
            version: 2,
            created_at: "2026-02-01T00:00:00.000Z",
          },
        ],
      })
    ).toBe("2026-02-01T00:00:00.000Z");
  });

  test("resolves default locale content from the canonical article draft or version", () => {
    expect(
      resolveActiveKBArticleContent({
        isDefaultLocale: true,
        article: {
          title: "Published title",
          draft_title: "Draft title",
          draft_content_mdx: null,
          status: "published",
          published_at: "2026-01-01T00:00:00.000Z",
          kb_article_versions: [
            { content_mdx: "# Old", version: 1 },
            { content_mdx: "# Latest", version: 3 },
          ],
        },
      })
    ).toEqual({
      title: "Draft title",
      content: "# Latest",
      status: "published",
      published_at: "2026-01-01T00:00:00.000Z",
    });
  });

  test("resolves translated content from localization draft or version", () => {
    expect(
      resolveActiveKBArticleContent({
        isDefaultLocale: false,
        article: {
          title: "Default title",
          status: "published",
          published_at: "2026-01-01T00:00:00.000Z",
          kb_article_versions: [{ content_mdx: "# Default", version: 1 }],
        },
        activeLocalization: {
          title: "Localized title",
          draft_title: null,
          draft_content_mdx: null,
          status: "published",
          published_at: "2026-02-01T00:00:00.000Z",
        },
        localizationVersion: [
          { content_mdx: "# Localized old", version: 1 },
          { content_mdx: "# Localized latest", version: 2 },
        ],
      })
    ).toEqual({
      title: "Localized title",
      content: "# Localized latest",
      status: "published",
      published_at: "2026-02-01T00:00:00.000Z",
    });
  });
});

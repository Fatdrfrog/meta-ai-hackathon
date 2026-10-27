import {
  getKBEffectiveArticleTitle,
  getKBTreeArticleLocaleState,
  getKBTreeArticleTitle,
  isKBDefaultArticleLocale,
  isKBPlaceholderTitle,
  pickKBArticleTitle,
  reconcileKBArticleTitleOverrides,
} from "./kb-title-overrides";

describe("kb title overrides", () => {
  it("keeps a local title override while fetched tree data is stale", () => {
    expect(
      reconcileKBArticleTitleOverrides({ "article-1": "New title" }, [
        { id: "article-1", title: "Old title" },
      ])
    ).toEqual({ "article-1": "New title" });
  });

  it("drops a local title override after fetched tree data catches up", () => {
    expect(
      reconcileKBArticleTitleOverrides({ "article-1": "New title" }, [
        { id: "article-1", title: "New title" },
      ])
    ).toEqual({});
  });

  it("drops overrides for deleted articles", () => {
    expect(
      reconcileKBArticleTitleOverrides({ "article-1": "New title" }, [
        { id: "article-2", title: "Other title" },
      ])
    ).toEqual({});
  });

  it("uses the local override as the effective editor title", () => {
    expect(
      getKBEffectiveArticleTitle({
        articleId: "article-1",
        initialTitle: "Old title",
        titleOverrides: { "article-1": "New title" },
      })
    ).toBe("New title");
  });

  it("treats null article default_locale as the resolved default locale", () => {
    expect(isKBDefaultArticleLocale("en", null)).toBe(true);
    expect(isKBDefaultArticleLocale("ru", null)).toBe(false);
  });

  it("ignores blank title candidates when choosing a display title", () => {
    expect(pickKBArticleTitle("  ", null, "Base title")).toBe("Base title");
  });

  it("treats empty and Untitled titles as placeholders", () => {
    expect(isKBPlaceholderTitle("")).toBe(true);
    expect(isKBPlaceholderTitle("   ")).toBe(true);
    expect(isKBPlaceholderTitle("Untitled")).toBe(true);
    expect(isKBPlaceholderTitle("untitled")).toBe(true);
    expect(isKBPlaceholderTitle("Getting started")).toBe(false);
  });

  it("uses the requested locale title for the admin tree when present", () => {
    expect(
      getKBTreeArticleTitle({
        article: {
          id: "article-1",
          title: "English published title",
          draft_title: null,
          default_locale: "en",
        },
        locale: "ru",
        localizations: [
          {
            article_id: "article-1",
            locale: "en",
            title: "English published title",
            draft_title: null,
          },
          {
            article_id: "article-1",
            locale: "ru",
            title: "Русский заголовок",
            draft_title: "Черновик",
          },
        ],
      })
    ).toBe("Черновик");
  });

  it("reports per-locale draft state for the admin tree", () => {
    expect(
      getKBTreeArticleLocaleState({
        article: {
          id: "article-1",
          title: "English published title",
          draft_title: null,
          default_locale: "en",
          status: "published",
        },
        locale: "ru",
        localizations: [
          {
            article_id: "article-1",
            locale: "ru",
            title: "Русский заголовок",
            draft_title: "Черновик",
            status: "published",
            draft_content_mdx: null,
          },
        ],
      })
    ).toEqual({ status: "published", hasDraft: true });
  });

  it("treats a non-default localization with a null status as draft", () => {
    expect(
      getKBTreeArticleLocaleState({
        article: {
          id: "article-1",
          title: "English published title",
          draft_title: null,
          default_locale: "en",
          status: "published",
        },
        locale: "ru",
        localizations: [
          {
            article_id: "article-1",
            locale: "ru",
            title: "Русский заголовок",
            draft_title: null,
            status: null,
            draft_content_mdx: null,
          },
        ],
      })
    ).toEqual({ status: "draft", hasDraft: false });
  });

  it("uses the default-locale localization title for the admin tree when the main article row is stale", () => {
    expect(
      getKBTreeArticleTitle({
        article: {
          id: "article-1",
          title: "Old published title",
          draft_title: null,
          default_locale: null,
        },
        localizations: [
          {
            article_id: "article-1",
            locale: "en",
            title: "Old localized title",
            draft_title: "New localized draft title",
          },
        ],
      })
    ).toBe("New localized draft title");
  });

  it("falls back to the main article draft title for the admin tree", () => {
    expect(
      getKBTreeArticleTitle({
        article: {
          id: "article-1",
          title: "Published title",
          draft_title: "Draft title",
          default_locale: "en",
        },
        localizations: [],
      })
    ).toBe("Draft title");
  });

  it("does not let blank default-locale localizations hide the admin tree title", () => {
    expect(
      getKBTreeArticleTitle({
        article: {
          id: "article-1",
          title: "Published title",
          draft_title: "Draft title",
          default_locale: "en",
        },
        localizations: [
          {
            article_id: "article-1",
            locale: "en",
            title: " ",
            draft_title: "",
          },
        ],
      })
    ).toBe("Draft title");
  });
});

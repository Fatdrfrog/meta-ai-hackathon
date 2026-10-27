import {
  areKBLocalizationMetadataEqual,
  buildKBLocalizationMetadata,
  getKBLocalizationDeleteError,
  getKBLocalizationUnpublishError,
  upsertKBLocalizationMetadata,
} from "./kb-localization-actions";

describe("KB localization actions", () => {
  it("keeps the default locale available for old articles without localization rows", () => {
    const metadata = buildKBLocalizationMetadata({
      defaultLocale: "en",
      articleStatus: "published",
      articlePublishedAt: "2026-05-01T10:00:00.000Z",
      articleDraftTitle: "Draft title",
      articleDraftContentMdx: null,
      rows: [
        {
          locale: "ru",
          status: "draft",
          published_at: null,
          updated_at: "2026-05-02T10:00:00.000Z",
          draft_title: null,
          draft_content_mdx: "<p>Draft</p>",
        },
      ],
    });

    expect(metadata).toEqual([
      {
        locale: "en",
        status: "published",
        published_at: "2026-05-01T10:00:00.000Z",
        updated_at: null,
        hasDraft: true,
        isDefault: true,
      },
      {
        locale: "ru",
        status: "draft",
        published_at: null,
        updated_at: "2026-05-02T10:00:00.000Z",
        hasDraft: true,
        isDefault: false,
      },
    ]);
  });

  it("does not mark published localizations as drafts when draft fields are empty", () => {
    const metadata = buildKBLocalizationMetadata({
      defaultLocale: "en",
      articleStatus: "published",
      articlePublishedAt: "2026-05-01T10:00:00.000Z",
      articleDraftTitle: null,
      articleDraftContentMdx: null,
      rows: [
        {
          locale: "en",
          status: "published",
          published_at: "2026-05-01T10:00:00.000Z",
          updated_at: "2026-05-02T10:00:00.000Z",
          draft_title: null,
          draft_content_mdx: null,
        },
        {
          locale: "ru",
          status: "published",
          published_at: "2026-05-01T10:00:00.000Z",
          updated_at: "2026-05-02T10:00:00.000Z",
        },
      ],
    });

    expect(metadata).toEqual([
      {
        locale: "en",
        status: "published",
        published_at: "2026-05-01T10:00:00.000Z",
        updated_at: "2026-05-02T10:00:00.000Z",
        hasDraft: false,
        isDefault: true,
      },
      {
        locale: "ru",
        status: "published",
        published_at: "2026-05-01T10:00:00.000Z",
        updated_at: "2026-05-02T10:00:00.000Z",
        hasDraft: false,
        isDefault: false,
      },
    ]);
  });

  it("rejects deleting default or last remaining localizations", () => {
    expect(
      getKBLocalizationDeleteError({
        targetLocale: "en",
        defaultLocale: "en",
        availableLocaleCount: 2,
      })
    ).toBe("Default language cannot be deleted");

    expect(
      getKBLocalizationDeleteError({
        targetLocale: "ru",
        defaultLocale: "en",
        availableLocaleCount: 1,
      })
    ).toBe("At least one language must remain");

    expect(
      getKBLocalizationDeleteError({
        targetLocale: "ru",
        defaultLocale: "en",
        availableLocaleCount: 2,
      })
    ).toBeNull();
  });

  it("rejects unpublishing the last published locale", () => {
    expect(
      getKBLocalizationUnpublishError({
        publishedLocaleCount: 1,
        targetStatus: "published",
      })
    ).toBe("At least one published language must remain");

    expect(
      getKBLocalizationUnpublishError({
        publishedLocaleCount: 2,
        targetStatus: "published",
      })
    ).toBeNull();

    expect(
      getKBLocalizationUnpublishError({
        publishedLocaleCount: 2,
        targetStatus: "draft",
      })
    ).toBe("Language is not published");
  });

  it("upserts a published locale without changing unchanged metadata references", () => {
    const localizations = [
      {
        locale: "en" as const,
        status: "draft",
        published_at: null,
        updated_at: null,
        hasDraft: true,
        isDefault: true,
      },
    ];
    const published = {
      locale: "en" as const,
      status: "published",
      published_at: "2026-05-19T12:00:00.000Z",
      updated_at: "2026-05-19T12:00:00.000Z",
      hasDraft: false,
      isDefault: true,
    };

    const updated = upsertKBLocalizationMetadata(localizations, published);

    expect(updated).toEqual([published]);
    expect(upsertKBLocalizationMetadata(updated, published)).toBe(updated);
    expect(areKBLocalizationMetadataEqual(updated[0], published)).toBe(true);
    expect(areKBLocalizationMetadataEqual(localizations[0], published)).toBe(
      false
    );
  });
});

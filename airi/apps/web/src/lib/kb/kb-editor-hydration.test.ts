import { shouldHydrateKBEditorEntity } from "./kb-editor-hydration";

describe("kb editor hydration", () => {
  it("hydrates the editor the first time an article locale is opened", () => {
    expect(
      shouldHydrateKBEditorEntity({
        lastHydratedEntityKey: null,
        nextEntityKey: "article-1:en",
      })
    ).toBe(true);
  });

  it("does not rehydrate the same article locale from refreshed server props", () => {
    expect(
      shouldHydrateKBEditorEntity({
        lastHydratedEntityKey: "article-1:en",
        nextEntityKey: "article-1:en",
      })
    ).toBe(false);
  });

  it("hydrates again when switching article or article locale", () => {
    expect(
      shouldHydrateKBEditorEntity({
        lastHydratedEntityKey: "article-1:en",
        nextEntityKey: "article-1:ru",
      })
    ).toBe(true);
  });
});

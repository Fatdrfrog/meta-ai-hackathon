import { readTemplateCarouselCountError } from "./template-carousel-errors";

describe("template-carousel-errors", () => {
  it("reads nested card field messages and ignores array errors without a message", () => {
    const errors = {
      0: {
        headerMediaExample: { message: "Need media" },
        bodyText: { message: "Need text" },
        buttons: {
          0: {
            text: { message: "Need label" },
            url: { message: "Need URL" },
          },
        },
      },
    };

    expect(readTemplateCarouselCountError(errors)).toBeUndefined();
  });

  it("reads a root carousel count message", () => {
    expect(
      readTemplateCarouselCountError({ message: "Need 2 to 10 cards" })
    ).toBe("Need 2 to 10 cards");
  });
});

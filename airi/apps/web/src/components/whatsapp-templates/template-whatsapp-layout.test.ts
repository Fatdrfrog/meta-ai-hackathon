import { createTemplateCarouselDraftCards } from "./template-carousel-model";
import {
  carouselCardsHaveUserContent,
  getWhatsAppMarketingLayout,
  standardLayoutHasExclusiveSections,
} from "./template-whatsapp-layout";

describe("template-whatsapp-layout", () => {
  it("treats carousel as a separate template shape", () => {
    expect(getWhatsAppMarketingLayout(false)).toBe("standard");
    expect(getWhatsAppMarketingLayout(true)).toBe("carousel");
  });

  it("detects exclusive standard sections that carousel cannot keep", () => {
    expect(
      standardLayoutHasExclusiveSections({
        hasHeader: false,
        hasFooter: false,
        hasButtons: false,
      })
    ).toBe(false);
    expect(
      standardLayoutHasExclusiveSections({
        hasHeader: true,
        hasFooter: false,
        hasButtons: false,
      })
    ).toBe(true);
    expect(
      standardLayoutHasExclusiveSections({
        hasHeader: false,
        hasFooter: true,
        hasButtons: false,
      })
    ).toBe(true);
    expect(
      standardLayoutHasExclusiveSections({
        hasHeader: false,
        hasFooter: false,
        hasButtons: true,
      })
    ).toBe(true);
  });

  it("ignores empty carousel drafts and flags filled card content", () => {
    expect(carouselCardsHaveUserContent(createTemplateCarouselDraftCards())).toBe(
      false
    );
    expect(
      carouselCardsHaveUserContent([
        {
          clientId: "card-1",
          headerFormat: "IMAGE",
          headerMediaExample: "https://cdn.example.com/card.png",
          bodyText: "",
          buttons: [{ clientId: "btn-1", type: "QUICK_REPLY", text: "" }],
        },
      ])
    ).toBe(true);
  });
});

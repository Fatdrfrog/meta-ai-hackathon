import { carouselTemplateValues } from "@/components/products/carousel-template-draft";
import { buildWhatsAppTemplateComponentsFromFormValues } from "@/components/whatsapp-templates/template-editor-form-utils";
import { parseWhatsAppTemplateSubmissionComponents } from "@/lib/whatsapp/templates/component-schemas";
import {
  carouselComponent,
  carouselTemplateComponents,
} from "./carousel-components";
import type { ProductCarouselDraft } from "./types";

const draft: ProductCarouselDraft = {
  name: "products_20261102_091400",
  language: "kk",
  bodyText: "Біздің тауарлар. Ұнағанын таңдап, тапсырыс беріңіз.",
  cards: [
    {
      productId: "651f1f77bcf86cd799439011",
      imageUrl: "https://cdn.test/business-media/product-1.jpg",
      bodyText: "Кукла Лол\n5 000 ₸",
      buttonText: "Тапсырыс беру",
    },
    {
      productId: "651f1f77bcf86cd799439012",
      imageUrl: "https://cdn.test/business-media/product-2.jpg",
      bodyText: "Кружка Web UMN\n3 500 ₸ бастап",
      buttonText: "Тапсырыс беру",
    },
  ],
  leftOut: 0,
};

const card = (imageUrl: string, bodyText: string) => ({
  components: [
    {
      type: "HEADER",
      format: "IMAGE",
      example: { header_handle: [imageUrl] },
    },
    { type: "BODY", text: bodyText },
    {
      type: "BUTTONS",
      buttons: [{ type: "QUICK_REPLY", text: "Тапсырыс беру" }],
    },
  ],
});

describe("carouselTemplateComponents", () => {
  it("puts the message above one card per product: its picture, name and price, and the order button", () => {
    expect(carouselTemplateComponents(draft)).toEqual([
      { type: "BODY", text: draft.bodyText },
      {
        type: "CAROUSEL",
        cards: [
          card(
            "https://cdn.test/business-media/product-1.jpg",
            "Кукла Лол\n5 000 ₸"
          ),
          card(
            "https://cdn.test/business-media/product-2.jpg",
            "Кружка Web UMN\n3 500 ₸ бастап"
          ),
        ],
      },
    ]);
  });

  it("is the template the editor sends for the same carousel", () => {
    expect(carouselTemplateComponents(draft)).toEqual(
      buildWhatsAppTemplateComponentsFromFormValues(
        carouselTemplateValues(draft)
      )
    );
  });

  it("is a marketing template Meta's submission rules take", () => {
    expect(
      parseWhatsAppTemplateSubmissionComponents(
        carouselTemplateComponents(draft),
        "MARKETING"
      ).success
    ).toBe(true);
  });

  it("opens in the editor as the same carousel", () => {
    expect(carouselTemplateValues(draft)).toMatchObject({
      name: draft.name,
      language: "kk",
      category: "MARKETING",
      bodyText: draft.bodyText,
      hasCarousel: true,
      carouselHeaderFormat: "IMAGE",
    });
    expect(carouselComponent(draft)).toEqual(
      carouselTemplateComponents(draft)[1]
    );
  });
});

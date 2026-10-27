import {
  buildCanvaTemplateSearchQuery,
  normalizeCanvaBrandTemplatesResponse,
} from "./brand-templates";

describe("Canva brand template helpers", () => {
  it("normalizes brand template thumbnails and pagination", () => {
    expect(
      normalizeCanvaBrandTemplatesResponse({
        continuation: "next-page",
        items: [
          {
            id: "brand-template-1",
            title: "VIP Re-activation Reel",
            create_url: "https://www.canva.com/create/1",
            thumbnail: {
              url: "https://cdn.canva.com/thumb-1.png",
              width: 600,
              height: 400,
            },
          },
          {
            id: "brand-template-2",
            thumbnail: {},
          },
          {
            title: "missing id is ignored",
          },
        ],
      })
    ).toEqual({
      items: [
        {
          id: "brand-template-1",
          title: "VIP Re-activation Reel",
          thumbnailUrl: "https://cdn.canva.com/thumb-1.png",
          createUrl: "https://www.canva.com/create/1",
          source: "canva_brand_template",
        },
        {
          id: "brand-template-2",
          title: "Untitled Canva brand template",
          thumbnailUrl: null,
          createUrl: null,
          source: "canva_brand_template",
        },
      ],
      continuation: "next-page",
    });
  });

  it("builds a concise template search query from the ready blueprint", () => {
    expect(
      buildCanvaTemplateSearchQuery({
        prompt:
          "Generate a reactivation campaign for VIP users who asked about pricing and drive them to book a demo this week.",
        campaignName: "VIP Reactivation",
      })
    ).toBe("VIP Reactivation reactivation campaign");
  });
});

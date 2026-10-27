import {
  mergeComponentsWithUnifiedHeaderMediaUrl,
  shouldPreferUnifiedMediaComponents,
} from "./header-media-utils";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";

const metaCarousel: WhatsAppComponent[] = [
  { type: "BODY", text: "Pick a card" },
  {
    type: "CAROUSEL",
    cards: [
      {
        components: [
          {
            type: "HEADER",
            format: "IMAGE",
            example: { header_handle: ["4::meta-card-one"] },
          },
          { type: "BODY", text: "One" },
        ],
      },
      {
        components: [
          {
            type: "HEADER",
            format: "IMAGE",
            example: { header_handle: ["4::meta-card-two"] },
          },
          { type: "BODY", text: "Two" },
        ],
      },
    ],
  },
];

const unifiedCarousel: WhatsAppComponent[] = [
  { type: "BODY", text: "Pick a card" },
  {
    type: "CAROUSEL",
    cards: [
      {
        components: [
          {
            type: "HEADER",
            format: "IMAGE",
            example: { header_handle: ["https://cdn.example.com/one.png"] },
          },
          { type: "BODY", text: "One" },
        ],
      },
      {
        components: [
          {
            type: "HEADER",
            format: "IMAGE",
            example: { header_handle: ["https://cdn.example.com/two.png"] },
          },
          { type: "BODY", text: "Two" },
        ],
      },
    ],
  },
];

describe("carousel header media merge", () => {
  it("prefers unified HTTP card media over Meta handles", () => {
    expect(
      shouldPreferUnifiedMediaComponents({
        metaComponents: metaCarousel,
        unifiedComponents: unifiedCarousel,
      })
    ).toBe(true);

    const merged = mergeComponentsWithUnifiedHeaderMediaUrl({
      metaComponents: metaCarousel,
      unifiedComponents: unifiedCarousel,
    });
    const carousel = merged?.find(component => component.type === "CAROUSEL");
    expect(carousel).toMatchObject({
      type: "CAROUSEL",
      cards: [
        {
          components: [
            {
              type: "HEADER",
              example: { header_handle: ["https://cdn.example.com/one.png"] },
            },
            { type: "BODY", text: "One" },
          ],
        },
        {
          components: [
            {
              type: "HEADER",
              example: { header_handle: ["https://cdn.example.com/two.png"] },
            },
            { type: "BODY", text: "Two" },
          ],
        },
      ],
    });
  });
});

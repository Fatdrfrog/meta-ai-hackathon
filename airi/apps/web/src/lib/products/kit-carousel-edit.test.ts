/** @jest-environment node */

const mockStore = jest.fn();
const mockWarn = jest.fn();

jest.mock("@/lib/whatsapp/templates/header-media-storage", () => ({
  storeWhatsAppTemplateHeaderMedia: (...args: unknown[]) => mockStore(...args),
}));
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockWarn(...args) },
}));

import { StorageQuotaError } from "@icecore/airi-runtime/storage-quota";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import {
  carouselCardCount,
  checkCarouselComponents,
  isKitCardImageUrl,
  keepCardPictures,
  parseCarouselEdit,
} from "./kit-carousel-edit";

const SUPABASE = "https://abcdefgh.supabase.co";
const picture = (index: number) =>
  `${SUPABASE}/storage/v1/object/public/business-media/whatsapp-template-headers/ws/${index}-card.jpg`;

type Card = { image: string | null; format?: "IMAGE" | "VIDEO" };

function carousel(cards: Card[], extra: WhatsAppComponent[] = []) {
  return [
    { type: "BODY", text: "Our new pieces" },
    ...extra,
    {
      type: "CAROUSEL",
      cards: cards.map(({ image, format = "IMAGE" }, index) => ({
        components: [
          {
            type: "HEADER",
            format,
            ...(image ? { example: { header_handle: [image] } } : {}),
          },
          { type: "BODY", text: `Card ${index + 1}\n15 500 ₸` },
          {
            type: "BUTTONS",
            buttons: [{ type: "QUICK_REPLY", text: "Order" }],
          },
        ],
      })),
    },
  ] as WhatsAppComponent[];
}

const cards = (count: number): Card[] =>
  Array.from({ length: count }, (_, index) => ({ image: picture(index) }));

const NAME = "products_20261103_101500_a1b2c3";

let savedUrl: string | undefined;
let savedBucket: string | undefined;
beforeEach(() => {
  savedUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  savedBucket = process.env.GCS_CREATIVE_ASSETS_BUCKET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  delete process.env.GCS_CREATIVE_ASSETS_BUCKET;
});
afterEach(() => {
  if (savedUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = savedUrl;
  if (savedBucket === undefined) delete process.env.GCS_CREATIVE_ASSETS_BUCKET;
  else process.env.GCS_CREATIVE_ASSETS_BUCKET = savedBucket;
});

describe("parseCarouselEdit", () => {
  it("passes a carousel of 2 to 10 image cards on this project's storage", () => {
    for (const count of [2, 10]) {
      const parsed = parseCarouselEdit(NAME, carousel(cards(count)));
      if (!parsed.ok) throw new Error(parsed.issues.join("; "));
      expect(parsed.name).toBe(NAME);
      expect(parsed.components).toEqual(carousel(cards(count)));
      expect(carouselCardCount(parsed.components)).toBe(count);
    }
  });

  it("refuses 1 card and 11 cards", () => {
    for (const count of [1, 11])
      expect(checkCarouselComponents(NAME, carousel(cards(count)))).not.toEqual(
        []
      );
  });

  it("refuses a card without a picture, and a video card", () => {
    expect(
      checkCarouselComponents(NAME, carousel([...cards(2), { image: null }]))
    ).not.toEqual([]);
    const video = checkCarouselComponents(
      NAME,
      carousel(cards(3).map(card => ({ ...card, format: "VIDEO" as const })))
    );
    expect(video).toContain("Card 1 shows a video: kit cards show pictures.");
  });

  it("refuses a picture on another host, over http, or off Supabase Storage", () => {
    const pictures = [
      "https://example.com/card.jpg",
      `http://abcdefgh.supabase.co/storage/v1/object/public/x/card.jpg`,
      `${SUPABASE}/rest/v1/card.jpg`,
      "https://storage.googleapis.com/someone-elses-bucket/card.jpg",
      `https://user:pass@abcdefgh.supabase.co/storage/v1/object/public/x.jpg`,
    ];
    for (const image of pictures)
      expect(
        checkCarouselComponents(NAME, carousel([...cards(2), { image }]))
      ).toEqual([
        "Card 3's picture has to be uploaded in the editor or chosen from your Assets.",
      ]);
  });

  it("passes a picture chosen from Assets: a signed link to airi's Assets bucket", () => {
    const signed =
      "https://storage.googleapis.com/icecore-ai-creative-assets-prod/workspaces/ws/assets/a1/card.png?X-Goog-Signature=abc";
    expect(isKitCardImageUrl(signed)).toBe(true);
    expect(
      isKitCardImageUrl(
        "https://icecore-ai-creative-assets-prod.storage.googleapis.com/a1/card.png"
      )
    ).toBe(true);
    process.env.GCS_CREATIVE_ASSETS_BUCKET = "airi-assets-staging";
    expect(isKitCardImageUrl(signed)).toBe(false);
    expect(
      isKitCardImageUrl(
        "https://storage.googleapis.com/airi-assets-staging/a.png"
      )
    ).toBe(true);
  });

  it("passes a signed Supabase Storage link", () => {
    expect(
      isKitCardImageUrl(
        `${SUPABASE}/storage/v1/object/sign/media/a.jpg?token=t`
      )
    ).toBe(true);
  });

  it("refuses a name Meta wouldn't take", () => {
    for (const name of ["Products 1", "products-1", "", "x".repeat(513), 7])
      expect(checkCarouselComponents(name, carousel(cards(2)))).toEqual([
        "The template name can have only small letters, digits and underscores.",
      ]);
  });

  it("refuses a top-level header, footer or buttons, and a template that isn't a carousel", () => {
    expect(
      checkCarouselComponents(
        NAME,
        carousel(cards(2), [{ type: "FOOTER", text: "Shop" }])
      )
    ).toEqual([
      "A carousel has only a message and its cards: no header, footer or buttons of its own.",
    ]);
    expect(
      checkCarouselComponents(NAME, [{ type: "BODY", text: "Hello" }])
    ).toEqual(["The template has to be a carousel."]);
    expect(checkCarouselComponents(NAME, "cards")).toEqual([
      "The carousel has no cards.",
    ]);
  });

  it("refuses a carousel over 16 KB, before anything else reads it", () => {
    const big = carousel(cards(2));
    (big[0] as { text: string }).text = "x".repeat(17 * 1024);
    expect(checkCarouselComponents(NAME, big)).toEqual([
      "The carousel is too big to keep: shorten its texts.",
    ]);
  });

  it("names Meta's template rules when they fail", () => {
    const long = carousel(cards(2));
    const card = (
      long[1] as {
        cards: Array<{ components: Array<{ type: string; text?: string }> }>;
      }
    ).cards[0]!;
    card.components[1]!.text = "x".repeat(161);
    expect(checkCarouselComponents(NAME, long)).toHaveLength(1);
  });
});

describe("keepCardPictures", () => {
  const ASSET =
    "https://storage.googleapis.com/icecore-ai-creative-assets-prod/workspaces/ws/a1/shoe.png?X-Goog-Signature=abc";
  const realFetch = global.fetch;
  let fetched: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    fetched = [];
    global.fetch = (async (url: string) => {
      fetched.push(url);
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }) as unknown as typeof fetch;
    mockStore.mockImplementation(
      async ({ fileName }: { fileName: string }) => ({
        url: `${SUPABASE}/storage/v1/object/public/business-media/${fileName}`,
        bucket: "business-media",
        path: fileName,
      })
    );
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  it("copies a picture chosen from Assets to template media, leaving Supabase ones as they are", async () => {
    const components = carousel([{ image: picture(0) }, { image: ASSET }]);

    const kept = await keepCardPictures("ws-1", components);

    expect(fetched).toEqual([ASSET]);
    expect(mockStore).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      fileName: "card-2.png",
      buffer: expect.any(Buffer),
      mimeType: "image/png",
    });
    if (!kept.ok) throw new Error(kept.issues.join("; "));
    const cards = (
      kept.components[1] as {
        cards: Array<{
          components: Array<{ example?: { header_handle: string[] } }>;
        }>;
      }
    ).cards;
    expect(cards[0]!.components[0]!.example!.header_handle).toEqual([
      picture(0),
    ]);
    expect(cards[1]!.components[0]!.example!.header_handle).toEqual([
      `${SUPABASE}/storage/v1/object/public/business-media/card-2.png`,
    ]);
    // What was given is left as it was.
    expect(JSON.stringify(components)).toContain(ASSET);
    expect(
      isKitCardImageUrl(cards[1]!.components[0]!.example!.header_handle[0])
    ).toBe(true);
  });

  it("names a picture that couldn't be copied, and lets a full storage say so", async () => {
    global.fetch = (async () =>
      new Response("gone", { status: 403 })) as unknown as typeof fetch;
    expect(
      await keepCardPictures(
        "ws-1",
        carousel([{ image: picture(0) }, { image: ASSET }])
      )
    ).toEqual({
      ok: false,
      issues: [
        "Card 2's picture couldn't be copied from your Assets: choose it again, or upload it.",
      ],
    });

    global.fetch = (async () =>
      new Response("x", {
        status: 200,
        headers: { "Content-Type": "image/png" },
      })) as unknown as typeof fetch;
    mockStore.mockRejectedValue(
      new StorageQuotaError("company_storage_limit_exceeded", "Storage is full")
    );
    await expect(
      keepCardPictures("ws-1", carousel([{ image: ASSET }, { image: ASSET }]))
    ).rejects.toBeInstanceOf(StorageQuotaError);
  });
});

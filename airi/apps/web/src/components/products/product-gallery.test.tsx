/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { DndContext } from "@dnd-kit/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import type { ProductTemplateStamp } from "@/lib/products/templates";
import {
  formatProductPrice,
  type ProductAdRecord,
  type WorkspaceProductRecord,
} from "@/lib/products/types";
import {
  CarriedStack,
  galleryTileId,
  ProductGallery,
  type ProductGalleryProps,
} from "./product-gallery";

const COPY = PRODUCTS_COPY.gallery;

const product = (
  n: number,
  overrides: Partial<WorkspaceProductRecord> = {}
): WorkspaceProductRecord => ({
  id: `p${n}`,
  name: `Product ${n}`,
  price: 1000 * n,
  currency: "KZT",
  priceIsFrom: false,
  imageUrl: `https://storage.test/p${n}.webp`,
  hasCutout: true,
  updatedAt: null,
  ...overrides,
});

const PICKS = [product(1), product(2), product(3)];

const ad = (overrides: Partial<ProductAdRecord> = {}): ProductAdRecord =>
  ({
    id: "ad1",
    status: "ready",
    motion: "shelf",
    products: PICKS.map(pick => ({
      productId: pick.id,
      name: pick.name,
      englishName: null,
      priceText: "1 000 ₸",
      imageUrl: pick.imageUrl,
    })),
    video: {
      url: "https://signed.test/ad.mp4",
      bytes: 1,
      seconds: 14,
      posterUrl: "https://signed.test/poster.jpg",
    },
    stills: { statusUrl: null, feedUrl: "https://signed.test/feed.jpg" },
    ...overrides,
  }) as ProductAdRecord;

function renderGallery(props: Partial<ProductGalleryProps> = {}) {
  const onMake = jest.fn();
  const view = render(
    <DndContext>
      <ProductGallery
        idPrefix="g"
        picks={PICKS}
        adPicks={PICKS}
        frames={new Map()}
        ad={null}
        stamps={new Map()}
        locked={null}
        newPicks={false}
        openId={null}
        workbench={null}
        carrying={false}
        onMake={onMake}
        {...props}
      />
    </DndContext>
  );
  return { ...view, onMake };
}

const tile = (id: string) =>
  document.getElementById(galleryTileId("g", id as never)) as HTMLElement;
const art = (id: string) =>
  Array.from(tile(id).querySelectorAll("img")).map(img =>
    img.getAttribute("src")
  );

test("groups the shipped tiles by where they end up, and hides the others", () => {
  renderGallery();
  for (const [group, place] of [
    ["Reel", "Instagram"],
    ["Story", "Instagram"],
    ["Post", "Instagram"],
    ["WhatsApp ad", "Facebook"],
    ["WhatsApp chat", "WhatsApp"],
  ])
    expect(
      screen.getByRole("region", { name: COPY.groupLabel(group!, place!) })
    ).toBeInTheDocument();
  const reel = screen.getByRole("region", {
    name: COPY.groupLabel("Reel", "Instagram"),
  });
  expect(
    within(reel)
      .getAllByRole("button")
      .map(button => button.dataset.template)
  ).toEqual(["reel_shelf", "reel_filmed_sold", "reel_float", "reel_pop"]);
  // Every shipped tile is there, in its group.
  for (const id of [
    "story_price_list",
    "story_big_price",
    "post_big_price",
    "ctwa_picture",
  ])
    expect(tile(id)).not.toBeNull();
  // A tile whose renderer isn't shipped is left out by productTemplateGroups
  // (templates.test.ts), which is what the gallery draws from.
});

test("names a tile by its template, with Muse Image's mark said in words", () => {
  renderGallery();
  expect(tile("reel_shelf")).toHaveAccessibleName(
    new RegExp(`^${COPY.tiles.reel_shelf} ?, ${COPY.museImage}$`)
  );
  expect(tile("post_studio")).toHaveAccessibleName(COPY.tiles.post_studio);
});

test("single-product tiles show the first pick that their workbench opens", () => {
  renderGallery();
  expect(art("reel_shelf")).toContain(PICKS[0]!.imageUrl);
  // The preview must match the workbench's initial product.
  expect(art("story_big_price")).toEqual([PICKS[0]!.imageUrl]);
  expect(art("post_room")).toEqual([PICKS[0]!.imageUrl]);
  expect(art("post_studio")).toEqual([PICKS[0]!.imageUrl]);
  expect(art("post_big_price")).toEqual([PICKS[0]!.imageUrl]);
  // The WhatsApp picture ad is made of the first product's picture, so its
  // tile shows that product, not the next one in turn.
  expect(art("ctwa_picture")).toEqual([PICKS[0]!.imageUrl]);
  // The collection and the WhatsApp chat show every pick they use.
  expect(art("post_collection")).toEqual(PICKS.map(pick => pick.imageUrl));
  expect(art("chat_kit")).toEqual(PICKS.map(pick => pick.imageUrl));
  // Prices are drawn by code.
  expect(tile("post_room").textContent).toContain(
    formatProductPrice(1000, { currency: "KZT" })
  );
});

test("a tap on a tile makes it", () => {
  const { onMake } = renderGallery();
  fireEvent.click(tile("reel_filmed_sold"));
  expect(onMake).toHaveBeenCalledTimes(1);
  expect(onMake.mock.calls[0]![0]).toMatchObject({ id: "reel_filmed_sold" });
});

test("without picks, every tile says to pick first and makes nothing", () => {
  const { onMake } = renderGallery({ picks: [], adPicks: [] });
  expect(tile("reel_shelf")).toHaveAttribute("aria-disabled", "true");
  expect(tile("reel_shelf")).toHaveTextContent(COPY.pickFirst);
  fireEvent.click(tile("reel_shelf"));
  expect(onMake).not.toHaveBeenCalled();
});

test("ad tiles need a pick with a photo and a price; the chat tile doesn't", () => {
  const { onMake } = renderGallery({ adPicks: [] });
  expect(tile("story_video")).toHaveTextContent(COPY.needsPhotoAndPrice);
  fireEvent.click(tile("story_video"));
  expect(onMake).not.toHaveBeenCalled();
  expect(tile("chat_kit")).not.toHaveAttribute("aria-disabled");
});

test("with AI off, tiles that need a new ad lock; an ad that exists still opens", () => {
  const first = renderGallery({ locked: COPY.aiOff });
  expect(tile("reel_shelf")).toHaveTextContent(COPY.aiOff);
  expect(tile("reel_shelf")).toHaveAttribute("aria-disabled", "true");
  expect(tile("chat_kit")).not.toHaveAttribute("aria-disabled");
  first.unmount();

  const second = renderGallery({ locked: COPY.aiOff, ad: ad() });
  expect(tile("reel_shelf")).not.toHaveAttribute("aria-disabled");
  fireEvent.click(tile("reel_shelf"));
  expect(second.onMake).toHaveBeenCalledTimes(1);
});

test("once the ad exists, its tiles show its real poster; an old worker's ad hides the stills it lacks", () => {
  renderGallery({ ad: ad({ motion: "filmed_sold" }) });
  expect(art("reel_filmed_sold")).toEqual(["https://signed.test/poster.jpg"]);
  // The other motion still shows its drawing.
  expect(art("reel_shelf")).toContain(PICKS[0]!.imageUrl);
  // v2's one feed picture is In a room, of the first product.
  expect(art("post_room")).toEqual(["https://signed.test/feed.jpg"]);
  expect(tile("post_studio")).toBeNull();
  expect(tile("post_collection")).toBeNull();
  expect(tile("post_carousel")).toBeNull();
});

test("no still tile hides while the first video is made, nor from the made list's read", () => {
  const making = renderGallery({
    ad: ad({
      status: "making",
      video: null,
      stills: { statusUrl: null, feedUrl: null },
    }),
  });
  for (const id of ["post_room", "post_studio", "post_collection"])
    expect(tile(id)).not.toBeNull();
  // Drawn from the picks until the pictures land.
  expect(art("post_studio")).toEqual([PICKS[0]!.imageUrl]);
  making.unmount();

  // The made list's read of a ready ad leaves its stills out.
  renderGallery({
    ad: ad({ stills: { statusUrl: null, feedUrl: null } }),
    adStillsRead: false,
  });
  for (const id of [
    "post_room",
    "post_studio",
    "post_collection",
    "post_carousel",
  ])
    expect(tile(id)).not.toBeNull();
  expect(art("reel_shelf")).toEqual(["https://signed.test/poster.jpg"]);
});

test("a v3 ad's stills take the place of the drawings", () => {
  renderGallery({
    ad: ad({
      stills: {
        statusUrl: null,
        feedUrl: "https://signed.test/feed.jpg",
        templates: [
          {
            kind: "studio",
            format: "feed",
            productId: "p1",
            colourway: "sand",
            url: "https://signed.test/studio-p1.jpg",
          },
          {
            kind: "collection",
            format: "feed",
            productId: null,
            colourway: null,
            url: "https://signed.test/collection.jpg",
          },
          {
            kind: "room",
            format: "feed",
            productId: "p1",
            colourway: null,
            url: "https://signed.test/room-p1.jpg",
          },
        ],
      },
    }),
  });
  expect(art("post_room")).toEqual(["https://signed.test/room-p1.jpg"]);
  expect(art("post_studio")).toEqual(["https://signed.test/studio-p1.jpg"]);
  expect(art("post_collection")).toEqual([
    "https://signed.test/collection.jpg",
  ]);
});

test("stamps a tile once something from it is out on Meta, and marks picks over 3", () => {
  const stamps = new Map<string, ProductTemplateStamp>([
    ["reel_shelf", "live"],
    ["ctwa_video", "paused"],
  ]);
  renderGallery({
    stamps: stamps as never,
    picks: [...PICKS, product(4), product(5)],
  });
  expect(tile("reel_shelf")).toHaveTextContent(COPY.stamps.live);
  expect(tile("ctwa_video")).toHaveTextContent(COPY.stamps.paused);
  expect(tile("reel_shelf")).toHaveTextContent(COPY.morePicks(2));
  expect(tile("reel_shelf")).toHaveAccessibleName(
    expect.stringContaining(COPY.morePicks(2))
  );
  // The chat takes every pick, up to 10.
  expect(tile("chat_kit")).not.toHaveTextContent(COPY.morePicks(2));
});

test("puts the open tile's workbench under its group, and marks the tile open", () => {
  renderGallery({
    openId: "post_studio",
    workbench: <section aria-label="Workbench">bench</section>,
  });
  expect(tile("post_studio")).toHaveAttribute("aria-expanded", "true");
  expect(tile("reel_shelf")).toHaveAttribute("aria-expanded", "false");
  const bench = screen.getByRole("region", { name: "Workbench" });
  const post = screen.getByRole("region", {
    name: COPY.groupLabel("Post", "Instagram"),
  });
  // Right after the Post group, before the WhatsApp ad group.
  expect(post.nextElementSibling).toContainElement(bench);
});

test("while the picks are carried, the tiles that take them say so", () => {
  renderGallery({ carrying: true, adPicks: [] });
  expect(tile("chat_kit")).toHaveAttribute("data-takes");
  expect(tile("reel_shelf")).not.toHaveAttribute("data-takes");
});

test("the carried stack shows how many picks it holds", () => {
  const { container } = render(<CarriedStack products={PICKS} />);
  expect(container).toHaveTextContent("3");
  expect(container.querySelectorAll("img")).toHaveLength(3);
});

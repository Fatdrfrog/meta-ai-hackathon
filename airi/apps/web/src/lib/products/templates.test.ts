/** @jest-environment node */

// Studio v3's template catalog: every tile, its one Meta action, and when it
// can show.

import {
  PRODUCT_TEMPLATE_GROUPS,
  PRODUCT_TEMPLATE_IDS,
  PRODUCT_TEMPLATES,
  productTemplate,
  productTemplateAvailable,
  productTemplateGroups,
  productTemplateOfCtwa,
  productTemplateOfMotion,
  productTemplateOfPost,
  productTemplatePicks,
  shippedProductTemplates,
  type ProductTemplate,
} from "./templates";
import {
  PRODUCT_AD_MOTIONS,
  type ProductAdRecord,
  type ProductAdRecordStill,
} from "./types";

const DOLL = "651f1f77bcf86cd799439011";

const tile = (id: (typeof PRODUCT_TEMPLATE_IDS)[number]) =>
  productTemplate(id)!;

const adWith = (
  templates: ProductAdRecordStill[] | undefined,
  feedUrl: string | null = null
): Pick<ProductAdRecord, "stills" | "video"> => ({
  stills: { statusUrl: null, feedUrl, templates },
  video: { url: "https://x/ad.mp4", bytes: 1, seconds: 12, posterUrl: null },
});

const still = (
  kind: ProductAdRecordStill["kind"],
  format: ProductAdRecordStill["format"] = "feed"
): ProductAdRecordStill => ({
  kind,
  format,
  productId:
    kind === "collection" || kind === "price_list" || kind === "grid"
      ? null
      : DOLL,
  colourway: kind === "studio" ? "sand" : null,
  url: `https://x/${kind}-${format}.jpg`,
});

describe("the catalog", () => {
  it("has every tile once, Meta-only, each with a name and one Meta action", () => {
    expect(PRODUCT_TEMPLATES.map(template => template.id)).toEqual([
      ...PRODUCT_TEMPLATE_IDS,
    ]);
    for (const template of PRODUCT_TEMPLATES) {
      expect(template.meta).toBe(true);
      expect(template.label).not.toBe("");
      expect(PRODUCT_TEMPLATE_GROUPS).toContain(template.group);
    }
  });

  it("names each tile by where it goes", () => {
    const actions = Object.fromEntries(
      PRODUCT_TEMPLATES.map(template => [template.id, template.action])
    );
    expect(actions).toMatchObject({
      reel_shelf: "post_reel",
      story_video: "post_story",
      post_room: "post",
      post_carousel: "post_carousel",
      ctwa_video: "create_ad",
      chat_kit: "create_on_whatsapp",
    });
  });

  it("makes every tile but the chat from the ad, which uses its first 3 picks", () => {
    for (const template of PRODUCT_TEMPLATES) {
      if (template.id === "chat_kit") {
        expect(template).toMatchObject({ makes: "kit", maxPicks: 10 });
      } else {
        expect(template).toMatchObject({ makes: "ad", maxPicks: 3 });
      }
    }
    expect(productTemplatePicks(tile("reel_shelf"), [1, 2, 3, 4, 5])).toEqual([
      1, 2, 3,
    ]);
  });

  it("gives every motion its Reel tile, and every still tile a still to show", () => {
    for (const motion of PRODUCT_AD_MOTIONS)
      expect(productTemplateOfMotion(motion).motion).toBe(motion);
    for (const template of PRODUCT_TEMPLATES)
      if (template.renderer === "still") {
        expect(template.stillKind).toBeDefined();
        expect(template.stillFormat).toBe(
          template.group === "story" ? "story" : "feed"
        );
      }
  });

  it("shows only the tiles that shipped, by group, leaving out an empty group", () => {
    const only = (ids: string[]): ProductTemplate[] =>
      PRODUCT_TEMPLATES.map(template => ({
        ...template,
        shipped: ids.includes(template.id),
      }));
    expect(
      shippedProductTemplates(only(["reel_shelf", "chat_kit"])).map(
        template => template.id
      )
    ).toEqual(["reel_shelf", "chat_kit"]);
    expect(
      productTemplateGroups(only(["reel_shelf", "chat_kit"])).map(entry => [
        entry.group,
        entry.label,
      ])
    ).toEqual([
      ["reel", "Reel"],
      ["whatsapp_chat", "WhatsApp chat"],
    ]);
    // Every tier's renderer is green at the integrate step: all 15 tiles ship.
    expect(shippedProductTemplates().map(template => template.id)).toEqual([
      ...PRODUCT_TEMPLATE_IDS,
    ]);
  });

  it("knows no tile by an unknown id", () => {
    expect(productTemplate("reel_turntable")).toBeNull();
    expect(productTemplate(undefined)).toBeNull();
  });
});

describe("the tile something went out from", () => {
  it("finds a post's tile by where it went and what it showed", () => {
    expect(
      productTemplateOfPost({
        destination: "reel",
        still: null,
        motion: "filmed_sold",
      })?.id
    ).toBe("reel_filmed_sold");
    expect(
      productTemplateOfPost({ destination: "story", still: null, motion: null })
        ?.id
    ).toBe("story_video");
    expect(
      productTemplateOfPost({
        destination: "story",
        still: { kind: "big_price", productId: DOLL },
        motion: null,
      })?.id
    ).toBe("story_big_price");
    expect(
      productTemplateOfPost({
        destination: "post",
        still: { kind: "studio", productId: DOLL, colourway: "rose" },
        motion: null,
      })?.id
    ).toBe("post_studio");
    expect(
      productTemplateOfPost({
        destination: "story",
        still: { kind: "spotlight", productId: DOLL },
        motion: null,
      })?.id
    ).toBe("story_spotlight");
    expect(
      productTemplateOfPost({
        destination: "story",
        still: { kind: "grid", productId: null },
        motion: null,
      })?.id
    ).toBe("story_grid");
    expect(
      productTemplateOfPost({
        destination: "post",
        still: { kind: "print", productId: DOLL },
        motion: null,
      })?.id
    ).toBe("post_print");
    expect(
      productTemplateOfPost({
        destination: "post",
        still: { kind: "grid", productId: null },
        motion: null,
      })?.id
    ).toBe("post_grid");
    expect(
      productTemplateOfPost({
        destination: "carousel",
        still: null,
        motion: null,
      })?.id
    ).toBe("post_carousel");
  });

  it("finds the WhatsApp ad's tile by its asset", () => {
    expect(productTemplateOfCtwa({ asset: "video" }).id).toBe("ctwa_video");
    expect(productTemplateOfCtwa({ asset: "picture" }).id).toBe("ctwa_picture");
  });
});

describe("when a tile can show", () => {
  it("always before an ad exists, and for the video tiles", () => {
    for (const template of PRODUCT_TEMPLATES)
      expect(productTemplateAvailable(template, null)).toBe(true);
    const old = adWith(undefined);
    expect(productTemplateAvailable(tile("reel_filmed_sold"), old)).toBe(true);
    expect(productTemplateAvailable(tile("story_video"), old)).toBe(true);
    expect(productTemplateAvailable(tile("ctwa_video"), old)).toBe(true);
  });

  it("hides the still tiles an ad rendered by an older worker has no still for", () => {
    const old = adWith(undefined, "https://x/feed.jpg");
    // v2's feed still is an In a room picture.
    expect(productTemplateAvailable(tile("post_room"), old)).toBe(true);
    expect(productTemplateAvailable(tile("post_studio"), old)).toBe(false);
    expect(productTemplateAvailable(tile("post_collection"), old)).toBe(false);
    expect(productTemplateAvailable(tile("post_carousel"), old)).toBe(false);
    expect(productTemplateAvailable(tile("post_room"), adWith(undefined))).toBe(
      false
    );
  });

  it("shows a still tile once its render drew that still, in that format", () => {
    const ad = adWith([
      still("room"),
      still("studio"),
      still("collection"),
      still("big_price", "story"),
    ]);
    expect(productTemplateAvailable(tile("post_studio"), ad)).toBe(true);
    expect(productTemplateAvailable(tile("post_carousel"), ad)).toBe(true);
    expect(productTemplateAvailable(tile("story_big_price"), ad)).toBe(true);
    expect(productTemplateAvailable(tile("post_big_price"), ad)).toBe(false);
    expect(productTemplateAvailable(tile("story_price_list"), ad)).toBe(false);
  });
});

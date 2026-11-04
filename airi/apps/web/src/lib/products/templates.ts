// Studio v3's template catalog: every tile the gallery can show, grouped by
// the Meta destination it ends in. A tile is a template plus a destination,
// so choosing one chooses both, and its workbench has exactly one Meta
// action. Every tile but the WhatsApp chat one is made from the same ad: one
// AI action feeds every Reel, Story, Post and WhatsApp-ad tile. Motions and
// stills are code over what the ad already made, at no extra cost.
//
// The page shows a tile only when it `shipped` (its renderer is deployed):
// the integrate step flips them, and a hidden tile is simply not shown.
// Client-safe: no server imports.

import { GALLERY_COPY } from "./copy-gallery";
import {
  PRODUCT_AD_MAX_PRODUCTS,
  type ProductAdCtwaAsset,
  type ProductAdCtwaRecord,
  type ProductAdMotion,
  type ProductAdPostDestination,
  type ProductAdPostRecord,
  type ProductAdRecord,
  type ProductAdStillFormat,
  type ProductAdStillKind,
} from "./types";

/** The Meta destinations the gallery groups its tiles by, in the page's order. */
export const PRODUCT_TEMPLATE_GROUPS = [
  "reel",
  "story",
  "post",
  "whatsapp_ad",
  "whatsapp_chat",
] as const;
export type ProductTemplateGroup = (typeof PRODUCT_TEMPLATE_GROUPS)[number];

/** Every tile, in gallery order. */
export const PRODUCT_TEMPLATE_IDS = [
  "reel_shelf",
  "reel_filmed_sold",
  "reel_float",
  "reel_pop",
  "story_video",
  "story_price_list",
  "story_big_price",
  "post_room",
  "post_studio",
  "post_big_price",
  "post_collection",
  "post_carousel",
  "ctwa_video",
  "ctwa_picture",
  "chat_kit",
] as const;
export type ProductTemplateId = (typeof PRODUCT_TEMPLATE_IDS)[number];

/**
 * When a tile's renderer lands (spec section 3): exists (v2), T1 (never
 * cut), T2 and T3 (cut first if late).
 */
export type ProductTemplateTier = "exists" | "T1" | "T2" | "T3";

/**
 * What draws the tile's result. motion: the ad's video in `motion`. video:
 * the ad's video in whatever motion it has. still: one of the ad's stills
 * (`stillKind`, `stillFormat`). carousel: Collection, then one In a room (or
 * Studio, per the Look) per product. kit: v2's WhatsApp carousel and order
 * form.
 */
export type ProductTemplateRenderer =
  | "motion"
  | "video"
  | "still"
  | "carousel"
  | "kit";

/** The frame the workbench previews the result in, as it will appear. */
export type ProductTemplateFrame =
  | "ig_reel"
  | "ig_story"
  | "ig_feed"
  | "ig_carousel"
  | "fb_ad"
  | "wa_chat";

/** The workbench's one Meta action; its label is in copy-workbench.ts. */
export const PRODUCT_TEMPLATE_ACTIONS = [
  "post_reel",
  "post_story",
  "post",
  "post_carousel",
  "create_ad",
  "create_on_whatsapp",
] as const;
export type ProductTemplateAction = (typeof PRODUCT_TEMPLATE_ACTIONS)[number];

/** A tile's stamp once something from it is out on Meta. */
export type ProductTemplateStamp =
  | "live"
  | "in_review"
  | "paused"
  | "approved"
  | "failed";

export type ProductTemplate = {
  id: ProductTemplateId;
  group: ProductTemplateGroup;
  /** What it ends in. */
  format: "video" | "image" | "carousel" | "chat";
  renderer: ProductTemplateRenderer;
  /** renderer "motion": the motion the ad's video is made in. */
  motion?: ProductAdMotion;
  /** renderer "still": which of the ad's stills, in which format. */
  stillKind?: ProductAdStillKind;
  stillFormat?: ProductAdStillFormat;
  /**
   * One product at a time: the tile's art rotates through the picks (tile
   * k shows pick k mod n), and the workbench's Shots rail picks the product.
   */
  perProduct: boolean;
  frame: ProductTemplateFrame;
  action: ProductTemplateAction;
  /** Where the publish route posts it on Instagram; null for the WhatsApp tiles. */
  destination: ProductAdPostDestination | null;
  /** The WhatsApp-ad tiles' creative. */
  ctwaAsset?: ProductAdCtwaAsset;
  /** What a make makes: the ad (every Reel, Story, Post and WhatsApp-ad tile) or the kit. */
  makes: "ad" | "kit";
  /** Picks it uses, the first ones: the ad shows 1 to 3, the kit's carousel up to 10. */
  maxPicks: number;
  tier: ProductTemplateTier;
  /** Every model behind it is Meta's. */
  meta: boolean;
  /** Its look shows Muse Image's new pictures: the rose ✦ after its name. */
  museImage: boolean;
  /** Whether its renderer is deployed; the page shows shipped tiles only. */
  shipped: boolean;
  label: string;
};

/** The most picks the WhatsApp chat tile takes: a WhatsApp carousel's 10 cards. */
export const PRODUCT_TEMPLATE_KIT_MAX_PICKS = 10;

/** The most picks the page keeps (?picks=…), in pick order. */
export const PRODUCT_PICKS_MAX = 60;

type Entry = Omit<ProductTemplate, "label" | "meta" | "maxPicks"> &
  Partial<Pick<ProductTemplate, "maxPicks">>;

const AD = PRODUCT_AD_MAX_PRODUCTS;

const ENTRIES: readonly Entry[] = [
  // Reel (Instagram REELS, 9:16)
  {
    id: "reel_shelf",
    group: "reel",
    format: "video",
    renderer: "motion",
    motion: "shelf",
    perProduct: false,
    frame: "ig_reel",
    action: "post_reel",
    destination: "reel",
    makes: "ad",
    tier: "exists",
    museImage: true,
    shipped: true,
  },
  {
    id: "reel_filmed_sold",
    group: "reel",
    format: "video",
    renderer: "motion",
    motion: "filmed_sold",
    perProduct: false,
    frame: "ig_reel",
    action: "post_reel",
    destination: "reel",
    makes: "ad",
    tier: "T1",
    museImage: true,
    shipped: true,
  },
  {
    id: "reel_float",
    group: "reel",
    format: "video",
    renderer: "motion",
    motion: "float",
    perProduct: false,
    frame: "ig_reel",
    action: "post_reel",
    destination: "reel",
    makes: "ad",
    tier: "T2",
    museImage: false,
    shipped: true,
  },
  {
    id: "reel_pop",
    group: "reel",
    format: "video",
    renderer: "motion",
    motion: "pop",
    perProduct: false,
    frame: "ig_reel",
    action: "post_reel",
    destination: "reel",
    makes: "ad",
    tier: "T3",
    museImage: true,
    shipped: true,
  },
  // Story (Instagram STORIES, 9:16)
  {
    id: "story_video",
    group: "story",
    format: "video",
    renderer: "video",
    perProduct: false,
    frame: "ig_story",
    action: "post_story",
    destination: "story",
    makes: "ad",
    tier: "T1",
    museImage: false,
    shipped: true,
  },
  {
    id: "story_price_list",
    group: "story",
    format: "image",
    renderer: "still",
    stillKind: "price_list",
    stillFormat: "story",
    perProduct: false,
    frame: "ig_story",
    action: "post_story",
    destination: "story",
    makes: "ad",
    tier: "T2",
    museImage: false,
    shipped: true,
  },
  {
    id: "story_big_price",
    group: "story",
    format: "image",
    renderer: "still",
    stillKind: "big_price",
    stillFormat: "story",
    perProduct: true,
    frame: "ig_story",
    action: "post_story",
    destination: "story",
    makes: "ad",
    tier: "T2",
    museImage: false,
    shipped: true,
  },
  // Post (Instagram feed, 4:5 JPEG)
  {
    id: "post_room",
    group: "post",
    format: "image",
    renderer: "still",
    stillKind: "room",
    stillFormat: "feed",
    perProduct: true,
    frame: "ig_feed",
    action: "post",
    destination: "post",
    makes: "ad",
    tier: "T1",
    museImage: true,
    shipped: true,
  },
  {
    id: "post_studio",
    group: "post",
    format: "image",
    renderer: "still",
    stillKind: "studio",
    stillFormat: "feed",
    perProduct: true,
    frame: "ig_feed",
    action: "post",
    destination: "post",
    makes: "ad",
    tier: "T1",
    museImage: false,
    shipped: true,
  },
  {
    id: "post_big_price",
    group: "post",
    format: "image",
    renderer: "still",
    stillKind: "big_price",
    stillFormat: "feed",
    perProduct: true,
    frame: "ig_feed",
    action: "post",
    destination: "post",
    makes: "ad",
    tier: "T2",
    museImage: false,
    shipped: true,
  },
  {
    id: "post_collection",
    group: "post",
    format: "image",
    renderer: "still",
    stillKind: "collection",
    stillFormat: "feed",
    perProduct: false,
    frame: "ig_feed",
    action: "post",
    destination: "post",
    makes: "ad",
    tier: "T1",
    museImage: false,
    shipped: true,
  },
  {
    id: "post_carousel",
    group: "post",
    format: "carousel",
    renderer: "carousel",
    perProduct: false,
    frame: "ig_carousel",
    action: "post_carousel",
    destination: "carousel",
    makes: "ad",
    tier: "T1",
    museImage: false,
    shipped: true,
  },
  // WhatsApp ad (Click-to-WhatsApp, Marketing API, Facebook placements)
  {
    id: "ctwa_video",
    group: "whatsapp_ad",
    format: "video",
    renderer: "video",
    perProduct: false,
    frame: "fb_ad",
    action: "create_ad",
    destination: null,
    ctwaAsset: "video",
    makes: "ad",
    tier: "T1",
    museImage: false,
    shipped: true,
  },
  {
    id: "ctwa_picture",
    group: "whatsapp_ad",
    format: "image",
    renderer: "still",
    stillKind: "room",
    stillFormat: "feed",
    // The picture creative is always the first product's (lib/products/ctwa.ts),
    // so its tile doesn't take a turn through the picks.
    perProduct: false,
    frame: "fb_ad",
    action: "create_ad",
    destination: null,
    ctwaAsset: "picture",
    makes: "ad",
    tier: "T2",
    museImage: false,
    shipped: true,
  },
  // WhatsApp chat (the WABA): v2's kit
  {
    id: "chat_kit",
    group: "whatsapp_chat",
    format: "chat",
    renderer: "kit",
    perProduct: false,
    frame: "wa_chat",
    action: "create_on_whatsapp",
    destination: null,
    makes: "kit",
    maxPicks: PRODUCT_TEMPLATE_KIT_MAX_PICKS,
    tier: "exists",
    museImage: false,
    shipped: true,
  },
];

/** Every tile, shipped or not, in gallery order. */
export const PRODUCT_TEMPLATES: readonly ProductTemplate[] = ENTRIES.map(
  entry => ({
    ...entry,
    maxPicks: entry.maxPicks ?? AD,
    meta: true,
    label: GALLERY_COPY.gallery.tiles[entry.id],
  })
);

const BY_ID = new Map(
  PRODUCT_TEMPLATES.map(template => [template.id, template])
);

/** The tile with this id, shipped or not; null for an unknown one. */
export function productTemplate(id: unknown): ProductTemplate | null {
  return typeof id === "string"
    ? (BY_ID.get(id as ProductTemplateId) ?? null)
    : null;
}

/** The tiles the page shows: those whose renderer shipped. */
export function shippedProductTemplates(
  templates: readonly ProductTemplate[] = PRODUCT_TEMPLATES
): ProductTemplate[] {
  return templates.filter(template => template.shipped);
}

/** The shown tiles by group, in page order, leaving out a group with none. */
export function productTemplateGroups(
  templates: readonly ProductTemplate[] = PRODUCT_TEMPLATES
): Array<{
  group: ProductTemplateGroup;
  label: string;
  templates: ProductTemplate[];
}> {
  const shown = shippedProductTemplates(templates);
  return PRODUCT_TEMPLATE_GROUPS.map(group => ({
    group,
    label: GALLERY_COPY.gallery.groups[group],
    templates: shown.filter(template => template.group === group),
  })).filter(entry => entry.templates.length > 0);
}

/** The picks a tile uses: the first `maxPicks`, in pick order. */
export function productTemplatePicks<T>(
  template: Pick<ProductTemplate, "maxPicks">,
  picks: readonly T[]
): T[] {
  return picks.slice(0, template.maxPicks);
}

/** The Reel tile of a motion: the one `?ad=<id>` opens when nothing went out yet. */
export function productTemplateOfMotion(
  motion: ProductAdMotion
): ProductTemplate {
  return (
    PRODUCT_TEMPLATES.find(
      template => template.renderer === "motion" && template.motion === motion
    ) ?? BY_ID.get("reel_shelf")!
  );
}

/** The tile a post went out from, by where it went and what it showed. */
export function productTemplateOfPost(
  post: Pick<ProductAdPostRecord, "destination" | "still" | "motion">
): ProductTemplate | null {
  if (post.destination === "reel")
    return productTemplateOfMotion(post.motion ?? "shelf");
  if (post.destination === "carousel") return BY_ID.get("post_carousel")!;
  const kind = post.still?.kind ?? null;
  return (
    PRODUCT_TEMPLATES.find(
      template =>
        template.destination === post.destination &&
        (kind === null
          ? template.renderer === "video"
          : template.renderer === "still" && template.stillKind === kind)
    ) ?? null
  );
}

/** The tile a Click-to-WhatsApp ad went out from. */
export function productTemplateOfCtwa(
  ctwa: Pick<ProductAdCtwaRecord, "asset">
): ProductTemplate {
  return BY_ID.get(ctwa.asset === "picture" ? "ctwa_picture" : "ctwa_video")!;
}

/**
 * Whether a tile can show for this ad: always before an ad exists (its art
 * is drawn from the picks) and for its video tiles; a still tile only when
 * the ad's render drew that still (an ad rendered by a worker from before v3
 * has none, except v2's one In a room picture, `stills.feedUrl`).
 */
export function productTemplateAvailable(
  template: ProductTemplate,
  ad: Pick<ProductAdRecord, "stills" | "video"> | null
): boolean {
  if (!ad || template.makes === "kit") return true;
  if (template.renderer === "motion" || template.renderer === "video")
    return true;
  const stills = ad.stills.templates ?? [];
  const has = (kind: ProductAdStillKind, format: ProductAdStillFormat) =>
    stills.some(still => still.kind === kind && still.format === format);
  if (template.renderer === "carousel")
    return (
      has("collection", "feed") &&
      (has("room", "feed") || has("studio", "feed"))
    );
  if (!template.stillKind || !template.stillFormat) return false;
  if (has(template.stillKind, template.stillFormat)) return true;
  // v2's feed still is one In a room picture, of the first product.
  return template.stillKind === "room" && ad.stills.feedUrl !== null;
}

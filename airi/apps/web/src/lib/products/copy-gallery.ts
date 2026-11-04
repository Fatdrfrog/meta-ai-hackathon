// The gallery's copy (studio v3, stream U1): the template tiles, grouped by
// the Meta destination they end in, their marks and stamps, and the drop
// hint. The tiles' names are read by templates.ts.

import type {
  ProductTemplateGroup,
  ProductTemplateId,
  ProductTemplateStamp,
} from "./templates";

const GROUPS: Record<ProductTemplateGroup, string> = {
  reel: "Reel",
  story: "Story",
  post: "Post",
  whatsapp_ad: "WhatsApp ad",
  whatsapp_chat: "WhatsApp chat",
};

/** Where each group ends up, beside its name. */
const GROUP_PLACES: Record<ProductTemplateGroup, string> = {
  reel: "Instagram",
  story: "Instagram",
  post: "Instagram",
  whatsapp_ad: "Facebook",
  whatsapp_chat: "WhatsApp",
};

const TILES: Record<ProductTemplateId, string> = {
  reel_shelf: "Shelf ad",
  reel_filmed_sold: "Filmed → Sold",
  reel_float: "Float",
  reel_pop: "Pop",
  story_video: "Video",
  story_price_list: "Price list",
  story_big_price: "Big price",
  story_spotlight: "Spotlight",
  story_grid: "Catalog grid",
  post_room: "In a room",
  post_studio: "Studio",
  post_big_price: "Big price",
  post_print: "Photo print",
  post_collection: "Collection",
  post_grid: "Catalog grid",
  post_carousel: "Carousel",
  ctwa_video: "Video",
  ctwa_picture: "Picture",
  chat_kit: "Carousel + form",
};

const STAMPS: Record<ProductTemplateStamp, string> = {
  live: "Live",
  in_review: "In review",
  paused: "Paused",
  approved: "Approved",
  failed: "Failed",
};

export const GALLERY_COPY = {
  gallery: {
    groups: GROUPS,
    groupPlaces: GROUP_PLACES,
    tiles: TILES,
    stamps: STAMPS,
    /** The rose ✦ after a tile's name, for screen readers. */
    museImage: "makes new Muse Image pictures",
    hint: "Drop your picks on a tile, or tap one.",
    /** The hint when dragging is off (cut list 8). */
    hintTapOnly: "Tap products, then tap a tile.",
    /** A video tile with more picks than it uses: picks 1 to 3 are used. */
    morePicks: (count: number) => `+${count}`,
    newPicks: "New picks",
    aiOff: "AI is off for your company",
    earlier: "Earlier templates",
    later: "More templates",
    /** The gallery's name, for its region. */
    label: "Templates",
    /** A group's name with where it ends up, for its list. */
    groupLabel: (group: string, place: string) => `${group} on ${place}`,
    /** Why a tile can't be made now. */
    pickFirst: "Pick products on the shelf first",
    needsPhotoAndPrice: "Pick products with a photo and a price",
    /** Meta's chrome drawn on the tiles. */
    art: { whatsapp: "WhatsApp", rec: "REC" },
  },
} as const;

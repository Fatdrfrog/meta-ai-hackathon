// The Products page itself, its shelf, and checking what a video found, card
// by card. Part of PRODUCTS_COPY (copy.ts).

import { PRODUCT_VIDEO_MAX_SECONDS } from "./types";

const MAX_MINUTES = Math.round(PRODUCT_VIDEO_MAX_SECONDS / 60);
// A price as a currency with these decimals writes one.
const priceLike = (decimals: number) =>
  decimals === 0 ? "1500" : decimals === 3 ? "1.250" : "4.99";

export const SHELF_COPY = {
  title: "Products",
  // A quiet line under the title: the section is new, made at the hackathon.
  hackathonNote: "New · built at the Meta AI Hackathon 2026",
  loading: "Loading products…",
  loadError: "Products couldn't be loaded.",
  retry: "Retry",
  noPrice: "No price yet",
  emptyTitle: "Your products will appear here",
  emptyDescription:
    "Film your shelf on your phone and say each product's name and price, in any language, with the currency at least once. Airi turns the video into products for you to check.",

  // Adding products from a video: the page's way in.
  uploadVideo: "Upload a video",
  uploadHint: `MP4 or MOV. About a minute is plenty; up to ${MAX_MINUTES} minutes.`,
  dropVideo: "Drop the video to add its products",
  yourShelf: "Your shelf",

  // The page itself: the line under its title, what a bay shows while its
  // photo isn't there, and the way back from the page's views.
  page: {
    onShelf: (products: number, videos: number) => {
      const shelf = `${products} on your shelf`;
      if (videos <= 0) return shelf;
      return videos === 1
        ? `${shelf}, from 1 video`
        : `${shelf}, from ${videos} videos`;
    },
    makingPhoto: "Making photo…",
    nextInLine: "Next in line",
    noPhoto: "No photo",
    checkPrice: "Check this price",
    back: "Products",
  },

  // Choosing products on the shelf to make something with them.
  choose: {
    start: "Choose products",
    note: "Choose products to make something from them.",
    chosen: (count: number) => `${count} chosen`,
    clear: "Clear",
    done: "Done",
    makeAd: "Make a video ad",
    makeAdShort: "Video ad",
    makeKit: "Make carousel + order form",
    makeKitShort: "Carousel + form",
    adNote: "A video ad takes 1 to 3 products with photos and prices.",
    region: "Chosen products",
  },

  // Checking what a video found, one card at a time.
  review: {
    title: "Check your products",
    back: "Products",
    acceptAll: (count: number) => `Accept all (${count})`,
    add: "Add to shelf",
    skip: "Skip",
    undo: "Undo",
    sound: "Play your voice on each card",
    hear: "Hear what you said",
    pause: "Pause",
    polished: "Polished",
    original: "As filmed",
    photo: "Photo",
    // Which card of how many is up, beside the title.
    position: (current: number, total: number) => `${current} of ${total}`,
    // The words the price was read from, and when in the video: one line,
    // "You said «кукла бес мың» at 0:33".
    youSaid: "You said",
    shownInVideo: "Shown in your video",
    at: (time: string) => `at ${time}`,
    changeName: "Change the name",
    changePrice: "Change the price",
    // The price field, named by the currency the product's price is in.
    priceIn: (code: string | null) =>
      code === "KZT" ? "Price in tenge" : code ? `Price in ${code}` : "Price",
    currencyCode: "Currency code",
    // Why a typed price can't be saved, with an example written the way its
    // currency writes prices: 1500 yen, 4.99 dollars, 1.250 dinars.
    priceInvalid: (decimals: number) =>
      `Type the price as a number, like ${priceLike(decimals)}.`,
    tooManyDecimals: (code: string, decimals: number) =>
      decimals === 0
        ? `${code} prices have no cents. Type a whole number, like ${priceLike(0)}.`
        : `${code} prices have at most ${decimals} decimals. Type one like ${priceLike(decimals)}.`,
    currencyInvalid: "Type the currency as a 3-letter code, like USD.",
    currencyUnknown: (code: string) =>
      `${code} isn't a currency code we know. Try one like USD.`,
    noPrice: "No price yet",
    chooseShown: "Choose the one your shelf shows",
    showOption: (description: string) => `Show ${description} on your shelf`,
    stampAdd: "Add",
    stampSkip: "Skip",
    added: (name: string) => `${name} added to your shelf.`,
    skipped: (name: string) => `${name} skipped.`,
    allAdded: (count: number) =>
      count === 1
        ? "1 product added to your shelf."
        : `${count} products added to your shelf.`,
    undone: "Undone.",
    saveFailed: "That change couldn't be saved, so it was undone. Try again.",
    loadFailed: "These products couldn't be loaded.",
    nothingLeft: "Nothing is left to check in this video.",
    done: (added: number) =>
      added === 0
        ? "Nothing was added to your shelf."
        : added === 1
          ? "1 product is on your shelf."
          : `${added} products are on your shelf.`,
    skippedCount: (skipped: number) =>
      skipped === 1 ? "1 skipped." : `${skipped} skipped.`,
    backToProducts: "Back to products",
  },
} as const;

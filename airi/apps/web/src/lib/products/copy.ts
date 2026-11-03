// Products is English-only for now, so its copy lives here rather than in the
// en/ru/kz catalogs, whose checks require every locale. Moving it into the
// catalogs later is mechanical: every string the section shows is in this
// file and the parts it joins.
//
// Each part of the section keeps its copy in its own file: copy-shelf.ts (the
// page, its shelf and the review), copy-stage.ts (adding products from a
// video), copy-make.ts (what the owner makes for WhatsApp, and the list of
// what was made) and copy-ad.ts (video ads). PRODUCTS_COPY joins them, and a
// key in two parts fails the type check rather than replacing the other.

import { AD_COPY } from "./copy-ad";
import { MAKE_COPY } from "./copy-make";
import { SHELF_COPY } from "./copy-shelf";
import { STAGE_COPY } from "./copy-stage";

const BASE_COPY = {
  navLabel: "Products",

  // Sending shelf videos to Airi on WhatsApp, and what Airi writes back.
  whatsapp: {
    sendFromWhatsApp: "Send from WhatsApp",
    panelTitle: "Send videos from your phone",
    panelSteps:
      "Scan this with your phone's camera and press Send in WhatsApp. Then confirm your phone here.",
    openWhatsApp: "Open WhatsApp",
    makingQr: "Getting your QR code ready…",
    qrFailed: "The QR code couldn't be made. Try again.",
    // A phone's message names the shop and nothing else, so no phone is
    // linked under a name another shop in airi has.
    shopNameTaken:
      "Another shop in airi has the same name, so a phone's message can't say which shop it means. Contact airi to change your shop's name.",
    askPhone: (phone: string) => `Is ${phone} your phone?`,
    // Kept apart from the number, so a name can't pass for one.
    profileName: (name: string) => `WhatsApp name: ${name}`,
    confirmPhone: "Yes, link it",
    denyPhone: "Not me",
    severalAsked: "More than one phone asked. Only link the one you recognise.",
    linkedPhone: (phone: string) => `Linked: ${phone}`,
    unlink: "Unlink",
    linkAnother: "Link another phone",
    linkedSteps: (number: string) =>
      `Shelf videos you send to Airi at ${number} turn up here.`,
    businessNumbers: (numbers: readonly string[]) =>
      numbers.length === 1
        ? `Or send videos straight from your shop's WhatsApp Business number ${numbers[0]}. No linking needed.`
        : `Or send videos straight from your shop's WhatsApp Business numbers ${numbers.slice(0, -1).join(", ")} or ${numbers[numbers.length - 1]}. No linking needed.`,
    actionFailed: "That didn't work. Try again.",
    requestExpired:
      "That request has expired. Send the message from your phone again.",
    phoneLinkedElsewhere:
      "This phone is linked to another shop in airi. Unlink it there first, then send the message from your phone again.",
    // What the QR writes in WhatsApp: nothing secret, only the shop's name.
    // The phone is linked once an admin confirms it in airi.
    linkMessage: (shop: string) =>
      `Hi Airi! Please link this phone to my shop ${shop}.`,
    linked: (workspace: string) =>
      `You're linked to ${workspace}. Send me a video of your products: hold each one up and say its name and price, and the currency at least once. I'll put them in airi for you to check.`,
    // Airi's answers on WhatsApp to a phone asking to be linked.
    confirmInAiri: (shop: string) =>
      `Open airi and confirm this phone to link it to ${shop}.`,
    alreadyLinked: (shop: string) =>
      `This phone is already linked to ${shop}. Send me a video of your products.`,
    linkedElsewhere:
      "This phone is linked to another shop in airi. Unlink it there first.",
    openProducts:
      "Open Products in airi, choose Send from WhatsApp, and send the message from there.",
    askToAdd: (workspace: string) =>
      `Should I add the products you just sent to ${workspace}?`,
    addButton: "Add them",
    skipButton: "No",
    ready: (count: number, link: string) =>
      count === 1
        ? `I found 1 product in your video. Check it before it goes on your shelf: ${link}`
        : `I found ${count} products in your video. Check them before they go on your shelf: ${link}`,
    // `stopped` is PRODUCTS_COPY.photosStopped's sentence.
    readyPartial: (count: number, stopped: string, link: string) =>
      count === 1
        ? `I found 1 product in your video. ${stopped} Check it before it goes on your shelf: ${link}`
        : `I found ${count} products in your video. ${stopped} Check them before they go on your shelf: ${link}`,
    failedPartial: (count: number, link: string) =>
      count === 1
        ? `Something went wrong after I found 1 product. Check what was found: ${link}`
        : `Something went wrong after I found ${count} products. Check what was found: ${link}`,
  },
} as const;

export const PRODUCTS_COPY = {
  ...BASE_COPY,
  ...SHELF_COPY,
  ...STAGE_COPY,
  ...MAKE_COPY,
  ...AD_COPY,
} as const;

type Overlap<A, B> = Extract<keyof A, keyof B>;
type SharedKeys =
  | Overlap<typeof BASE_COPY, typeof SHELF_COPY>
  | Overlap<typeof BASE_COPY, typeof STAGE_COPY>
  | Overlap<typeof BASE_COPY, typeof MAKE_COPY>
  | Overlap<typeof BASE_COPY, typeof AD_COPY>
  | Overlap<typeof SHELF_COPY, typeof STAGE_COPY>
  | Overlap<typeof SHELF_COPY, typeof MAKE_COPY>
  | Overlap<typeof SHELF_COPY, typeof AD_COPY>
  | Overlap<typeof STAGE_COPY, typeof MAKE_COPY>
  | Overlap<typeof STAGE_COPY, typeof AD_COPY>
  | Overlap<typeof MAKE_COPY, typeof AD_COPY>;
type OnlyTrue<T extends true> = T;
/**
 * A key in two parts would silently replace the earlier part's: the type
 * check fails here instead, naming the key.
 */
export type ProductsCopyPartsShareNoKey = OnlyTrue<
  [SharedKeys] extends [never] ? true : SharedKeys
>;

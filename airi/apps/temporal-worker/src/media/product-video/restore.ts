import {
  editMetaImage,
  type MetaRequestOptions,
} from "@icecore/airi-runtime/meta-model-api";
import sharp from "sharp";
import { askMuseAboutImages, type AskMuseDeps } from "./ask-muse";
import { whilePulsing } from "./pulse";

// The owner holds every product while filming, so the hand always hides part
// of it. Muse Image redraws the product whole, upright, on white; a second
// look by Muse Spark checks it is still the same product before it's used.

export type RestoreDeps = AskMuseDeps & {
  editMetaImage?: typeof editMetaImage;
};

// Each sentence earned its place on the 7-product test video. Without
// "upright ... from the front" Muse left a cup tilted the way it was held;
// without the last sentence it cleaned up a doll's paint marks. "Same
// position, size, angle" reads as if it fights "upright", but together they
// kept every part in two runs of 7 out of 7; a version that only asked to
// keep the filmed side towards the camera dropped a phone stand's base.
// Products are restored on a plain colour they have little of (see
// chooseBackdrop), and openings are kept open, so the backdrop showing
// through them can be cut away. Without the lighting sentence Muse lit a
// white medal hanger from above: the shelf shaded the plate below it a grey
// that, on a grey backdrop, tore its slots when cut out.
// The overlay sentence came from an edited promo: Muse kept a burned-in
// "from 35 000" caption on a table's legs as if it were printed there, and
// redrew a half-hidden second panel below a family-tree panel. On the same
// promo a medal hanger's name was hidden under a price sticker in every frame
// and Muse wrote garbled letters there: lettering the video hid is now an
// example, spelled right, written in place of any letters that show (told
// only the example, Muse once kept a guess at the visible half of the name
// before it). The hanger also ran past the frame on both sides; given room
// around it, Muse completed its ends to match.
export type RestoreBackdrop = "white" | "grey" | "charcoal";

/**
 * What a product is restored on, and whether the backdrop showing through
 * its holes can then be cut away: neutral mid-grey, which few products are
 * made of, unless the product has noticeable grey; then whichever of grey,
 * white and charcoal it has least of. Grey in a mostly white product is its
 * shading, which on grey tore a medal hanger's slots and kept shadows between
 * its letters; on charcoal its shading stays far lighter than the backdrop.
 * White was the riskier default: Muse painted a white backing board behind a
 * carved panel's openwork, and a white product's edges went with the
 * backdrop. On grey and charcoal, holes are always cut: the product has
 * little of that colour, while a hole shows Muse's flat backdrop. On white,
 * only when the product has almost no white.
 */
export function chooseBackdrop(shares: {
  white: number;
  grey: number;
  dark: number;
}): { backdrop: RestoreBackdrop; holes: boolean } {
  let backdrop: RestoreBackdrop = "grey";
  if (shares.grey > 0.02) {
    const least = Math.min(shares.grey, shares.white, shares.dark);
    if (least < shares.grey)
      backdrop = shares.white === least ? "white" : "charcoal";
  }
  return { backdrop, holes: backdrop !== "white" || shares.white <= 0.02 };
}

/** What Muse Image is asked to put behind a restored photo. */
export function backdropWords(backdrop: RestoreBackdrop): string {
  if (backdrop === "grey")
    return "a plain, flat mid-grey background, the same grey everywhere";
  if (backdrop === "charcoal")
    return "a plain, flat dark charcoal background (#2b2b2b), the same dark grey everywhere";
  return "a plain pure white background";
}

const EXAMPLE_NAMES = {
  kk: [
    "Айбек Нұрланұлы",
    "Ерлан Асқарұлы",
    "Нұрлан Қайратұлы",
    "Дәурен Серікұлы",
    "Арман Болатұлы",
    "Мейрам Темірұлы",
  ],
  ru: [
    "Алексей Смирнов",
    "Иван Петров",
    "Дмитрий Волков",
    "Сергей Козлов",
    "Андрей Морозов",
    "Михаил Соколов",
  ],
  en: [
    "Anna Smith",
    "John Brown",
    "Emma Wilson",
    "James Taylor",
    "Olivia Clark",
    "David Lewis",
  ],
};

/**
 * A plausible full name for a name Muse can't read, in the narration's
 * language: personalised products carry the buyer's name, and an example
 * looks right where a garbled one doesn't. The `index`th of a few, so the
 * hidden names of one family tree don't all read the same.
 */
export function exampleName(
  language: string | null | undefined,
  index = 0,
): string {
  const names = /kaz|қаз|^kk$/i.test(language ?? "")
    ? EXAMPLE_NAMES.kk
    : /rus|рус|^ru$/i.test(language ?? "")
      ? EXAMPLE_NAMES.ru
      : EXAMPLE_NAMES.en;
  return names[index % names.length]!;
}

/** A piece of lettering on the product, as Muse Spark read it in the video. */
export type Lettering = {
  /** Where it is on the product, in a few English words. */
  where: string;
  /** The words exactly as written, or an example where they can't be read. */
  text: string;
  /** False when `text` is an example standing in for hidden words. */
  readable: boolean;
  /** A person's name, like a buyer's on a personalised product. */
  personName: boolean;
};

const MAX_LETTERING = 6;

/**
 * The lettering on the product in its filmed crop. Muse Image copied a name
 * half hidden under a price sticker as garbled letters; given words to write
 * there, it writes them. Words that are covered, cut off or too blurred to
 * read come back as a plausible example in the same language, and a
 * person's name as a default full name: left to make one up, Muse Spark
 * built it from the letters that showed, and Muse Image then mixed the two
 * into a name that was neither.
 */
export async function readLettering(
  request: { crop: Buffer; product: string; language: string | null },
  deps: AskMuseDeps = {},
  options?: MetaRequestOptions,
): Promise<Lettering[]> {
  const answer = await askMuseAboutImages<{ lettering: unknown }>(
    {
      images: [request.crop],
      question:
        `This is a frame from a shop's video showing a ${request.product}. List the lettering printed, engraved or written ` +
        `on the product itself, not captions, subtitles, prices or stickers laid over the video, at most ${MAX_LETTERING} pieces: ` +
        `where each is on the product, in a few English words; its text exactly as written; whether all of it can be read ` +
        `for sure; and whether it is a person's name, like a buyer's name on a personalised product. Text with any letter ` +
        `covered (by a hand, a sticker or a caption), cut off or too blurred can't be read for sure: give instead a ` +
        `plausible example in the same language and style, with readable false. An empty list when the product has no lettering.`,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["lettering"],
        properties: {
          lettering: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["where", "text", "readable", "person_name"],
              properties: {
                where: { type: "string" },
                text: { type: "string" },
                readable: { type: "boolean" },
                person_name: { type: "boolean" },
              },
            },
          },
        },
      },
      purpose: "read lettering",
    },
    deps,
    options,
  );
  if (!Array.isArray(answer.lettering)) return [];
  let names = 0;
  return answer.lettering
    .flatMap((entry): Lettering[] => {
      if (!entry || typeof entry !== "object") return [];
      const { where, text, readable, person_name } = entry as Record<
        string,
        unknown
      >;
      if (typeof text !== "string" || !text.trim()) return [];
      const hidden = readable === false;
      const personName = person_name === true;
      return [
        {
          where: typeof where === "string" ? where.trim().slice(0, 80) : "",
          text:
            hidden && personName
              ? exampleName(request.language, names++)
              : text.trim().slice(0, 80),
          readable: !hidden,
          personName,
        },
      ];
    })
    .slice(0, MAX_LETTERING);
}

/** How the product's lettering is written, as quoted pieces with their places. */
const quoted = (pieces: Lettering[]) =>
  pieces
    .map((piece) => `"${piece.text}"${piece.where ? ` (${piece.where})` : ""}`)
    .join("; ");

/**
 * The prompt's sentence about the product's lettering. Only words the video
 * hid are written in, and the rest kept: given every piece Muse Spark could
 * read, Muse Image dropped the rest of a family tree's names, and told to
 * make up examples itself, it wrote a name over a table's caption. But a
 * personalised product's half-hidden name is only replaced whole when Muse
 * Image is told all of the product's lettering (when Muse Spark listed fewer
 * pieces than it may): told just the name, it wrote a guess at the half that
 * showed and put the name under it; told all of it, the medal hanger came
 * out with the name alone in 3 of 3 runs.
 */
function letteringWords(lettering: Lettering[]): string {
  const hidden = lettering.filter((piece) => !piece.readable);
  if (hidden.length === 0) return "";
  if (
    hidden.some((piece) => piece.personName) &&
    lettering.length < MAX_LETTERING
  )
    return (
      `Its lettering, each piece written exactly as given here, in its place and in the same style and colour, ` +
      `instead of all the words there now, even partly visible ones: ${quoted(lettering)}. `
    );
  return (
    `Where its lettering is hidden or can't be read, write exactly this instead, in the same style and colour, ` +
    `in place of any letters that show there: ${quoted(hidden)}. Keep all its other lettering as it is. `
  );
}

export function restorePrompt(
  product: string,
  backdrop: RestoreBackdrop = "grey",
  options: { completes?: boolean; lettering?: Lettering[] } = {},
): string {
  return (
    `Product photo cleanup of a ${product}. Remove the person's hand and fingers completely. ` +
    `Where the hand covered the ${product}, restore the hidden part so the product is whole, ` +
    `continuing its exact shape, color, material and any print or logo. Do not change anything else ` +
    `about the product: same position, size, angle, colors, text and details. ` +
    (options.completes
      ? `The product runs past the edges of the photo: complete the parts that are cut off, as they continue, ` +
        `and where one end is cut off, make it match the other end. Show the whole product with some space around it. `
      : "") +
    letteringWords(options.lettering ?? []) +
    `Never write garbled letters. ` +
    `Replace everything around the product with ${backdropWords(backdrop)}. ` +
    `Light it evenly from the front, like a studio catalog photo: no shadows or dark shading on the product or the background, and no new objects. ` +
    `Where the product has openings, like slots or carved openwork, that background shows through them: don't fill them. ` +
    `Also remove whatever is not part of this one product: people, other products or parts of them, and ` +
    `captions, subtitles, prices, stickers or logos laid over the video, restoring the product underneath. ` +
    `Text that is printed, engraved or written on the product itself stays. ` +
    `Show the product standing upright and straight, seen from the front, centred. ` +
    `This is a real item for sale: do not retouch, beautify or idealise it; keep its real wear, scuffs, ` +
    `paint marks and imperfections exactly as they are.`
  );
}

/** Muse Image's size for a crop: the ratio closest to its shape. */
export function restoreSize(width: number, height: number): string {
  const ratio = width / Math.max(1, height);
  if (ratio < 0.8) return "1024x1536";
  if (ratio > 1.25) return "1536x1024";
  return "1024x1024";
}

/** The product redrawn whole, upright and on a plain backdrop, as an opaque PNG. */
export async function restoreProductPhoto(
  request: {
    crop: Buffer;
    width: number;
    height: number;
    product: string;
    backdrop?: RestoreBackdrop;
    /** The product runs past the crop's edges, with room left to complete it. */
    completes?: boolean;
    lettering?: Lettering[];
  },
  deps: RestoreDeps = {},
  options?: MetaRequestOptions,
): Promise<Buffer> {
  const result = await whilePulsing(deps.pulse, () =>
    (deps.editMetaImage ?? editMetaImage)(
      {
        prompt: restorePrompt(request.product, request.backdrop, {
          completes: request.completes,
          lettering: request.lettering,
        }),
        images: [{ data: request.crop, mimeType: "image/jpeg" }],
      },
      { ...options, size: restoreSize(request.width, request.height) },
    ),
  );
  deps.onCost?.(result.costUsd, "restore photo");
  return result.image;
}

export type SameProductAnswer = {
  same: boolean;
  /** What a buyer would see differently, when not the same. */
  difference: string | null;
};

/** Whether the restored photo still shows the product from the video. */
export async function checkSameProduct(
  request: {
    original: Buffer;
    restored: Buffer;
    product: string;
    /** The product runs past image 1's edges, and image 2 completes it. */
    completed?: boolean;
  },
  deps: AskMuseDeps = {},
  options?: MetaRequestOptions,
): Promise<SameProductAnswer> {
  const answer = await askMuseAboutImages<SameProductAnswer>(
    {
      images: [request.original, request.restored],
      question:
        `Image 1 is a frame from a shop owner's video showing a ${request.product}, possibly held in a hand. ` +
        `Image 2 is a cleaned-up product photo made from it: the hand removed, the hidden part restored, ` +
        `the background replaced, the product stood upright and level. Is image 2 the same product as image 1, ` +
        `with the same type, shape, colours, print and details? Parts missing from image 2, and details invented on sides image 1 doesn't show, count as ` +
        `differences. Captions, subtitles, price stickers and logos laid over the video in image 1, and people or other items around the product, ` +
        `are not part of it, so their absence is not a difference; but such a caption, price or sticker shown in image 2 as if ` +
        `printed on the product is one. Lettering covered or unreadable in image 1 may be an example in image 2, ` +
        `which is not a difference either. ` +
        (request.completed
          ? `The product runs past the edges of image 1; parts image 2 completes beyond them are expected when they match the visible parts. `
          : "") +
        `Answer same=false only if a buyer who received ` +
        `the item in image 1 would feel misled by image 2; then say what differs in one short English sentence ` +
        `as difference, otherwise difference=null.`,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["same", "difference"],
        properties: {
          same: { type: "boolean" },
          difference: { type: ["string", "null"] },
        },
      },
      purpose: "same product check",
    },
    deps,
    options,
  );
  return {
    same: answer.same === true,
    difference:
      typeof answer.difference === "string" && answer.difference.trim()
        ? answer.difference.trim().slice(0, 300)
        : null,
  };
}

/** A transparent cut-out as the JPEG on white that Muse Spark looks at. */
export async function cutoutForMuse(cutout: Buffer): Promise<Buffer> {
  return sharp(cutout)
    .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 88 })
    .toBuffer();
}

/**
 * Whether the levelled cut-out is the better catalog photo. The angle comes
 * from the outline; Muse Spark only confirms that straight is right, so a
 * product meant to lean isn't turned.
 */
export async function prefersLevel(
  request: { turned: Buffer; level: Buffer; product: string },
  deps: AskMuseDeps = {},
  options?: MetaRequestOptions,
): Promise<boolean> {
  const answer = await askMuseAboutImages<{ better: number }>(
    {
      images: [
        await cutoutForMuse(request.turned),
        await cutoutForMuse(request.level),
      ],
      question:
        `Images 1 and 2 show the same ${request.product}; image 2 is image 1 turned to stand level. ` +
        `Which is the better catalog photo: the one showing the product straight, the way it normally hangs, ` +
        `stands or lies? Answer 2 only if the product looks straighter and natural in image 2; answer 1 if it is ` +
        `meant to look as in image 1.`,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["better"],
        properties: { better: { type: "integer", enum: [1, 2] } },
      },
      purpose: "level check",
    },
    deps,
    options,
  );
  return answer.better === 2;
}

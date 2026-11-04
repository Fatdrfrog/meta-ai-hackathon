import "server-only";
import { logger } from "@/lib/logger";
import {
  KIT_CAROUSEL_MAX_CARDS,
  KIT_CAROUSEL_MIN_CARDS,
} from "@/lib/products/kit-text";
import {
  getFirstZodIssueMessage,
  parseWhatsAppTemplateSubmissionComponents,
} from "@/lib/whatsapp/templates/component-schemas";
import { getWhatsAppOfficialMediaMaxBytes } from "@/lib/whatsapp/media-types";
import { storeWhatsAppTemplateHeaderMedia } from "@/lib/whatsapp/templates/header-media-storage";
import { PRODUCT_KIT_COMPONENTS_MAX_BYTES } from "@/models/product-kit";
import { DEFAULT_GCS_CREATIVE_ASSETS_BUCKET } from "@icecore/airi-runtime/media-api";
import { StorageQuotaError } from "@icecore/airi-runtime/storage-quota";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";

// The owner's edit of a kit's carousel, as the template editor saved it,
// checked before anything goes to Meta: a marketing carousel of 2 to 10
// image cards, each picture on this project's own storage, under a name
// Meta takes, small enough to keep on the kit.

/** A template name Meta takes. */
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
/** Where Supabase serves stored objects, public or signed. */
const SUPABASE_OBJECT_PATH = "/storage/v1/object/";
const GCS_HOST = "storage.googleapis.com";

/**
 * The bucket airi's Assets keep their files in. The template editor's
 * "Choose asset" gives a signed link to it, so a picture from there is on
 * airi's storage too, though not on Supabase.
 */
const creativeAssetsBucket = () =>
  process.env.GCS_CREATIVE_ASSETS_BUCKET?.trim() ||
  DEFAULT_GCS_CREATIVE_ASSETS_BUCKET;

function supabaseOrigin(): string | null {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").origin;
  } catch {
    return null;
  }
}

/**
 * Whether a card's picture is on this project's own storage: a Supabase
 * Storage object (the editor's own uploads and the kit's cards), or a file
 * in airi's Assets bucket (the editor's "Choose asset"). Any other host is
 * refused, so nothing outside airi is fetched for Meta.
 */
export function isKitCardImageUrl(value: unknown): boolean {
  return cardImageStore(value) !== null;
}

/** Which of this project's stores a card's picture is on; null for anywhere else. */
function cardImageStore(value: unknown): "supabase" | "assets" | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const origin = supabaseOrigin();
  if (origin && url.origin === origin)
    return url.pathname.startsWith(SUPABASE_OBJECT_PATH) ? "supabase" : null;
  const bucket = creativeAssetsBucket();
  if (url.port) return null;
  const inBucket =
    url.hostname === GCS_HOST
      ? url.pathname.startsWith(`/${bucket}/`)
      : url.hostname === `${bucket}.${GCS_HOST}`;
  return inBucket ? "assets" : null;
}

type Card = { components?: unknown };
type Part = { type?: unknown; format?: unknown; example?: unknown };

/** The picture link of a card whose header is an image; "video" or null for any other card. */
function cardImage(card: Card): string | "video" | null {
  const parts = Array.isArray(card.components)
    ? (card.components as Part[])
    : [];
  const header = parts.find(part => part?.type === "HEADER");
  if (header?.format === "VIDEO") return "video";
  if (!header || header.format !== "IMAGE") return null;
  const handle = (header.example as { header_handle?: unknown } | undefined)
    ?.header_handle;
  return Array.isArray(handle) && typeof handle[0] === "string"
    ? handle[0]
    : null;
}

/** The carousel's own problems, past the template checks; the first few only. */
function shapeIssues(components: readonly Part[]): string[] {
  const count = (type: string) =>
    components.filter(component => component.type === type).length;
  if (count("BODY") !== 1)
    return ["The carousel needs one message above its cards."];
  if (count("CAROUSEL") !== 1) return ["The template has to be a carousel."];
  if (count("HEADER") + count("FOOTER") + count("BUTTONS") > 0)
    return [
      "A carousel has only a message and its cards: no header, footer or buttons of its own.",
    ];
  const carousel = components.find(component => component.type === "CAROUSEL");
  const cards = (carousel as { cards?: unknown } | undefined)?.cards;
  const list = Array.isArray(cards) ? (cards as Card[]) : [];
  if (
    list.length < KIT_CAROUSEL_MIN_CARDS ||
    list.length > KIT_CAROUSEL_MAX_CARDS
  )
    return [
      `A carousel has ${KIT_CAROUSEL_MIN_CARDS} to ${KIT_CAROUSEL_MAX_CARDS} cards.`,
    ];
  const issues: string[] = [];
  list.forEach((card, index) => {
    const image = cardImage(card);
    if (image === "video")
      issues.push(`Card ${index + 1} shows a video: kit cards show pictures.`);
    else if (image === null)
      issues.push(`Card ${index + 1} needs a picture: every card shows one.`);
    else if (!isKitCardImageUrl(image))
      issues.push(
        `Card ${index + 1}'s picture has to be uploaded in the editor or chosen from your Assets.`
      );
  });
  return issues;
}

/**
 * The owner's carousel as it goes to Meta and is kept on the kit, or what's
 * wrong with it: the name, the size kept, Meta's template rules for a
 * marketing template, and the carousel's own shape and pictures.
 */
export function parseCarouselEdit(
  name: unknown,
  components: unknown
):
  | { ok: true; name: string; components: WhatsAppComponent[] }
  | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (typeof name !== "string" || !TEMPLATE_NAME.test(name))
    issues.push(
      "The template name can have only small letters, digits and underscores."
    );
  if (!Array.isArray(components))
    return { ok: false, issues: [...issues, "The carousel has no cards."] };
  let json: string;
  try {
    json = JSON.stringify(components);
  } catch {
    return { ok: false, issues: [...issues, "The carousel can't be read."] };
  }
  if (new TextEncoder().encode(json).length > PRODUCT_KIT_COMPONENTS_MAX_BYTES)
    return {
      ok: false,
      issues: [
        ...issues,
        "The carousel is too big to keep: shorten its texts.",
      ],
    };
  const checked = parseWhatsAppTemplateSubmissionComponents(
    JSON.parse(json),
    "MARKETING"
  );
  if (!checked.success)
    return {
      ok: false,
      issues: [
        ...issues,
        getFirstZodIssueMessage(
          checked.error,
          "The carousel isn't a valid template."
        ),
      ],
    };
  issues.push(...shapeIssues(checked.data as Part[]));
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    name: name as string,
    components: checked.data as WhatsAppComponent[],
  };
}

/** What's wrong with the owner's carousel; empty when it can go to Meta. */
export function checkCarouselComponents(
  name: unknown,
  components: unknown
): string[] {
  const parsed = parseCarouselEdit(name, components);
  return parsed.ok ? [] : parsed.issues;
}

const PICTURE_FETCH_TIMEOUT_MS = 15_000;
const PICTURE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
};

/** A picture from airi's Assets, as bytes WhatsApp takes for a card. */
async function downloadAssetPicture(
  url: string
): Promise<{ buffer: Buffer; mimeType: string; extension: string }> {
  // Only the Assets bucket was checked: a redirect anywhere else isn't followed.
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(PICTURE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`Asset download failed: ${response.status}`);
  const mimeType = (response.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  const extension = PICTURE_TYPES[mimeType];
  if (!extension) throw new Error(`Asset is ${mimeType || "not an image"}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > getWhatsAppOfficialMediaMaxBytes("image"))
    throw new Error("Asset too large for a card");
  return { buffer, mimeType, extension };
}

/**
 * The carousel with every picture chosen from airi's Assets copied to the
 * template media on Supabase Storage, where the editor's own uploads and
 * the kit's cards are: an Assets link is signed for an hour only, and the
 * kit keeps its cards for "Edit and send again" and Try again. Pictures
 * already on Supabase are left as they are. Issues for pictures that
 * couldn't be copied; a full storage throws StorageQuotaError.
 */
export async function keepCardPictures(
  workspaceId: string,
  components: WhatsAppComponent[]
): Promise<
  | { ok: true; components: WhatsAppComponent[] }
  | { ok: false; issues: string[] }
> {
  const copy = JSON.parse(JSON.stringify(components)) as WhatsAppComponent[];
  const carousel = copy.find(component => component.type === "CAROUSEL");
  if (!carousel || carousel.type !== "CAROUSEL")
    return { ok: true, components };
  const issues: string[] = [];
  await Promise.all(
    carousel.cards.map(async (card, index) => {
      const header = card.components.find(part => part.type === "HEADER") as
        | { example?: { header_handle?: string[] } }
        | undefined;
      const url = header?.example?.header_handle?.[0];
      if (!url || cardImageStore(url) !== "assets") return;
      try {
        const picture = await downloadAssetPicture(url);
        const stored = await storeWhatsAppTemplateHeaderMedia({
          workspaceId,
          fileName: `card-${index + 1}.${picture.extension}`,
          buffer: picture.buffer,
          mimeType: picture.mimeType,
        });
        header!.example!.header_handle = [stored.url];
      } catch (error) {
        if (error instanceof StorageQuotaError) throw error;
        logger.warn("[Products] kit card picture not copied from Assets", {
          event: "products.kit_card_asset_copy_failed",
          workspaceId,
          card: index + 1,
          error: error instanceof Error ? error.message : String(error),
        });
        issues.push(
          `Card ${index + 1}'s picture couldn't be copied from your Assets: choose it again, or upload it.`
        );
      }
    })
  );
  return issues.length > 0
    ? { ok: false, issues: issues.sort() }
    : { ok: true, components: copy };
}

/** How many cards a checked carousel has. */
export function carouselCardCount(
  components: readonly WhatsAppComponent[]
): number {
  const carousel = components.find(component => component.type === "CAROUSEL");
  return carousel && carousel.type === "CAROUSEL" ? carousel.cards.length : 0;
}

import type {
  ProductAdCtwaRecord,
  ProductAdCtwaRequest,
  ProductAdCtwaResponse,
  ProductAdCtwaRunRequest,
  ProductAdPostRecord,
  ProductAdPublishRequest,
  ProductAdPublishResponse,
  ProductsMetaReadiness,
  ProductsMetaReadinessResponse,
} from "@/lib/products/types";
import {
  ProductDraftError,
  productAdUrl,
  productsApiUrl,
  sendForAnswer,
} from "./products-client";

// Requests studio v3's Meta actions make: posting an ad on Instagram, its
// Click-to-WhatsApp ad, and what the workspace can do on Meta now. Failures
// the workbench explains throw a ProductDraftError with the API's code
// (instagram_not_connected, post_busy, page_whatsapp_missing…).

/** How often the workbench asks for a post or the WhatsApp ad while Meta makes it. */
export const PRODUCT_META_POLL_MS = 3000;

/** How long the workbench polls a post before "Still processing at Instagram". */
export const PRODUCT_POST_POLL_LIMIT_MS = 4 * 60_000;

/**
 * What the workspace can do on Meta now (GET, cached 60 s on the server).
 * `fresh` reads it again past the cache ("Check again"); SWR keys use the
 * plain address.
 */
export function productsMetaUrl(
  workspaceId: string,
  options: { fresh?: boolean } = {}
): string {
  const url = `${productsApiUrl(workspaceId)}/meta`;
  return options.fresh ? `${url}?fresh=1` : url;
}

/** Posting the ad on Instagram. */
export function productAdPublishUrl(workspaceId: string, adId: string): string {
  return `${productAdUrl(workspaceId, adId)}/publish`;
}

/** One post of the ad: asking for it advances it. */
export function productAdPostUrl(
  workspaceId: string,
  adId: string,
  postId: string
): string {
  return `${productAdPublishUrl(workspaceId, adId)}/${encodeURIComponent(postId)}`;
}

/** The ad's Click-to-WhatsApp ad: asking for it advances it one step. */
export function productAdCtwaUrl(workspaceId: string, adId: string): string {
  return `${productAdUrl(workspaceId, adId)}/ctwa`;
}

const isPost = (value: unknown): value is ProductAdPostRecord =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ProductAdPostRecord).id === "string" &&
  typeof (value as ProductAdPostRecord).state === "string";

function postOf(
  data: ProductAdPublishResponse | null | undefined
): ProductAdPostRecord {
  if (!isPost(data?.post)) throw new ProductDraftError("failed");
  return data.post;
}

const isCtwa = (value: unknown): value is ProductAdCtwaRecord =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ProductAdCtwaRecord).state === "string" &&
  typeof (value as ProductAdCtwaRecord).attempt === "number";

function ctwaOf(
  data: ProductAdCtwaResponse | null | undefined
): ProductAdCtwaRecord | null {
  if (data?.ctwa === null) return null;
  if (!isCtwa(data?.ctwa)) throw new ProductDraftError("failed");
  return data.ctwa;
}

/** "Post" (after its confirm): the post, Instagram processing it. */
export async function publishAdPost(
  workspaceId: string,
  adId: string,
  request: ProductAdPublishRequest
): Promise<ProductAdPostRecord> {
  return postOf(
    await sendForAnswer<ProductAdPublishResponse>(
      productAdPublishUrl(workspaceId, adId),
      "POST",
      request
    )
  );
}

/** One post, advanced a step first (at most about 8 s on the server). */
export async function loadAdPost(
  workspaceId: string,
  adId: string,
  postId: string
): Promise<ProductAdPostRecord> {
  return postOf(
    await sendForAnswer<ProductAdPublishResponse>(
      productAdPostUrl(workspaceId, adId, postId),
      "GET"
    )
  );
}

/** "Create ad": the Click-to-WhatsApp ad, being made PAUSED. */
export async function createCtwaAd(
  workspaceId: string,
  adId: string,
  request: ProductAdCtwaRequest
): Promise<ProductAdCtwaRecord> {
  const ctwa = ctwaOf(
    await sendForAnswer<ProductAdCtwaResponse>(
      productAdCtwaUrl(workspaceId, adId),
      "POST",
      request
    )
  );
  if (!ctwa) throw new ProductDraftError("failed");
  return ctwa;
}

/** The ad's Click-to-WhatsApp ad, advanced one step first; null when none was asked for. */
export async function loadCtwaAd(
  workspaceId: string,
  adId: string
): Promise<ProductAdCtwaRecord | null> {
  return ctwaOf(
    await sendForAnswer<ProductAdCtwaResponse>(
      productAdCtwaUrl(workspaceId, adId),
      "GET"
    )
  );
}

/** "Run" (after its confirm): the ad, its budget set and switched on. */
export async function runCtwaAd(
  workspaceId: string,
  adId: string,
  request: ProductAdCtwaRunRequest
): Promise<ProductAdCtwaRecord> {
  const ctwa = ctwaOf(
    await sendForAnswer<ProductAdCtwaResponse>(
      `${productAdCtwaUrl(workspaceId, adId)}/run`,
      "POST",
      request
    )
  );
  if (!ctwa) throw new ProductDraftError("failed");
  return ctwa;
}

/** What the workspace can do on Meta now; also an SWR fetcher for productsMetaUrl. */
export async function fetchMetaReadiness(
  url: string
): Promise<ProductsMetaReadiness> {
  const data = await sendForAnswer<ProductsMetaReadinessResponse>(url, "GET");
  if (
    typeof data.meta?.instagram !== "object" ||
    typeof data.meta?.ads !== "object"
  )
    throw new ProductDraftError("failed");
  return data.meta;
}

/** What the workspace can do on Meta now. */
export function loadMetaReadiness(
  workspaceId: string
): Promise<ProductsMetaReadiness> {
  return fetchMetaReadiness(productsMetaUrl(workspaceId));
}

/**
 * "Check again": what the workspace can do on Meta, read past the server's
 * cache. Hand it to SWR as `mutate(refreshMetaReadiness(ws), {revalidate: false})`
 * on the productsMetaUrl(ws) key.
 */
export function refreshMetaReadiness(
  workspaceId: string
): Promise<ProductsMetaReadiness> {
  return fetchMetaReadiness(productsMetaUrl(workspaceId, { fresh: true }));
}

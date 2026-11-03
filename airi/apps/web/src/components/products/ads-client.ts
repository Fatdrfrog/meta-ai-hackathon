import type {
  ProductAdBrief,
  ProductAdBriefResponse,
  ProductAdCreateRequest,
  ProductAdRecord,
  ProductAdResponse,
  ProductAdUpdateRequest,
} from "@/lib/products/types";
import {
  ProductDraftError,
  productAdsUrl,
  productAdUrl,
  sendForAnswer,
} from "./products-client";

// Requests the video ad studio makes. Failures the studio explains throw a
// ProductDraftError with the API's code.

/** What a new ad's brief starts from, for these products. */
export function productAdBriefUrl(
  workspaceId: string,
  productIds: readonly string[]
): string {
  return `${productAdsUrl(workspaceId)}/brief?products=${productIds
    .map(encodeURIComponent)
    .join(",")}`;
}

export function productAdRetryUrl(workspaceId: string, adId: string): string {
  return `${productAdUrl(workspaceId, adId)}/retry`;
}

const isAd = (value: unknown): value is ProductAdRecord =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ProductAdRecord).id === "string" &&
  typeof (value as ProductAdRecord).status === "string" &&
  Array.isArray((value as ProductAdRecord).products);

function adOf(data: ProductAdResponse | null | undefined): ProductAdRecord {
  if (!isAd(data?.ad)) throw new ProductDraftError("failed");
  return data.ad;
}

export async function fetchProductAdBrief(
  url: string
): Promise<ProductAdBrief> {
  const data = await sendForAnswer<ProductAdBriefResponse>(url, "GET");
  if (!Array.isArray(data.brief?.products))
    throw new ProductDraftError("failed");
  return data.brief;
}

/** One ad: what the studio asks for while it's made. */
export async function fetchProductAd(url: string): Promise<ProductAdRecord> {
  return adOf(await sendForAnswer<ProductAdResponse>(url, "GET"));
}

/** "Make the ad": the ad, its first run started. */
export async function createProductAd(
  workspaceId: string,
  request: ProductAdCreateRequest
): Promise<ProductAdRecord> {
  return adOf(
    await sendForAnswer<ProductAdResponse>(
      productAdsUrl(workspaceId),
      "POST",
      request
    )
  );
}

/** "Save and remake the video": the ad, its video being made again. */
export async function updateProductAd(
  workspaceId: string,
  adId: string,
  changes: ProductAdUpdateRequest
): Promise<ProductAdRecord> {
  return adOf(
    await sendForAnswer<ProductAdResponse>(
      productAdUrl(workspaceId, adId),
      "PATCH",
      changes
    )
  );
}

/** "Try again" on a failed ad: the ad, a new run resuming it. */
export async function retryProductAd(
  workspaceId: string,
  adId: string
): Promise<ProductAdRecord> {
  return adOf(
    await sendForAnswer<ProductAdResponse>(
      productAdRetryUrl(workspaceId, adId),
      "POST"
    )
  );
}

/**
 * Saves one of the ad's files under `fileName`. The files are signed links
 * to another origin, where a link's download name is ignored, so the file is
 * fetched and saved from here; if it can't be fetched, it opens in a new tab
 * to save from there.
 */
export async function downloadProductAdFile(
  url: string,
  fileName: string
): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const objectUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    // Long enough for the browser to start saving it.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

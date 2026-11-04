import type {
  ProductAdRecord,
  ProductAdResponse,
  ProductAdVoiceRequest,
  ProductShopWordsCode,
  ProductVoiceCreateRequest,
  ProductVoiceRecord,
  ProductVoiceResponse,
  ProductVoiceSamplesResponse,
  ProductVoiceSource,
} from "@/lib/products/types";
import {
  ProductDraftError,
  productAdUrl,
  productVoiceUrl,
  sendForAnswer,
} from "./products-client";

// Requests the ad's voice picker makes (Part V): the workspace's cloned
// voice, the consent to clone it, "Remove my voice", airi's voices with
// their samples, and an ad read again in another voice. Failures the picker
// explains throw a ProductDraftError with the API's code.

export function productVoiceSamplesUrl(
  workspaceId: string,
  language: ProductShopWordsCode
): string {
  return `${productVoiceUrl(workspaceId)}/samples?language=${language}`;
}

export function productAdVoiceUrl(workspaceId: string, adId: string): string {
  return `${productAdUrl(workspaceId, adId)}/voice`;
}

const voiceOf = (data: ProductVoiceResponse | null | undefined) => {
  const voice = data?.voice;
  if (voice === null) return null;
  if (!voice || typeof voice.state !== "string")
    throw new ProductDraftError("failed");
  return voice;
};

/** The workspace's cloned voice; null for none. */
export async function fetchProductVoice(
  url: string
): Promise<ProductVoiceRecord | null> {
  return voiceOf(await sendForAnswer<ProductVoiceResponse>(url, "GET"));
}

/** GET /products/voice for these products: the video a copy would be made from. */
export function productVoiceSourceUrl(
  workspaceId: string,
  productIds: readonly string[]
): string {
  return `${productVoiceUrl(workspaceId)}?productIds=${encodeURIComponent(productIds.join(","))}`;
}

/** The video a copy of the owner's voice would be made from; null when none of the products came from one. */
export async function fetchProductVoiceSource(
  url: string
): Promise<ProductVoiceSource | null> {
  const data = await sendForAnswer<ProductVoiceResponse>(url, "GET");
  const source = data?.source;
  if (source === null) return null;
  if (!source || typeof source.importId !== "string")
    throw new ProductDraftError("failed");
  return source;
}

/** The consent to clone the owner's voice: the voice, pending or failed with why. */
export async function createProductVoice(
  workspaceId: string,
  request: ProductVoiceCreateRequest
): Promise<ProductVoiceRecord> {
  const voice = voiceOf(
    await sendForAnswer<ProductVoiceResponse>(
      productVoiceUrl(workspaceId),
      "POST",
      request
    )
  );
  if (!voice) throw new ProductDraftError("failed");
  return voice;
}

/** "Remove my voice". */
export async function removeProductVoice(workspaceId: string): Promise<void> {
  await sendForAnswer<ProductVoiceResponse>(
    productVoiceUrl(workspaceId),
    "DELETE"
  );
}

/** airi's voices for an ad in this language, with their samples' links. */
export async function fetchProductVoiceSamples(
  url: string
): Promise<ProductVoiceSamplesResponse> {
  const data = await sendForAnswer<ProductVoiceSamplesResponse>(url, "GET");
  if (!Array.isArray(data?.samples)) throw new ProductDraftError("failed");
  return data;
}

/** The finished ad read in another voice: the ad, its voice run started. */
export async function changeProductAdVoice(
  workspaceId: string,
  adId: string,
  request: ProductAdVoiceRequest
): Promise<ProductAdRecord> {
  const data = await sendForAnswer<ProductAdResponse>(
    productAdVoiceUrl(workspaceId, adId),
    "POST",
    request
  );
  if (!data?.ad || typeof data.ad.id !== "string")
    throw new ProductDraftError("failed");
  return data.ad;
}

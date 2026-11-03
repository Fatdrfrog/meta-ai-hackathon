import type {
  ProductKitCreateRequest,
  ProductKitPart,
  ProductKitPlanResponse,
  ProductKitRecord,
  ProductKitResponse,
  ProductsMadeResponse,
} from "@/lib/products/types";
import {
  ProductDraftError,
  productKitsUrl,
  productKitUrl,
  sendForAnswer,
} from "./products-client";

// Requests the make view and "Made from your shelf" send: kits (a carousel
// and an order form made by one press) and what was made. Failures throw a
// ProductDraftError with the API's code.

/** The make view's plan for these products (and the review they came from). */
export function productKitPlanUrl(
  workspaceId: string,
  productIds: readonly string[],
  importId: string | null
): string {
  const query = new URLSearchParams({ products: productIds.join(",") });
  if (importId) query.set("importId", importId);
  return `${productKitsUrl(workspaceId)}?${query}`;
}

const isKit = (value: unknown): value is ProductKitRecord =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ProductKitRecord).id === "string" &&
  typeof (value as ProductKitRecord).parts === "object";

function kitOf(data: ProductKitResponse): ProductKitRecord {
  if (!isKit(data?.kit)) throw new ProductDraftError("failed");
  return data.kit;
}

export async function fetchProductKitPlan(
  url: string
): Promise<ProductKitPlanResponse> {
  const data = await sendForAnswer<ProductKitPlanResponse>(url, "GET");
  if (!Array.isArray(data.products) || typeof data.whatsapp !== "object")
    throw new ProductDraftError("failed");
  return data;
}

/** Makes the parts asked for; answers once both have settled. */
export async function createProductKit(
  workspaceId: string,
  request: ProductKitCreateRequest
): Promise<ProductKitRecord> {
  return kitOf(
    await sendForAnswer<ProductKitResponse>(
      productKitsUrl(workspaceId),
      "POST",
      request
    )
  );
}

export async function fetchProductKit(url: string): Promise<ProductKitRecord> {
  return kitOf(await sendForAnswer<ProductKitResponse>(url, "GET"));
}

/** Makes one part of a kit again; answers with the kit once it has settled. */
export async function retryProductKitPart(
  workspaceId: string,
  kitId: string,
  part: ProductKitPart
): Promise<ProductKitRecord> {
  return kitOf(
    await sendForAnswer<ProductKitResponse>(
      `${productKitUrl(workspaceId, kitId)}/retry`,
      "POST",
      { part }
    )
  );
}

export async function fetchProductsMade(
  url: string
): Promise<ProductsMadeResponse> {
  const data = await sendForAnswer<ProductsMadeResponse>(url, "GET");
  if (!Array.isArray(data.kits) || !Array.isArray(data.ads))
    throw new ProductDraftError("failed");
  return data;
}

/** A new id for one press of "Make", so sending it again makes nothing twice. */
export function newKitRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function")
    return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function")
    cryptoApi.getRandomValues(bytes);
  else
    for (let index = 0; index < bytes.length; index += 1)
      bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** The owner's time zone, for the time in the order form's name. */
export function ownerTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

import type {
  ProductKitCreateRequest,
  ProductKitDraftsRequest,
  ProductKitDraftsResponse,
  ProductKitEditRequest,
  ProductKitEditSourceResponse,
  ProductKitPart,
  ProductKitPlanResponse,
  ProductKitRecord,
  ProductKitResponse,
  ProductKitSendTestRequest,
  ProductKitSendTestResponse,
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

// ------------------------------------------------------------ kit editing

export function productKitDraftsUrl(workspaceId: string): string {
  return `${productKitsUrl(workspaceId)}/drafts`;
}

export function productKitEditUrl(
  workspaceId: string,
  kitId: string,
  part?: ProductKitPart
): string {
  const url = `${productKitUrl(workspaceId, kitId)}/edit`;
  return part ? `${url}?part=${encodeURIComponent(part)}` : url;
}

/**
 * "Edit cards" before Make: the carousel the shelf would make for these
 * products, as template components, for the template editor to open.
 */
export async function prepareProductKitDrafts(
  workspaceId: string,
  request: ProductKitDraftsRequest
): Promise<ProductKitDraftsResponse> {
  const data = await sendForAnswer<ProductKitDraftsResponse>(
    productKitDraftsUrl(workspaceId),
    "POST",
    request
  );
  if (!Array.isArray(data?.carousel?.components))
    throw new ProductDraftError("failed");
  return data;
}

/** "Edit and send again" / "Edit order form": what was sent, to open the editor with. */
export async function loadProductKitEditSource(
  workspaceId: string,
  kitId: string,
  part: ProductKitPart
): Promise<ProductKitEditSourceResponse> {
  const data = await sendForAnswer<ProductKitEditSourceResponse>(
    productKitEditUrl(workspaceId, kitId, part),
    "GET"
  );
  if (!isKit(data?.kit)) throw new ProductDraftError("failed");
  return data;
}

/**
 * Sends one made part again with the owner's edits; answers with the kit
 * once it has settled. A 409 carousel_found throws with the kit as it now
 * is (`error.kit`); a 400 throws with the failed checks (`error.issues`).
 */
export async function sendProductKitPartEdit(
  workspaceId: string,
  kitId: string,
  request: ProductKitEditRequest
): Promise<ProductKitRecord> {
  return kitOf(
    await sendForAnswer<ProductKitResponse>(
      productKitEditUrl(workspaceId, kitId),
      "POST",
      request
    )
  );
}

/** Stretch S1, "Send me the order form": the published form to the owner's test phone. */
export async function sendProductKitFormTest(
  workspaceId: string,
  kitId: string
): Promise<void> {
  await sendForAnswer<ProductKitSendTestResponse>(
    `${productKitUrl(workspaceId, kitId)}/send-test`,
    "POST",
    { part: "orderForm" } satisfies ProductKitSendTestRequest
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

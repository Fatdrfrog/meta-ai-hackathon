import type {
  WhatsAppCatalogImportBatchInput,
  WhatsAppCatalogImportBatchResult,
  WhatsAppCatalogImportProduct,
} from "@icecore/temporal";
import {
  formatCatalogBatchPrice,
  normalizeCurrency,
} from "@icecore/whatsapp/formatCatalogBatchPrice";
import { heartbeat } from "@temporalio/activity";

const GRAPH_API_VERSION = "v25.0";

function graphUrl(path: string): string {
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/${path.replace(/^\/+/, "")}`;
}

function normalizeInventory(value: string | number | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("inventory must be a non-negative integer");
  }
  return parsed;
}

function appendBatchField(
  data: Record<string, unknown>,
  key: string,
  value: unknown,
) {
  if (value === undefined || value === null) return;
  if (typeof value === "string" && !value.trim()) return;
  data[key] = value;
}

function toItemsBatchData(item: WhatsAppCatalogImportProduct) {
  const currency = normalizeCurrency(item.currency);
  const data: Record<string, unknown> = {
    id: item.retailer_id,
    title: item.name,
    description: item.description,
    price: formatCatalogBatchPrice(item.price, currency),
    link: item.url,
    image: [{ url: item.image_url }],
    availability: item.availability || "in stock",
    condition: item.condition || "new",
  };

  appendBatchField(data, "brand", item.brand);
  if (item.additional_image_urls?.length) {
    data.additional_image_link = item.additional_image_urls
      .map((url) => String(url).trim())
      .filter(Boolean);
  }
  if (item.sale_price !== undefined) {
    data.sale_price = formatCatalogBatchPrice(item.sale_price, currency);
  }
  const inventory = normalizeInventory(item.inventory);
  if (inventory !== null) data.inventory = inventory;
  appendBatchField(data, "product_type", item.product_type);
  appendBatchField(data, "category", item.category);
  appendBatchField(
    data,
    "google_product_category",
    item.google_product_category,
  );
  appendBatchField(data, "color", item.color);
  appendBatchField(data, "size", item.size);
  appendBatchField(data, "material", item.material);
  appendBatchField(data, "gender", item.gender);
  appendBatchField(data, "age_group", item.age_group);
  appendBatchField(data, "custom_label_0", item.custom_label_0);
  appendBatchField(data, "custom_label_1", item.custom_label_1);
  appendBatchField(data, "custom_label_2", item.custom_label_2);
  appendBatchField(data, "custom_label_3", item.custom_label_3);
  appendBatchField(data, "custom_label_4", item.custom_label_4);
  return data;
}

function buildItemsBatchBody(items: WhatsAppCatalogImportProduct[]) {
  const body = new URLSearchParams();
  body.set("item_type", "PRODUCT_ITEM");
  body.set(
    "requests",
    JSON.stringify(
      items.map((item) => ({
        method: "UPDATE",
        data: toItemsBatchData(item),
      })),
    ),
  );
  return body;
}

async function parseMetaResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessageFromMeta(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (typeof error?.message === "string" && error.message.trim()) {
      return error.message;
    }
  }
  return fallback;
}

export async function whatsappCatalogImportBatchActivity(
  input: WhatsAppCatalogImportBatchInput,
): Promise<WhatsAppCatalogImportBatchResult> {
  heartbeat({ offset: input.offset, itemCount: input.items.length });

  const response = await fetch(graphUrl(`${input.catalogId}/items_batch`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: buildItemsBatchBody(input.items),
  });
  const payload = await parseMetaResponse(response);

  if (!response.ok) {
    throw new Error(
      errorMessageFromMeta(
        payload,
        `Meta catalog items_batch failed with HTTP ${response.status}`,
      ),
    );
  }

  return {
    processed: input.items.length,
    successful: input.items.length,
    failed: 0,
    rows: input.items.map((item) => ({
      retailerId: item.retailer_id || null,
      success: true,
      metaResponse: payload,
    })),
  };
}

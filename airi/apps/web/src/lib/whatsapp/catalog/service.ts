import { compactWhatsAppStringOrUndefined } from "@icecore/shared/lib/whatsapp/value-utils";
import {
  collectMetaGraphEdge,
  getWhatsAppGraphClient,
  MetaGraphRequestError,
  type WhatsAppGraphClient,
} from "@icecore/shared/lib/meta/api";
import {
  formatCatalogBatchPrice,
  normalizeCurrency,
  toMetaProductPriceCents,
} from "@icecore/whatsapp/formatCatalogBatchPrice";

export const CATALOG_PERMISSION = "catalog_management";

const PRODUCT_CATALOG_FIELDS = [
  "id",
  "name",
  "vertical",
  "product_count",
  "default_image_url",
  "fallback_image_url",
].join(",");

const PRODUCT_FIELDS = [
  "id",
  "retailer_id",
  "name",
  "description",
  "availability",
  "condition",
  "price",
  "currency",
  "brand",
  "url",
  "image_url",
  "additional_image_urls",
  "sale_price",
  "inventory",
  "product_type",
  "category",
  "google_product_category",
  "color",
  "size",
  "material",
  "gender",
  "age_group",
  "custom_label_0",
  "custom_label_1",
  "custom_label_2",
  "custom_label_3",
  "custom_label_4",
  "review_status",
  "updated_time",
  "created_time",
].join(",");

type CatalogAvailability =
  | "in stock"
  | "out of stock"
  | "preorder"
  | "available for order"
  | "discontinued"
  | "pending"
  | "mark_as_sold"
  | "mark_as_expired";

type CatalogCondition =
  | "new"
  | "refurbished"
  | "used"
  | "used_like_new"
  | "used_good"
  | "used_fair"
  | "cpo"
  | "open_box_new";

export type MetaProductCatalog = {
  id: string;
  name?: string;
  vertical?: string;
  product_count?: number;
  default_image_url?: string;
  fallback_image_url?: string;
};

export type MetaCatalogProduct = {
  id?: string;
  retailer_id?: string;
  name?: string;
  description?: string;
  availability?: CatalogAvailability | string;
  condition?: CatalogCondition | string;
  price?: string | number;
  currency?: string;
  brand?: string;
  url?: string;
  image_url?: string;
  additional_image_urls?: string[];
  sale_price?: string | number;
  inventory?: number | string;
  product_type?: string;
  category?: string;
  google_product_category?: string;
  color?: string;
  size?: string;
  material?: string;
  gender?: string;
  age_group?: string;
  custom_label_0?: string;
  custom_label_1?: string;
  custom_label_2?: string;
  custom_label_3?: string;
  custom_label_4?: string;
  review_status?: string;
  updated_time?: string;
  created_time?: string;
};

export type CatalogProductInput = {
  retailer_id: string;
  name: string;
  description: string;
  price: string | number;
  currency: string;
  image_url: string;
  url: string;
  additional_image_urls?: string[];
  sale_price?: string | number;
  inventory?: number | string;
  brand?: string;
  availability?: CatalogAvailability | string;
  condition?: CatalogCondition | string;
  product_type?: string;
  category?: string;
  google_product_category?: string;
  color?: string;
  size?: string;
  material?: string;
  gender?: string;
  age_group?: string;
  custom_label_0?: string;
  custom_label_1?: string;
  custom_label_2?: string;
  custom_label_3?: string;
  custom_label_4?: string;
};

export type CatalogProductUpdateInput = Partial<
  Omit<CatalogProductInput, "retailer_id">
>;

export type CatalogCommerceSettings = {
  id?: string;
  is_cart_enabled?: boolean;
  is_catalog_visible?: boolean;
  catalog_id?: string;
};

type CatalogCommerceSettingsResponse =
  | CatalogCommerceSettings
  | {
      data?: CatalogCommerceSettings[];
    };

type GraphEdgeResponse<T> = {
  data?: T[];
  paging?: {
    next?: string;
  };
};

type CatalogItemsBatchMethod = "CREATE" | "UPDATE" | "DELETE";

type ItemsBatchParams = {
  method: CatalogItemsBatchMethod;
  retailerId: string;
  data?: CatalogProductUpdateInput;
};

type CatalogCsvRowError = {
  rowNumber: number;
  field: string;
  message: string;
};

type ParsedCatalogCsvRows = {
  validItems: CatalogProductInput[];
  errors: CatalogCsvRowError[];
};

const REQUIRED_CSV_FIELDS = [
  "retailer_id",
  "name",
  "description",
  "price",
  "currency",
  "image_url",
  "url",
] as const;

const CSV_HEADERS = [
  "retailer_id",
  "name",
  "description",
  "price",
  "currency",
  "image_url",
  "url",
  "additional_image_urls",
  "sale_price",
  "inventory",
  "brand",
  "availability",
  "condition",
  "product_type",
  "category",
  "google_product_category",
  "color",
  "size",
  "material",
  "gender",
  "age_group",
  "custom_label_0",
  "custom_label_1",
  "custom_label_2",
  "custom_label_3",
  "custom_label_4",
] as const;

function appendIfPresent(
  params: URLSearchParams,
  key: string,
  value: unknown
): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    const joined = value
      .map(item => String(item).trim())
      .filter(Boolean)
      .join(",");
    if (joined) params.set(key, joined);
    return;
  }
  if (typeof value === "string" && value.trim().length === 0) return;
  params.set(key, String(value).trim());
}

function buildCreateBusinessOwnedProductCatalogParams(input: {
  name: string;
  vertical?: string;
}): URLSearchParams {
  const params = new URLSearchParams();
  appendIfPresent(params, "name", input.name);
  appendIfPresent(params, "vertical", input.vertical || "commerce");
  return params;
}

function buildLinkWabaProductCatalogParams(catalogId: string): URLSearchParams {
  const params = new URLSearchParams();
  appendIfPresent(params, "catalog_id", catalogId);
  return params;
}

function normalizeCatalogCommerceSettings(
  response: CatalogCommerceSettingsResponse
): CatalogCommerceSettings | null {
  const raw =
    response &&
    typeof response === "object" &&
    "data" in response &&
    Array.isArray(response.data)
      ? response.data[0]
      : response;

  if (!raw || typeof raw !== "object") return null;

  const settings = raw as CatalogCommerceSettings;
  const id = compactWhatsAppStringOrUndefined(settings.id);
  const catalogId = compactWhatsAppStringOrUndefined(settings.catalog_id) || id;
  return {
    ...(id ? { id } : {}),
    ...(catalogId ? { catalog_id: catalogId } : {}),
    ...(typeof settings.is_cart_enabled === "boolean"
      ? { is_cart_enabled: settings.is_cart_enabled }
      : {}),
    ...(typeof settings.is_catalog_visible === "boolean"
      ? { is_catalog_visible: settings.is_catalog_visible }
      : {}),
  };
}

function normalizeInventory(value: string | number | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("inventory must be a non-negative integer");
  }
  return parsed;
}

export function buildCreateCatalogProductParams(
  input: CatalogProductInput
): URLSearchParams {
  const params = new URLSearchParams();
  const currency = normalizeCurrency(input.currency);
  appendIfPresent(params, "retailer_id", input.retailer_id);
  appendIfPresent(params, "name", input.name);
  appendIfPresent(params, "description", input.description);
  appendIfPresent(params, "price", toMetaProductPriceCents(input.price));
  appendIfPresent(params, "currency", currency);
  appendIfPresent(params, "image_url", input.image_url);
  appendIfPresent(params, "additional_image_urls", input.additional_image_urls);
  appendIfPresent(params, "url", input.url);
  appendIfPresent(params, "brand", input.brand);
  appendIfPresent(params, "availability", input.availability || "in stock");
  appendIfPresent(params, "condition", input.condition || "new");
  appendIfPresent(
    params,
    "sale_price",
    input.sale_price !== undefined
      ? formatCatalogBatchPrice(input.sale_price, currency)
      : undefined
  );
  appendIfPresent(params, "inventory", normalizeInventory(input.inventory));
  appendIfPresent(params, "product_type", input.product_type);
  appendIfPresent(params, "category", input.category);
  appendIfPresent(
    params,
    "google_product_category",
    input.google_product_category
  );
  appendIfPresent(params, "color", input.color);
  appendIfPresent(params, "size", input.size);
  appendIfPresent(params, "material", input.material);
  appendIfPresent(params, "gender", input.gender);
  appendIfPresent(params, "age_group", input.age_group);
  appendIfPresent(params, "custom_label_0", input.custom_label_0);
  appendIfPresent(params, "custom_label_1", input.custom_label_1);
  appendIfPresent(params, "custom_label_2", input.custom_label_2);
  appendIfPresent(params, "custom_label_3", input.custom_label_3);
  appendIfPresent(params, "custom_label_4", input.custom_label_4);

  return params;
}

function appendBatchField(
  data: Record<string, unknown>,
  key: string,
  value: unknown
) {
  if (value === undefined || value === null) return;
  if (typeof value === "string" && !value.trim()) return;
  data[key] = value;
}

function toItemsBatchData(
  retailerId: string,
  data: CatalogProductUpdateInput = {}
): Record<string, unknown> {
  const batchData: Record<string, unknown> = {
    id: retailerId,
  };
  const currency = data.currency ? normalizeCurrency(data.currency) : "USD";

  if (data.name !== undefined) batchData.title = data.name;
  appendBatchField(batchData, "description", data.description);
  appendBatchField(batchData, "availability", data.availability);
  appendBatchField(batchData, "condition", data.condition);
  appendBatchField(batchData, "brand", data.brand);
  appendBatchField(batchData, "link", data.url);
  if (data.image_url !== undefined) {
    batchData.image = [{ url: data.image_url }];
  }
  if (data.additional_image_urls !== undefined) {
    batchData.additional_image_link = data.additional_image_urls
      .map(url => String(url).trim())
      .filter(Boolean);
  }
  if (data.price !== undefined) {
    batchData.price = formatCatalogBatchPrice(data.price, currency);
  } else if (data.currency !== undefined) {
    batchData.currency = currency;
  }
  if (data.sale_price !== undefined) {
    batchData.sale_price = formatCatalogBatchPrice(data.sale_price, currency);
  }
  const inventory = normalizeInventory(data.inventory);
  if (inventory !== null) batchData.inventory = inventory;
  appendBatchField(batchData, "product_type", data.product_type);
  appendBatchField(batchData, "category", data.category);
  appendBatchField(
    batchData,
    "google_product_category",
    data.google_product_category
  );
  appendBatchField(batchData, "color", data.color);
  appendBatchField(batchData, "size", data.size);
  appendBatchField(batchData, "material", data.material);
  appendBatchField(batchData, "gender", data.gender);
  appendBatchField(batchData, "age_group", data.age_group);
  appendBatchField(batchData, "custom_label_0", data.custom_label_0);
  appendBatchField(batchData, "custom_label_1", data.custom_label_1);
  appendBatchField(batchData, "custom_label_2", data.custom_label_2);
  appendBatchField(batchData, "custom_label_3", data.custom_label_3);
  appendBatchField(batchData, "custom_label_4", data.custom_label_4);

  return batchData;
}

export function buildCatalogItemsBatchParams({
  method,
  retailerId,
  data,
}: ItemsBatchParams): URLSearchParams {
  const params = new URLSearchParams();
  const batchData =
    method === "DELETE"
      ? { id: retailerId }
      : toItemsBatchData(retailerId, data);

  params.set("item_type", "PRODUCT_ITEM");
  params.set(
    "requests",
    JSON.stringify([
      {
        method,
        data: batchData,
      },
    ])
  );

  return params;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function splitAdditionalImages(
  value: string | undefined
): string[] | undefined {
  if (!value) return undefined;
  const urls = value
    .split(/[|;]/)
    .flatMap(item => item.split(","))
    .map(item => item.trim())
    .filter(Boolean);
  return urls.length > 0 ? urls : undefined;
}

export function parseCatalogCsvRows(contents: string): ParsedCatalogCsvRows {
  const lines = contents
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0);
  if (lines.length === 0) {
    return {
      validItems: [],
      errors: [{ rowNumber: 1, field: "file", message: "CSV is empty" }],
    };
  }

  const headers = parseCsvLine(lines[0] || "").map(header =>
    header.trim().toLowerCase()
  );
  const validItems: CatalogProductInput[] = [];
  const errors: CatalogCsvRowError[] = [];

  for (let index = 1; index < lines.length; index += 1) {
    const rowNumber = index + 1;
    const cells = parseCsvLine(lines[index] || "");
    const row: Record<string, string> = {};
    headers.forEach((header, headerIndex) => {
      if (header) row[header] = cells[headerIndex] || "";
    });

    for (const field of REQUIRED_CSV_FIELDS) {
      if (!row[field]?.trim()) {
        errors.push({
          rowNumber,
          field,
          message: `${field} is required`,
        });
      }
    }

    if (errors.some(error => error.rowNumber === rowNumber)) continue;

    try {
      validItems.push({
        retailer_id: row.retailer_id,
        name: row.name,
        description: row.description,
        price: row.price,
        currency: normalizeCurrency(row.currency || ""),
        image_url: row.image_url,
        url: row.url,
        additional_image_urls: splitAdditionalImages(row.additional_image_urls),
        sale_price: row.sale_price || undefined,
        inventory:
          row.inventory?.trim() === ""
            ? undefined
            : (normalizeInventory(row.inventory) ?? undefined),
        brand: row.brand || undefined,
        availability: row.availability || "in stock",
        condition: row.condition || "new",
        product_type: row.product_type || undefined,
        category: row.category || undefined,
        google_product_category: row.google_product_category || undefined,
        color: row.color || undefined,
        size: row.size || undefined,
        material: row.material || undefined,
        gender: row.gender || undefined,
        age_group: row.age_group || undefined,
        custom_label_0: row.custom_label_0 || undefined,
        custom_label_1: row.custom_label_1 || undefined,
        custom_label_2: row.custom_label_2 || undefined,
        custom_label_3: row.custom_label_3 || undefined,
        custom_label_4: row.custom_label_4 || undefined,
      });
    } catch (error) {
      errors.push({
        rowNumber,
        field: "row",
        message: error instanceof Error ? error.message : "Invalid row",
      });
    }
  }

  return { validItems, errors };
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const raw = Array.isArray(value) ? value.join("|") : String(value);
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

export function serializeCatalogProductsCsv(
  products: MetaCatalogProduct[]
): string {
  const lines = [
    CSV_HEADERS.join(","),
    ...products.map(product =>
      CSV_HEADERS.map(header => csvCell(product[header])).join(",")
    ),
  ];
  return lines.join("\n");
}

async function listGraphEdge<T>(params: {
  accessToken: string;
  client: WhatsAppGraphClient;
  limit: number;
  path: string;
  query?: Record<string, string | number | boolean>;
}): Promise<T[]> {
  return collectMetaGraphEdge<T>({
    client: params.client,
    accessToken: params.accessToken,
    path: params.path,
    initialQuery: params.query,
    maxPages: 100,
    maxItems: params.limit,
    normalizePage: payload => {
      const response = payload as GraphEdgeResponse<T>;
      return {
        data: Array.isArray(response.data) ? response.data : [],
        next: response.paging?.next,
      };
    },
  });
}

export function dedupeCatalogs(
  catalogs: MetaProductCatalog[]
): MetaProductCatalog[] {
  const byId = new Map<string, MetaProductCatalog>();
  for (const catalog of catalogs) {
    if (!catalog?.id) continue;
    byId.set(catalog.id, { ...byId.get(catalog.id), ...catalog });
  }
  return Array.from(byId.values());
}

export function isCatalogPermissionError(error: unknown): boolean {
  if (!(error instanceof MetaGraphRequestError)) return false;

  const code = error.metaError?.code;
  const message = [
    error.message,
    error.metaError?.message,
    JSON.stringify(error.details),
  ]
    .join(" ")
    .toLowerCase();
  const catalogEndpoint = [
    "product_catalog",
    "owned_product_catalogs",
    "/products",
    "items_batch",
    "whatsapp_commerce_settings",
  ].some(part => error.url.toLowerCase().includes(part));

  return (
    message.includes(CATALOG_PERMISSION) ||
    (catalogEndpoint &&
      (code === 200 ||
        message.includes("missing permissions") ||
        message.includes("permission")))
  );
}

export function isWabaCatalogUnsupportedMethodError(error: unknown): boolean {
  if (!(error instanceof MetaGraphRequestError)) return false;

  const message = [
    error.message,
    error.metaError?.message,
    JSON.stringify(error.details),
  ]
    .join(" ")
    .toLowerCase();

  return (
    error.url.toLowerCase().includes("product_catalogs") &&
    (error.metaError?.code === 3 ||
      error.metaError?.error_subcode === 1798083 ||
      message.includes("unknown method"))
  );
}

export async function getProductCatalog(params: {
  accessToken: string;
  catalogId: string;
  client?: WhatsAppGraphClient;
}): Promise<MetaProductCatalog> {
  const client = params.client || getWhatsAppGraphClient();
  return client.getJson<MetaProductCatalog>(params.catalogId, {
    token: params.accessToken,
    query: {
      fields: PRODUCT_CATALOG_FIELDS,
    },
  });
}

export async function listWabaProductCatalogs(params: {
  accessToken: string;
  wabaId: string;
  client?: WhatsAppGraphClient;
}): Promise<MetaProductCatalog[]> {
  const client = params.client || getWhatsAppGraphClient();
  return listGraphEdge<MetaProductCatalog>({
    accessToken: params.accessToken,
    client,
    limit: 500,
    path: `${params.wabaId}/product_catalogs`,
    query: {
      fields: PRODUCT_CATALOG_FIELDS,
      limit: 100,
    },
  });
}

export async function listBusinessOwnedProductCatalogs(params: {
  accessToken: string;
  businessId: string;
  client?: WhatsAppGraphClient;
}): Promise<MetaProductCatalog[]> {
  const client = params.client || getWhatsAppGraphClient();
  return listGraphEdge<MetaProductCatalog>({
    accessToken: params.accessToken,
    client,
    limit: 500,
    path: `${params.businessId}/owned_product_catalogs`,
    query: {
      fields: PRODUCT_CATALOG_FIELDS,
      limit: 100,
    },
  });
}

export async function createBusinessOwnedProductCatalog(params: {
  accessToken: string;
  businessId: string;
  name: string;
  vertical?: string;
  client?: WhatsAppGraphClient;
}): Promise<MetaProductCatalog> {
  const client = params.client || getWhatsAppGraphClient();
  return client.postJson<MetaProductCatalog>(
    `${params.businessId}/owned_product_catalogs`,
    {
      token: params.accessToken,
      body: buildCreateBusinessOwnedProductCatalogParams({
        name: params.name,
        vertical: params.vertical,
      }),
    }
  );
}

export async function linkWabaProductCatalog(params: {
  accessToken: string;
  wabaId: string;
  catalogId: string;
  client?: WhatsAppGraphClient;
}): Promise<unknown> {
  const client = params.client || getWhatsAppGraphClient();
  return client.postJson(`${params.wabaId}/product_catalogs`, {
    token: params.accessToken,
    body: buildLinkWabaProductCatalogParams(params.catalogId),
  });
}

export async function listCatalogProducts(params: {
  accessToken: string;
  catalogId: string;
  client?: WhatsAppGraphClient;
  limit?: number;
}): Promise<MetaCatalogProduct[]> {
  const client = params.client || getWhatsAppGraphClient();
  return listGraphEdge<MetaCatalogProduct>({
    accessToken: params.accessToken,
    client,
    limit: params.limit || 200,
    path: `${params.catalogId}/products`,
    query: {
      fields: PRODUCT_FIELDS,
      limit: params.limit || 200,
    },
  });
}

export async function createCatalogProduct(params: {
  accessToken: string;
  catalogId: string;
  product: CatalogProductInput;
  client?: WhatsAppGraphClient;
}): Promise<unknown> {
  const client = params.client || getWhatsAppGraphClient();
  return client.postJson(`${params.catalogId}/products`, {
    token: params.accessToken,
    body: buildCreateCatalogProductParams(params.product),
  });
}

export async function updateCatalogProduct(params: {
  accessToken: string;
  catalogId: string;
  retailerId: string;
  product: CatalogProductUpdateInput;
  client?: WhatsAppGraphClient;
}): Promise<unknown> {
  const client = params.client || getWhatsAppGraphClient();
  return client.postJson(`${params.catalogId}/items_batch`, {
    token: params.accessToken,
    body: buildCatalogItemsBatchParams({
      method: "UPDATE",
      retailerId: params.retailerId,
      data: params.product,
    }),
  });
}

export async function deleteCatalogProduct(params: {
  accessToken: string;
  catalogId: string;
  retailerId: string;
  client?: WhatsAppGraphClient;
}): Promise<unknown> {
  const client = params.client || getWhatsAppGraphClient();
  return client.postJson(`${params.catalogId}/items_batch`, {
    token: params.accessToken,
    body: buildCatalogItemsBatchParams({
      method: "DELETE",
      retailerId: params.retailerId,
    }),
  });
}

export async function getCatalogCommerceSettings(params: {
  accessToken: string;
  phoneNumberId: string;
  client?: WhatsAppGraphClient;
}): Promise<CatalogCommerceSettings | null> {
  const client = params.client || getWhatsAppGraphClient();
  const response = await client.getJson<CatalogCommerceSettingsResponse>(
    `${params.phoneNumberId}/whatsapp_commerce_settings`,
    {
      token: params.accessToken,
    }
  );
  return normalizeCatalogCommerceSettings(response);
}

export async function updateCatalogCommerceSettings(params: {
  accessToken: string;
  phoneNumberId: string;
  settings: CatalogCommerceSettings;
  client?: WhatsAppGraphClient;
}): Promise<unknown> {
  const client = params.client || getWhatsAppGraphClient();
  const body = new URLSearchParams();
  appendIfPresent(body, "is_cart_enabled", params.settings.is_cart_enabled);
  appendIfPresent(
    body,
    "is_catalog_visible",
    params.settings.is_catalog_visible
  );

  return client.postJson(`${params.phoneNumberId}/whatsapp_commerce_settings`, {
    token: params.accessToken,
    body,
  });
}

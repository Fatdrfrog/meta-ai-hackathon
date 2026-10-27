export const WHATSAPP_CATALOG_IMPORT_WORKFLOW = "whatsappCatalogImportWorkflow";
export const WHATSAPP_CATALOG_IMPORT_WORKFLOW_CONTRACT_VERSION = 1;

export const WHATSAPP_CATALOG_IMPORT_BATCH_ACTIVITY =
  "whatsappCatalogImportBatchActivity";

export type WhatsAppCatalogImportProduct = {
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
  availability?: string;
  condition?: string;
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

export type WhatsAppCatalogImportWorkflowInput = {
  contractVersion: number;
  workspaceId: string;
  catalogId: string;
  accessToken: string;
  items: WhatsAppCatalogImportProduct[];
  batchSize?: number;
  sourceId?: string | null;
};

export type WhatsAppCatalogImportBatchInput = {
  accessToken: string;
  catalogId: string;
  items: WhatsAppCatalogImportProduct[];
  offset: number;
};

export type WhatsAppCatalogImportRowResult = {
  retailerId: string | null;
  success: boolean;
  error?: string;
  metaResponse?: unknown;
};

export type WhatsAppCatalogImportBatchResult = {
  processed: number;
  successful: number;
  failed: number;
  rows: WhatsAppCatalogImportRowResult[];
};

export type WhatsAppCatalogImportWorkflowResult = {
  workspaceId: string;
  catalogId: string;
  processed: number;
  successful: number;
  failed: number;
  batchCount: number;
};

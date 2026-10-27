export const SHOPIFY_COMMERCE_INBOX_PREFIX = "airi_commerce_shopify_v1:";
export const WIDGET_COMMERCE_STORAGE_PREFIX = "airi_commerce_v1:";
export const SHOPIFY_CART_IDENTITY_PREFIX = "airi_commerce_shopify_cart_v1:";

export function widgetCommerceStorageKey(clientKey: string): string {
  return `${WIDGET_COMMERCE_STORAGE_PREFIX}${encodeURIComponent(clientKey)}`;
}

export function shopifyCartIdentityKey(clientKey: string): string {
  return `${SHOPIFY_CART_IDENTITY_PREFIX}${encodeURIComponent(clientKey)}`;
}

export function shopifyCommerceInboxPrefix(clientKey: string): string {
  return `${SHOPIFY_COMMERCE_INBOX_PREFIX}${encodeURIComponent(clientKey)}:`;
}

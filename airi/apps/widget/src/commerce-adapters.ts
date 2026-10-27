import {
  installGtmCommerceAdapter,
  normalizeGtmCartSnapshot,
} from "./lib/commerce-gtm";
import {
  createShopifyCartPermalink,
  createShopifyPixelCommerceBridge,
  installShopifyCommerceAdapter,
  installShopifyPixelCommerceAdapter,
  installShopifyStorefrontBridge,
} from "./lib/commerce-shopify";
import { installTildaCommerceAdapter } from "./lib/commerce-tilda";

export const AiriCommerceAdapters = {
  installGtmCommerceAdapter,
  normalizeGtmCartSnapshot,
  createShopifyCartPermalink,
  createShopifyPixelCommerceBridge,
  installShopifyCommerceAdapter,
  installShopifyPixelCommerceAdapter,
  installShopifyStorefrontBridge,
  installTildaCommerceAdapter,
};

declare global {
  // eslint-disable-next-line no-var
  var AiriCommerceAdapters: typeof AiriCommerceAdapters | undefined;
}

globalThis.AiriCommerceAdapters = AiriCommerceAdapters;

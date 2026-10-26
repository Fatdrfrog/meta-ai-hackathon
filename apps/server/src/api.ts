// Shapes the server sends the web app. Types only, shared with apps/web.

export type VideoStatus = "queued" | "processing" | "done" | "failed";
export type VideoStage = "preparing" | "listening" | "watching" | "cutting";

export interface ApiVideo {
  readonly id: string;
  readonly status: VideoStatus;
  readonly stage: VideoStage | null;
  /** Products cut out so far, during the cutting stage. */
  readonly done: number | null;
  readonly total: number | null;
  readonly error: string | null;
  readonly transcript: string | null;
  readonly productCount: number;
  readonly seconds: number | null;
  readonly createdAt: string;
}

export interface ApiProduct {
  readonly id: string;
  readonly videoId: string;
  /** The owner's own name for it, in their language. */
  readonly localName: string;
  readonly name: string;
  readonly category: string;
  readonly price: number | null;
  readonly currency: string | null;
  /** The owner's words the price comes from. */
  readonly priceQuote: string | null;
  /** Things the owner should check before confirming. */
  readonly notes: readonly string[];
  readonly imageUrl: string;
  readonly hasCutout: boolean;
  readonly confirmed: boolean;
}

export interface ApiShop {
  readonly name: string;
  readonly slug: string;
}

export interface StudioData {
  readonly shop: ApiShop;
  readonly videos: readonly ApiVideo[];
  readonly products: readonly ApiProduct[];
}

export interface ShopPageData {
  readonly shop: ApiShop;
  readonly products: readonly Pick<ApiProduct, "id" | "localName" | "name" | "price" | "currency" | "imageUrl">[];
}

export interface ProductPatch {
  readonly localName?: string;
  readonly name?: string;
  readonly price?: number | null;
  readonly confirmed?: boolean;
}

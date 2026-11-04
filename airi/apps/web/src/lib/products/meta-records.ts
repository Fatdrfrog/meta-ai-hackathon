import type {
  ProductAdPostRecord,
  ProductAdStillChoice,
} from "@/lib/products/types";
import type { ProductAdStoredPost } from "@/models/product-ad";

// What went out on Meta from an ad, as the page reads it: the stored
// Instagram posts without what only the server reads (container and media
// ids, the caption sent, the request id, the lease). Pure, so ads.ts (the ad
// record and the made list) and meta-publish.ts (the post routes) share it
// without importing each other.

const iso = (value: unknown): string | null => {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
};

const stillChoice = (
  choice: Partial<ProductAdStillChoice>
): ProductAdStillChoice => ({
  kind: choice.kind as ProductAdStillChoice["kind"],
  productId: choice.productId ?? null,
  colourway: choice.colourway ?? null,
});

/** One stored post as the workbench and Out on Meta show it. */
export function toAdPostRecord(post: ProductAdStoredPost): ProductAdPostRecord {
  return {
    id: post.id,
    destination: post.destination,
    still: post.still ? stillChoice(post.still) : null,
    slides: (post.slides ?? []).map(stillChoice),
    renderNo: post.renderNo,
    motion: post.motion ?? null,
    state: post.state,
    permalink: post.permalink ?? null,
    errorCode: post.errorCode ?? null,
    errorMessage: post.errorMessage ?? null,
    requestedAt: iso(post.requestedAt) ?? new Date(0).toISOString(),
    publishedAt: iso(post.publishedAt),
  };
}

import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import type { ApiProduct, ApiVideo, ProductPatch, ShopPageData, StudioData } from "./api.ts";
import type { Product, Shop, Store, Video } from "./store.ts";

type Env = { Variables: { shop: Shop } };

const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".3gp", ".mkv"]);

const apiProduct = (p: Product): ApiProduct => ({
  id: p.id,
  videoId: p.videoId,
  localName: p.localName,
  name: p.name,
  category: p.category,
  price: p.price,
  currency: p.currency,
  priceQuote: p.priceQuote,
  notes: p.notes,
  imageUrl: `/media/products/${p.id}?v=${encodeURIComponent(p.updatedAt)}`,
  hasCutout: p.imagePath !== null,
  confirmed: p.confirmed,
});

const apiVideo = (v: Video, productCount: number): ApiVideo => ({
  id: v.id,
  status: v.status,
  stage: v.stage,
  done: v.done,
  total: v.total,
  error: v.error,
  transcript: v.transcript,
  productCount,
  seconds: v.seconds,
  createdAt: v.createdAt,
});

/** Accepts only the fields an owner may edit, with sane values. */
export function parseProductPatch(body: unknown): ProductPatch | string {
  if (typeof body !== "object" || body === null) return "Expected a JSON object.";
  const input = body as Record<string, unknown>;
  const patch: { localName?: string; name?: string; price?: number | null; confirmed?: boolean } = {};
  for (const key of ["localName", "name"] as const) {
    if (input[key] === undefined) continue;
    const value = input[key];
    if (typeof value !== "string" || value.trim() === "" || value.length > 120) return `${key} must be 1-120 characters.`;
    patch[key] = value.trim();
  }
  if (input.price !== undefined) {
    const price = input.price;
    if (price !== null && (typeof price !== "number" || !Number.isFinite(price) || price < 0 || price > 1e9)) {
      return "price must be a non-negative number or null.";
    }
    patch.price = price;
  }
  if (input.confirmed !== undefined) {
    if (typeof input.confirmed !== "boolean") return "confirmed must be true or false.";
    patch.confirmed = input.confirmed;
  }
  return patch;
}

export function createApp(store: Store, options: { dataDir: string; onVideoQueued: () => void }) {
  const app = new Hono<Env>();

  // The studio link is the owner's key: whoever has it can manage the shop.
  const requireShop = createMiddleware<Env>(async (c, next) => {
    const shop = store.shopByToken(c.req.param("token") ?? "");
    if (!shop) return c.json({ error: "This studio link is not valid." }, 404);
    c.set("shop", shop);
    await next();
  });
  app.use("/api/studio/:token", requireShop);
  app.use("/api/studio/:token/*", requireShop);

  app.get("/api/studio/:token", (c) => {
    const shop = c.get("shop");
    const counts = store.productCounts(shop.id);
    const data: StudioData = {
      shop: { name: shop.name, slug: shop.slug },
      videos: store.videos(shop.id).map((v) => apiVideo(v, counts.get(v.id) ?? 0)),
      products: store.products(shop.id).map(apiProduct),
    };
    return c.json(data);
  });

  app.post(
    "/api/studio/:token/videos",
    bodyLimit({ maxSize: MAX_VIDEO_BYTES, onError: (c) => c.json({ error: "The video is larger than 300 MB." }, 413) }),
    async (c) => {
      const shop = c.get("shop");
      const body = await c.req.parseBody();
      const file = body.video;
      if (!(file instanceof File) || file.size === 0) return c.json({ error: "Attach a video in the 'video' field." }, 400);
      const extension = extname(file.name).toLowerCase() || ".mp4";
      if (!VIDEO_EXTENSIONS.has(extension) && !file.type.startsWith("video/")) {
        return c.json({ error: "That file doesn't look like a video." }, 400);
      }
      const id = randomUUID();
      const dir = join(options.dataDir, "shops", shop.id, "videos", id);
      mkdirSync(dir, { recursive: true });
      const sourcePath = join(dir, `source${VIDEO_EXTENSIONS.has(extension) ? extension : ".mp4"}`);
      // Streamed to disk; File's web stream type differs only nominally from node:stream/web's.
      await pipeline(Readable.fromWeb(file.stream() as WebReadableStream<Uint8Array>), createWriteStream(sourcePath));
      const video = store.addVideo(shop.id, id, sourcePath);
      options.onVideoQueued();
      return c.json({ video: apiVideo(video, 0) }, 201);
    },
  );

  app.post("/api/studio/:token/videos/:id/retry", (c) => {
    if (!store.retryVideo(c.get("shop").id, c.req.param("id"))) return c.json({ error: "Only a failed video can be retried." }, 409);
    options.onVideoQueued();
    return c.json({ ok: true });
  });

  app.patch("/api/studio/:token/products/:id", async (c) => {
    const patch = parseProductPatch(await c.req.json().catch(() => null));
    if (typeof patch === "string") return c.json({ error: patch }, 400);
    const product = store.updateProduct(c.get("shop").id, c.req.param("id"), patch);
    return product ? c.json({ product: apiProduct(product) }) : c.json({ error: "No such product." }, 404);
  });

  app.delete("/api/studio/:token/products/:id", (c) =>
    store.deleteProduct(c.get("shop").id, c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "No such product." }, 404),
  );

  app.post("/api/studio/:token/products/confirm-all", (c) => c.json({ confirmed: store.confirmAllWithoutNotes(c.get("shop").id) }));

  app.get("/api/shops/:slug", (c) => {
    const shop = store.shopBySlug(c.req.param("slug"));
    if (!shop) return c.json({ error: "No such shop." }, 404);
    const data: ShopPageData = {
      shop: { name: shop.name, slug: shop.slug },
      products: store
        .products(shop.id)
        .filter((p) => p.confirmed)
        .map((p) => {
          const { id, localName, name, price, currency, imageUrl } = apiProduct(p);
          return { id, localName, name, price, currency, imageUrl };
        }),
    };
    return c.json(data);
  });

  // Product photos are looked up by id, never by a path from the request. Ids are random UUIDs.
  app.get("/media/products/:id", async (c) => {
    const product = store.productById(c.req.param("id"));
    if (!product) return c.notFound();
    const path = product.imagePath ?? product.framePath;
    const bytes = await readFile(path);
    return c.body(bytes, 200, {
      "content-type": path.endsWith(".png") ? "image/png" : "image/jpeg",
      "cache-control": "public, max-age=31536000, immutable",
    });
  });

  return app;
}

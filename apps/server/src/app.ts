import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { getConnInfo } from "@hono/node-server/conninfo";
import { normalizePhoto } from "@vitrina/catalog";
import type { SellerTurn, SellerTurnInput } from "@vitrina/seller";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import type {
  ApiChatMessage,
  ApiOrder,
  ApiProduct,
  ApiVideo,
  ChatData,
  ProductPatch,
  ShopPageData,
  ShopProduct,
  StudioData,
} from "./api.ts";
import type { SheetItem } from "./catalog-sheet.ts";
import { createRateLimiter } from "./rate-limit.ts";
import type { Message, Order, Product, Shop, Store, Video } from "./store.ts";

type Env = { Variables: { shop: Shop } };

const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 1000;
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".3gp", ".mkv"]);
const HOUR = 60 * 60 * 1000;

export interface ChatLimits {
  readonly perSenderPerHour: number;
  readonly perChatPerHour: number;
  readonly perShopPerDay: number;
}

const DEFAULT_CHAT_LIMITS: ChatLimits = { perSenderPerHour: 40, perChatPerHour: 40, perShopPerDay: 1000 };

export interface AppOptions {
  readonly dataDir: string;
  readonly onVideoQueued: () => void;
  /** The AI seller; without it the shop page's chat is switched off. */
  readonly sell?: (input: SellerTurnInput) => Promise<SellerTurn>;
  /** Builds the numbered sheet of the shop's products that buyer photos are matched against. */
  readonly catalogSheet?: (shopId: string, items: readonly SheetItem[]) => Promise<string>;
  readonly chatLimits?: ChatLimits;
}

const shopProduct = (p: Product): ShopProduct => ({
  id: p.id,
  localName: p.localName,
  name: p.name,
  price: p.price,
  currency: p.currency,
  imageUrl: `/media/products/${p.id}?v=${encodeURIComponent(p.updatedAt)}`,
});

const apiOrder = (o: Order): ApiOrder => ({
  id: o.id,
  items: o.items.map(({ localName, quantity, price }) => ({ localName, quantity, price })),
  total: o.total,
  buyerName: o.buyerName,
  buyerPhone: o.buyerPhone,
  createdAt: o.createdAt,
});

/** Who is sending, for rate limits: the client address, or the first forwarded one behind a proxy. */
function senderOf(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

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

export function createApp(store: Store, options: AppOptions) {
  const app = new Hono<Env>();
  const limits = options.chatLimits ?? DEFAULT_CHAT_LIMITS;
  const limiters = {
    sender: createRateLimiter(limits.perSenderPerHour, HOUR),
    chat: createRateLimiter(limits.perChatPerHour, HOUR),
    shop: createRateLimiter(limits.perShopPerDay, 24 * HOUR),
  };

  const chatMessage = (m: Message): ApiChatMessage => {
    const order = m.orderId ? store.order(m.orderId) : undefined;
    return {
      id: m.id,
      role: m.role,
      text: m.text,
      photoUrl: m.photoPath ? `/media/messages/${m.id}` : null,
      products: m.productIds.map((id) => store.productById(id)).filter((p): p is Product => p !== undefined && p.confirmed).map(shopProduct),
      order: order ? apiOrder(order) : null,
      createdAt: m.createdAt,
    };
  };

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
      orders: store.orders(shop.id).map(apiOrder),
      questions: store.ownerQuestions(shop.id),
    };
    return c.json(data);
  });

  app.patch("/api/studio/:token/questions/:id", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { done?: unknown } | null;
    if (typeof body?.done !== "boolean") return c.json({ error: "done must be true or false." }, 400);
    return store.setQuestionDone(c.get("shop").id, c.req.param("id"), body.done) ? c.json({ ok: true }) : c.json({ error: "No such question." }, 404);
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
        .map(shopProduct),
    };
    return c.json(data);
  });

  app.get("/api/shops/:slug/chat/:conversationId", (c) => {
    const shop = store.shopBySlug(c.req.param("slug"));
    const conversation = shop && store.conversation(shop.id, c.req.param("conversationId"));
    if (!conversation) return c.json({ error: "This chat doesn't exist." }, 404);
    const data: ChatData = { conversationId: conversation.id, messages: store.messages(conversation.id).map(chatMessage) };
    return c.json(data);
  });

  app.post(
    "/api/shops/:slug/chat",
    bodyLimit({ maxSize: MAX_PHOTO_BYTES + 64 * 1024, onError: (c) => c.json({ error: "The photo is larger than 10 MB." }, 413) }),
    async (c) => {
      const shop = store.shopBySlug(c.req.param("slug"));
      if (!shop) return c.json({ error: "No such shop." }, 404);
      if (!options.sell) return c.json({ error: "This shop's chat isn't switched on yet." }, 503);

      const body = await c.req.parseBody();
      const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_MESSAGE_CHARS) : "";
      const photo = body.photo instanceof File && body.photo.size > 0 ? body.photo : undefined;
      if (photo && !photo.type.startsWith("image/")) return c.json({ error: "Attach the photo as an image." }, 400);
      if (!text && !photo) return c.json({ error: "Write a message or attach a photo." }, 400);
      if (!limiters.sender.allow(senderOf(c)) || !limiters.shop.allow(shop.id)) {
        return c.json({ error: "Too many messages for now. Try again in a few minutes." }, 429);
      }

      const requested = typeof body.conversationId === "string" ? store.conversation(shop.id, body.conversationId) : undefined;
      const conversation = requested ?? store.createConversation(shop.id, "web");
      if (!limiters.chat.allow(conversation.id)) return c.json({ error: "Too many messages in this chat. Try again later." }, 429);
      const history = store.messages(conversation.id);

      const buyerId = randomUUID();
      let photoPath: string | null = null;
      if (photo) {
        const dir = join(options.dataDir, "shops", shop.id, "chat", conversation.id);
        mkdirSync(dir, { recursive: true });
        photoPath = join(dir, `${buyerId}.jpg`);
        try {
          await normalizePhoto(new Uint8Array(await photo.arrayBuffer()), photoPath);
        } catch {
          return c.json({ error: "That photo couldn't be read. Send it as a JPEG or PNG." }, 400);
        }
      }
      const buyer = store.addMessage(conversation.id, { role: "buyer", text, photoPath }, buyerId);

      const products = store.products(shop.id).filter((p) => p.confirmed);
      let turn: SellerTurn;
      if (products.length === 0) {
        turn = { reply: "This shop hasn't put any products on its shelf yet.", productIds: [], order: null, ownerQuestion: null, corrections: [], trace: [] };
      } else {
        try {
          turn = await options.sell({
            shopName: shop.name,
            channel: "web",
            products: products.map((p) => ({ id: p.id, localName: p.localName, name: p.name, category: p.category, price: p.price })),
            catalogSheetPath:
              photoPath && options.catalogSheet
                ? await options.catalogSheet(
                    shop.id,
                    products.map((p) => ({ id: p.id, imagePath: p.imagePath ?? p.framePath, updatedAt: p.updatedAt })),
                  )
                : undefined,
            history: history.map((m) => ({ role: m.role, text: m.photoPath ? `${m.text} (sent a photo)`.trim() : m.text })),
            buyerText: text,
            buyerPhotoPath: photoPath ?? undefined,
            previousOrders: store.conversationOrders(conversation.id).map((o) => ({
              items: o.items.map((i) => ({ localName: i.localName, quantity: i.quantity })),
              total: o.total,
              createdAt: o.createdAt,
            })),
          });
        } catch (error) {
          console.error(`chat ${conversation.id}: the seller failed`, error);
          return c.json({ error: "The shop's assistant couldn't answer just now. Try again in a moment.", conversationId: conversation.id }, 502);
        }
      }

      const order = turn.order
        ? store.addOrder(shop.id, {
            conversationId: conversation.id,
            items: turn.order.items.map((item) => {
              const product = products.find((p) => p.id === item.productId)!;
              return { productId: product.id, localName: product.localName, quantity: item.quantity, price: product.price };
            }),
            total: turn.order.total,
            buyerName: turn.order.buyerName,
            buyerPhone: turn.order.buyerPhone,
          })
        : null;
      if (turn.ownerQuestion) store.addOwnerQuestion(shop.id, conversation.id, turn.ownerQuestion);
      const seller = store.addMessage(conversation.id, { role: "seller", text: turn.reply, productIds: turn.productIds, orderId: order?.id ?? null });
      const steps = turn.trace.map((step) => step.tool).join(" → ") || "no tools";
      console.log(`chat ${conversation.id}: ${steps}${turn.corrections.length > 0 ? ` (corrected: ${turn.corrections.join("; ")})` : ""}`);
      const data: ChatData = { conversationId: conversation.id, messages: [chatMessage(buyer), chatMessage(seller)] };
      return c.json(data);
    },
  );

  // Buyer photos are served by message id, never by a path from the request.
  app.get("/media/messages/:id", async (c) => {
    const message = store.messageById(c.req.param("id"));
    if (!message?.photoPath) return c.notFound();
    return c.body(await readFile(message.photoPath), 200, { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" });
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

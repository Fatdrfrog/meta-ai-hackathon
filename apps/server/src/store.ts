import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { CatalogResult } from "@vitrina/catalog";
import type { VideoStage, VideoStatus } from "./api.ts";

const SCHEMA = `
create table if not exists shops (
  id text primary key,
  name text not null,
  slug text not null unique,
  owner_token text not null unique,
  created_at text not null
);
create table if not exists videos (
  id text primary key,
  shop_id text not null references shops(id),
  source_path text not null,
  status text not null,
  stage text,
  done integer,
  total integer,
  error text,
  transcript text,
  language text,
  spent_usd real,
  seconds real,
  created_at text not null,
  finished_at text
);
create index if not exists videos_by_shop on videos(shop_id, created_at);
create index if not exists videos_by_status on videos(status, created_at);
create table if not exists products (
  id text primary key,
  shop_id text not null references shops(id),
  video_id text not null references videos(id),
  position integer not null,
  local_name text not null,
  name text not null,
  category text not null,
  price real,
  currency text,
  price_quote text,
  notes text not null,
  image_path text,
  frame_path text not null,
  frame_time_s real,
  sam_confidence real,
  confirmed integer not null default 0,
  created_at text not null,
  updated_at text not null
);
create index if not exists products_by_shop on products(shop_id, position);
create table if not exists conversations (
  id text primary key,
  shop_id text not null references shops(id),
  channel text not null,
  buyer_phone text,
  created_at text not null,
  updated_at text not null
);
create index if not exists conversations_by_shop on conversations(shop_id, updated_at);
create table if not exists orders (
  id text primary key,
  shop_id text not null references shops(id),
  conversation_id text not null references conversations(id),
  items text not null,
  total real,
  buyer_name text,
  buyer_phone text not null,
  created_at text not null
);
create index if not exists orders_by_shop on orders(shop_id, created_at);
create index if not exists orders_by_conversation on orders(conversation_id, created_at);
create table if not exists messages (
  id text primary key,
  conversation_id text not null references conversations(id),
  role text not null,
  text text not null,
  photo_path text,
  product_ids text not null,
  order_id text references orders(id),
  created_at text not null
);
create index if not exists messages_by_conversation on messages(conversation_id, created_at);
create table if not exists owner_questions (
  id text primary key,
  shop_id text not null references shops(id),
  conversation_id text not null references conversations(id),
  question text not null,
  done integer not null default 0,
  created_at text not null
);
create index if not exists owner_questions_by_shop on owner_questions(shop_id, created_at);
`;

export interface Shop {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly ownerToken: string;
}

export interface Video {
  readonly id: string;
  readonly shopId: string;
  readonly sourcePath: string;
  readonly status: VideoStatus;
  readonly stage: VideoStage | null;
  readonly done: number | null;
  readonly total: number | null;
  readonly error: string | null;
  readonly transcript: string | null;
  readonly seconds: number | null;
  readonly createdAt: string;
}

export interface Product {
  readonly id: string;
  readonly videoId: string;
  readonly position: number;
  readonly localName: string;
  readonly name: string;
  readonly category: string;
  readonly price: number | null;
  readonly currency: string | null;
  readonly priceQuote: string | null;
  readonly notes: readonly string[];
  readonly imagePath: string | null;
  readonly framePath: string;
  readonly confirmed: boolean;
  readonly updatedAt: string;
}

export interface Conversation {
  readonly id: string;
  readonly shopId: string;
  readonly channel: "web" | "whatsapp";
  readonly buyerPhone: string | null;
}

export interface OrderItem {
  readonly productId: string;
  readonly localName: string;
  readonly quantity: number;
  readonly price: number | null;
}

export interface Order {
  readonly id: string;
  readonly conversationId: string;
  readonly items: readonly OrderItem[];
  readonly total: number | null;
  readonly buyerName: string | null;
  readonly buyerPhone: string;
  readonly createdAt: string;
}

export interface Message {
  readonly id: string;
  readonly conversationId: string;
  readonly role: "buyer" | "seller";
  readonly text: string;
  readonly photoPath: string | null;
  readonly productIds: readonly string[];
  readonly orderId: string | null;
  readonly createdAt: string;
}

export interface OwnerQuestion {
  readonly id: string;
  readonly question: string;
  readonly done: boolean;
  readonly createdAt: string;
}

type Row = Record<string, unknown>;

const orderOf = (r: Row): Order => ({
  id: r.id as string,
  conversationId: r.conversation_id as string,
  items: JSON.parse(r.items as string) as OrderItem[],
  total: (r.total as number | null) ?? null,
  buyerName: (r.buyer_name as string | null) ?? null,
  buyerPhone: r.buyer_phone as string,
  createdAt: r.created_at as string,
});

const messageOf = (r: Row): Message => ({
  id: r.id as string,
  conversationId: r.conversation_id as string,
  role: r.role as Message["role"],
  text: r.text as string,
  photoPath: (r.photo_path as string | null) ?? null,
  productIds: JSON.parse(r.product_ids as string) as string[],
  orderId: (r.order_id as string | null) ?? null,
  createdAt: r.created_at as string,
});

const shopOf = (r: Row): Shop => ({
  id: r.id as string,
  name: r.name as string,
  slug: r.slug as string,
  ownerToken: r.owner_token as string,
});

const videoOf = (r: Row): Video => ({
  id: r.id as string,
  shopId: r.shop_id as string,
  sourcePath: r.source_path as string,
  status: r.status as VideoStatus,
  stage: (r.stage as VideoStage | null) ?? null,
  done: (r.done as number | null) ?? null,
  total: (r.total as number | null) ?? null,
  error: (r.error as string | null) ?? null,
  transcript: (r.transcript as string | null) ?? null,
  seconds: (r.seconds as number | null) ?? null,
  createdAt: r.created_at as string,
});

const productOf = (r: Row): Product => ({
  id: r.id as string,
  videoId: r.video_id as string,
  position: r.position as number,
  localName: r.local_name as string,
  name: r.name as string,
  category: r.category as string,
  price: (r.price as number | null) ?? null,
  currency: (r.currency as string | null) ?? null,
  priceQuote: (r.price_quote as string | null) ?? null,
  notes: JSON.parse(r.notes as string) as string[],
  imagePath: (r.image_path as string | null) ?? null,
  framePath: r.frame_path as string,
  confirmed: r.confirmed === 1,
  updatedAt: r.updated_at as string,
});

export function slugify(name: string): string {
  return (
    name
      .normalize("NFKD")
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "") || "shop"
  );
}

export type Store = ReturnType<typeof openStore>;

export function openStore(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
  db.exec(SCHEMA);
  const now = () => new Date().toISOString();
  const get = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).get(...params) as Row | undefined;
  const all = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as Row[];
  const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params);

  function transaction<T>(fn: () => T): T {
    db.exec("begin");
    try {
      const result = fn();
      db.exec("commit");
      return result;
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  }

  return {
    createShop(name: string): Shop {
      const base = slugify(name);
      let slug = base;
      for (let n = 2; get("select 1 from shops where slug = ?", slug); n++) slug = `${base}-${n}`;
      const shop = { id: randomUUID(), name, slug, ownerToken: randomBytes(24).toString("base64url") };
      run("insert into shops (id, name, slug, owner_token, created_at) values (?, ?, ?, ?, ?)", shop.id, name, slug, shop.ownerToken, now());
      return shop;
    },

    shopByToken(token: string): Shop | undefined {
      const row = get("select * from shops where owner_token = ?", token);
      return row && shopOf(row);
    },

    shopBySlug(slug: string): Shop | undefined {
      const row = get("select * from shops where slug = ?", slug);
      return row && shopOf(row);
    },

    addVideo(shopId: string, id: string, sourcePath: string): Video {
      run("insert into videos (id, shop_id, source_path, status, created_at) values (?, ?, ?, 'queued', ?)", id, shopId, sourcePath, now());
      return videoOf(get("select * from videos where id = ?", id)!);
    },

    video(shopId: string, id: string): Video | undefined {
      const row = get("select * from videos where shop_id = ? and id = ?", shopId, id);
      return row && videoOf(row);
    },

    videos(shopId: string): Video[] {
      return all("select * from videos where shop_id = ? order by created_at desc", shopId).map(videoOf);
    },

    nextQueuedVideo(): Video | undefined {
      const row = get("select * from videos where status = 'queued' order by created_at limit 1");
      return row && videoOf(row);
    },

    /** Videos cut off by a restart go back in the queue. */
    requeueInterrupted(): number {
      return Number(run("update videos set status = 'queued', stage = null, done = null, total = null where status = 'processing'").changes);
    },

    setProgress(id: string, status: VideoStatus, stage: VideoStage | null, done: number | null, total: number | null): void {
      run("update videos set status = ?, stage = ?, done = ?, total = ?, error = null where id = ?", status, stage, done, total, id);
    },

    failVideo(id: string, error: string): void {
      run("update videos set status = 'failed', error = ?, finished_at = ? where id = ?", error, now(), id);
    },

    retryVideo(shopId: string, id: string): boolean {
      return run("update videos set status = 'queued', error = null where shop_id = ? and id = ? and status = 'failed'", shopId, id).changes === 1;
    },

    finishVideo(video: Video, result: CatalogResult): void {
      transaction(() => {
        const last = get("select max(position) as last from products where shop_id = ?", video.shopId)?.last as number | null;
        let position = (last ?? -1) + 1;
        const at = now();
        for (const p of result.products) {
          const notes = [p.doubt, ...p.checks].filter((note): note is string => Boolean(note));
          run(
            `insert into products (id, shop_id, video_id, position, local_name, name, category, price, currency, price_quote,
               notes, image_path, frame_path, frame_time_s, sam_confidence, confirmed, created_at, updated_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
            randomUUID(), video.shopId, video.id, position++, p.local_name, p.name, p.category, p.price, p.currency,
            p.price_quote, JSON.stringify(notes), p.cutoutPath, p.framePath, p.frameTimeS, p.samConfidence, at, at,
          );
        }
        const seconds = result.seconds.prepare + result.seconds.listen + result.seconds.watch + result.seconds.cut;
        run(
          `update videos set status = 'done', stage = null, done = null, total = null, error = null, transcript = ?,
             language = ?, spent_usd = ?, seconds = ?, finished_at = ? where id = ?`,
          result.transcript, result.language, result.spentUsd, seconds, at, video.id,
        );
      });
    },

    products(shopId: string): Product[] {
      return all("select * from products where shop_id = ? order by position", shopId).map(productOf);
    },

    product(shopId: string, id: string): Product | undefined {
      const row = get("select * from products where shop_id = ? and id = ?", shopId, id);
      return row && productOf(row);
    },

    productById(id: string): Product | undefined {
      const row = get("select * from products where id = ?", id);
      return row && productOf(row);
    },

    productCounts(shopId: string): Map<string, number> {
      const rows = all("select video_id, count(*) as n from products where shop_id = ? group by video_id", shopId);
      return new Map(rows.map((r) => [r.video_id as string, r.n as number]));
    },

    updateProduct(
      shopId: string,
      id: string,
      patch: { localName?: string; name?: string; price?: number | null; confirmed?: boolean },
    ): Product | undefined {
      const current = this.product(shopId, id);
      if (!current) return undefined;
      run(
        "update products set local_name = ?, name = ?, price = ?, confirmed = ?, updated_at = ? where shop_id = ? and id = ?",
        patch.localName ?? current.localName,
        patch.name ?? current.name,
        patch.price === undefined ? current.price : patch.price,
        (patch.confirmed ?? current.confirmed) ? 1 : 0,
        now(),
        shopId,
        id,
      );
      return this.product(shopId, id);
    },

    deleteProduct(shopId: string, id: string): boolean {
      return run("delete from products where shop_id = ? and id = ?", shopId, id).changes === 1;
    },

    createConversation(shopId: string, channel: Conversation["channel"], buyerPhone: string | null = null): Conversation {
      const conversation = { id: randomUUID(), shopId, channel, buyerPhone };
      const at = now();
      run("insert into conversations (id, shop_id, channel, buyer_phone, created_at, updated_at) values (?, ?, ?, ?, ?, ?)", conversation.id, shopId, channel, buyerPhone, at, at);
      return conversation;
    },

    conversation(shopId: string, id: string): Conversation | undefined {
      const row = get("select * from conversations where shop_id = ? and id = ?", shopId, id);
      return row && { id: row.id as string, shopId: row.shop_id as string, channel: row.channel as Conversation["channel"], buyerPhone: (row.buyer_phone as string | null) ?? null };
    },

    addMessage(
      conversationId: string,
      message: Pick<Message, "role" | "text"> & Partial<Pick<Message, "photoPath" | "productIds" | "orderId">>,
      id: string = randomUUID(),
    ): Message {
      const at = now();
      run(
        "insert into messages (id, conversation_id, role, text, photo_path, product_ids, order_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
        id, conversationId, message.role, message.text, message.photoPath ?? null, JSON.stringify(message.productIds ?? []), message.orderId ?? null, at,
      );
      run("update conversations set updated_at = ? where id = ?", at, conversationId);
      return messageOf(get("select * from messages where id = ?", id)!);
    },

    messages(conversationId: string): Message[] {
      return all("select * from messages where conversation_id = ? order by created_at, rowid", conversationId).map(messageOf);
    },

    messageById(id: string): Message | undefined {
      const row = get("select * from messages where id = ?", id);
      return row && messageOf(row);
    },

    addOrder(shopId: string, order: Omit<Order, "id" | "createdAt">): Order {
      const id = randomUUID();
      run(
        "insert into orders (id, shop_id, conversation_id, items, total, buyer_name, buyer_phone, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
        id, shopId, order.conversationId, JSON.stringify(order.items), order.total, order.buyerName, order.buyerPhone, now(),
      );
      return orderOf(get("select * from orders where id = ?", id)!);
    },

    order(id: string): Order | undefined {
      const row = get("select * from orders where id = ?", id);
      return row && orderOf(row);
    },

    orders(shopId: string): Order[] {
      return all("select * from orders where shop_id = ? order by created_at desc", shopId).map(orderOf);
    },

    conversationOrders(conversationId: string): Order[] {
      return all("select * from orders where conversation_id = ? order by created_at, rowid", conversationId).map(orderOf);
    },

    addOwnerQuestion(shopId: string, conversationId: string, question: string): void {
      run("insert into owner_questions (id, shop_id, conversation_id, question, created_at) values (?, ?, ?, ?, ?)", randomUUID(), shopId, conversationId, question, now());
    },

    ownerQuestions(shopId: string): OwnerQuestion[] {
      return all("select * from owner_questions where shop_id = ? order by done, created_at desc", shopId).map((r) => ({
        id: r.id as string,
        question: r.question as string,
        done: r.done === 1,
        createdAt: r.created_at as string,
      }));
    },

    setQuestionDone(shopId: string, id: string, done: boolean): boolean {
      return run("update owner_questions set done = ? where shop_id = ? and id = ?", done ? 1 : 0, shopId, id).changes === 1;
    },

    /** Confirms every product with nothing left to check. */
    confirmAllWithoutNotes(shopId: string): number {
      return Number(
        run("update products set confirmed = 1, updated_at = ? where shop_id = ? and confirmed = 0 and notes = '[]'", now(), shopId).changes,
      );
    },
  };
}

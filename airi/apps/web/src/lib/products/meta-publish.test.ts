/** @jest-environment node */

// Studio v3's Instagram posts: the press checked, stored before any Graph
// call, advanced a step per request under a lease, published once, and the
// readiness the workbench reads. The product_ads collection is an in-memory
// stand-in that understands the queries meta-publish.ts sends; Instagram is a
// fake Graph API behind a mocked fetch. The queries' casting against the real
// schema is checked at the end.

type Doc = Record<string, unknown>;

const mockAds: Doc[] = [];
const mockPriceDoubt = jest.fn();
const mockSource = jest.fn();
const mockPostText = jest.fn();
const mockAdmission = jest.fn();
const mockCtwaReadiness = jest.fn();
const mockWhatsApp = jest.fn();
const mockSign = jest.fn();
const mockLoggerError = jest.fn();

// ---------------------------------------------------------------- a tiny Mongo

const mockIsOperators = (value: unknown): value is Doc =>
  Boolean(value) &&
  typeof value === "object" &&
  !(value instanceof Date) &&
  !Array.isArray(value) &&
  Object.keys(value as Doc).some(key => key.startsWith("$"));

const mockSame = (a: unknown, b: unknown) =>
  a instanceof Date || b instanceof Date
    ? a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
    : String(a) === String(b);

/** Whether one value meets a condition: a literal (null matches absent) or operators. */
function mockMeets(value: unknown, condition: unknown): boolean {
  if (!mockIsOperators(condition)) {
    if (condition === null) return value === null || value === undefined;
    return mockSame(value, condition);
  }
  return Object.entries(condition).every(([op, arg]) => {
    switch (op) {
      case "$in":
        return (arg as unknown[]).some(entry => mockSame(value, entry));
      case "$gt":
        return value instanceof Date && value > (arg as Date);
      case "$lte":
        return value instanceof Date && value <= (arg as Date);
      case "$ne":
        return !mockSame(value, arg);
      case "$elemMatch":
        return (
          Array.isArray(value) &&
          value.some(entry => mockMatches(entry as Doc, arg as Doc))
        );
      case "$not":
        return !mockMeets(value, arg);
      default:
        throw new Error(`mock Mongo: ${op} unsupported`);
    }
  });
}

function mockRead(doc: Doc, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) =>
        value && typeof value === "object" ? (value as Doc)[key] : undefined,
      doc
    );
}

function mockMatches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or")
      return (condition as Doc[]).some(entry => mockMatches(doc, entry));
    return mockMeets(mockRead(doc, key), condition);
  });
}

/** The post a positional update means: the first the filter's meta.posts condition matches. */
function mockPositional(doc: Doc, filter: Doc): Doc | undefined {
  const posts = (mockRead(doc, "meta.posts") as Doc[] | undefined) ?? [];
  const condition = filter["meta.posts"] as Doc | undefined;
  return posts.find(post =>
    condition?.$elemMatch
      ? mockMatches(post, condition.$elemMatch as Doc)
      : false
  );
}

function mockApply(doc: Doc, filter: Doc, update: Doc) {
  // Mongo finds the positional element before changing anything.
  const target = mockPositional(doc, filter);
  for (const [op, fields] of Object.entries(update)) {
    for (const [path, value] of Object.entries(fields as Doc)) {
      if (op === "$push" && path === "meta.posts") {
        const meta = (doc.meta as Doc | undefined) ?? { posts: [], ctwa: null };
        const each = (value as { $each: Doc[]; $slice: number }).$each;
        const slice = (value as { $slice: number }).$slice;
        meta.posts = [...((meta.posts as Doc[]) ?? []), ...each].slice(slice);
        doc.meta = meta;
      } else if (op === "$set" && path.startsWith("meta.posts.$.")) {
        if (!target) throw new Error("mock Mongo: positional without a match");
        target[path.slice("meta.posts.$.".length)] = value;
      } else if (op === "$unset" && path === "meta") {
        delete doc.meta;
      } else {
        throw new Error(`mock Mongo: ${op} ${path} unsupported`);
      }
    }
  }
}

/** A deep copy, as a query returns one; dates stay this realm's dates. */
function mockCopy<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map(mockCopy) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, mockCopy(entry)])
    ) as T;
  return value;
}

const mockLean = (result: unknown) => ({ lean: async () => mockCopy(result) });

jest.mock("@/models/product-ad", () => ({
  PRODUCT_AD_POSTS_MAX: 50,
  ProductAd: {
    findOne: (filter: Doc) =>
      mockLean(mockAds.find(doc => mockMatches(doc, filter)) ?? null),
    updateOne: async (filter: Doc, update: Doc) => {
      const doc = mockAds.find(entry => mockMatches(entry, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      mockApply(doc, filter, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    findOneAndUpdate: (filter: Doc, update: Doc) => {
      const doc = mockAds.find(entry => mockMatches(entry, filter));
      if (doc) mockApply(doc, filter, update);
      return mockLean(doc ?? null);
    },
  },
}));
jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentials: (...args: unknown[]) => mockSource(...args),
}));
jest.mock("@/lib/products/ads", () => ({
  adPostText: (...args: unknown[]) => mockPostText(...args),
  adAdmissionStop: (...args: unknown[]) => mockAdmission(...args),
}));
jest.mock("@/models/workspace-product", () => ({
  WorkspaceProduct: { exists: (...args: unknown[]) => mockPriceDoubt(...args) },
}));
jest.mock("@/lib/products/ctwa", () => ({
  ctwaReadiness: (...args: unknown[]) => mockCtwaReadiness(...args),
  productsCtwaRunCaps: () => ({
    enabled: false,
    maxDailyCents: 100,
    maxDays: 3,
  }),
}));
jest.mock("@/lib/products/kits", () => ({
  productsWhatsAppConnection: (...args: unknown[]) => mockWhatsApp(...args),
}));
jest.mock("@/lib/products/photo-urls", () => ({
  productPhotoUrl: (...args: unknown[]) => mockSign(...args),
}));
jest.mock("@/lib/google/creative-asset-read-url-media-api-adapter", () => ({
  ensureMediaApiCreativeAssetReadUrlPort: () => undefined,
}));
jest.mock("@/lib/logger", () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

import {
  PRODUCT_POST_LEASE_MS,
  PRODUCT_POST_STALE_MS,
  advanceProductAdPost,
  productPostQueries,
  productsMetaReadiness,
  publishProductAd,
  resetProductsMetaReadinessCache,
} from "./meta-publish";
import type { ProductAdPublishRequest } from "./types";

// ---------------------------------------------------------------- fixtures

const WS = "workspace-1";
const AD = "751f1f77bcf86cd799439031";
const DOLL = "651f1f77bcf86cd799439011";
const MUG = "651f1f77bcf86cd799439012";
const IG_USER = "17841400000000001";
const T0 = Date.parse("2026-11-04T05:50:00.000Z");

const ref = (path: string) => ({ bucket: "media", path });

function adDoc(overrides: Doc = {}): Doc {
  return {
    _id: AD,
    workspaceId: WS,
    status: "ready",
    motion: "filmed_sold",
    wordsCode: "kk",
    products: [
      { productId: DOLL, name: "Кукла", priceText: "5 000 ₸" },
      { productId: MUG, name: "Кружка", priceText: "500 ₸" },
    ],
    script: { postIntro: "Жаңа тауарлар" },
    scenes: [],
    ending: { phone: null, shopName: "Airi" },
    stills: { status: ref("ads/1-status.jpg"), feed: ref("ads/1-feed.jpg") },
    renderNo: 2,
    render: {
      renderNo: 2,
      video: ref("ads/2-video.mp4"),
      poster: ref("ads/2-poster.jpg"),
    },
    stillSet: {
      renderNo: 2,
      items: [
        {
          kind: "room",
          format: "feed",
          productId: DOLL,
          colourway: null,
          ref: ref("s/room-doll.jpg"),
        },
        {
          kind: "room",
          format: "feed",
          productId: MUG,
          colourway: null,
          ref: ref("s/room-mug.jpg"),
        },
        {
          kind: "studio",
          format: "feed",
          productId: DOLL,
          colourway: "sand",
          ref: ref("s/studio-doll-sand.jpg"),
        },
        {
          kind: "studio",
          format: "feed",
          productId: DOLL,
          colourway: "night",
          ref: ref("s/studio-doll-night.jpg"),
        },
        {
          kind: "collection",
          format: "feed",
          productId: null,
          colourway: null,
          ref: ref("s/collection.jpg"),
        },
        {
          kind: "price_list",
          format: "story",
          productId: null,
          colourway: null,
          ref: ref("s/price-list.jpg"),
        },
      ],
    },
    ...overrides,
  };
}

const instagramSource = (credentials: Doc = {}) => ({
  workspace_id: WS,
  credentials: {
    auth_method: "instagram_business_login",
    page_access_token: "token-1",
    instagram_business_account_id: IG_USER,
    username: "airi.chat__",
    granted_permissions: [
      "instagram_business_basic",
      "instagram_business_content_publish",
    ],
    ...credentials,
  },
});

// ---------------------------------------------------------------- a fake Instagram

type GraphCall = {
  method: string;
  path: string;
  params: Record<string, string>;
};

let graphCalls: GraphCall[] = [];
let containers: Map<
  string,
  { params: Record<string, string>; status: string[] }
>;
let published: Array<{
  id: string;
  container: string;
  timestamp: string;
  params: Record<string, string>;
}>;
let nextId = 0;
let quota = { used: 0, total: 100 };
/** Status codes a new video container goes through, one per status read. */
let videoStatuses: string[] = ["IN_PROGRESS", "FINISHED"];
/** Make the next call to this path answer this way instead. */
let failures: Array<{
  match: (call: GraphCall) => boolean;
  answer: () => Response;
}> = [];

const graphError = (
  code: number,
  message: string,
  subcode?: number,
  status = 400
) =>
  new Response(
    JSON.stringify({ error: { code, message, error_subcode: subcode } }),
    { status }
  );
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200 });

function fakeGraph(input: unknown, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const params: Record<string, string> =
    method === "POST"
      ? Object.fromEntries(new URLSearchParams(String(init?.body ?? "")))
      : Object.fromEntries(url.searchParams);
  if (!params.access_token) throw new Error("no token sent");
  delete params.access_token;
  const call = { method, path: url.pathname.replace("/v25.0/", ""), params };
  graphCalls.push(call);
  const failure = failures.find(entry => entry.match(call));
  if (failure) {
    failures = failures.filter(entry => entry !== failure);
    return Promise.resolve(failure.answer());
  }
  const [first, second] = call.path.split("/");
  if (method === "POST" && second === "media") {
    const id = `c-${++nextId}`;
    const isVideo = Boolean(params.video_url);
    containers.set(id, {
      params,
      status: isVideo ? [...videoStatuses] : ["FINISHED"],
    });
    return Promise.resolve(json({ id }));
  }
  if (method === "POST" && second === "media_publish") {
    const container = containers.get(params.creation_id);
    if (!container)
      return Promise.resolve(graphError(100, "Invalid creation id"));
    if (container.status[0] === "PUBLISHED")
      return Promise.resolve(
        graphError(9004, "The media has already been published")
      );
    container.status = ["PUBLISHED"];
    const id = `m-${++nextId}`;
    published.push({
      id,
      container: params.creation_id,
      timestamp: new Date(T0 + 5_000).toISOString().replace(".000Z", "+0000"),
      params: container.params,
    });
    return Promise.resolve(json({ id }));
  }
  if (method === "GET" && second === "content_publishing_limit")
    return Promise.resolve(
      json({
        data: [
          { quota_usage: quota.used, config: { quota_total: quota.total } },
        ],
      })
    );
  if (method === "GET" && (second === "media" || second === "stories"))
    return Promise.resolve(
      json({
        data: published
          .slice()
          .reverse()
          .map(media => ({
            id: media.id,
            timestamp: media.timestamp,
            permalink: `https://www.instagram.com/p/${media.id}/`,
            media_type:
              media.params.media_type === "CAROUSEL"
                ? "CAROUSEL_ALBUM"
                : media.params.video_url
                  ? "VIDEO"
                  : "IMAGE",
            media_product_type:
              media.params.media_type === "REELS"
                ? "REELS"
                : media.params.media_type === "STORIES"
                  ? "STORY"
                  : "FEED",
          })),
      })
    );
  if (method === "GET" && containers.has(first)) {
    const container = containers.get(first)!;
    const code =
      container.status.length > 1
        ? container.status.shift()!
        : container.status[0];
    return Promise.resolve(json({ status_code: code }));
  }
  if (method === "GET" && first.startsWith("m-"))
    return Promise.resolve(
      json({ id: first, permalink: `https://www.instagram.com/p/${first}/` })
    );
  return Promise.resolve(graphError(100, `fake Graph: ${method} ${call.path}`));
}

const posted = (path: string) =>
  graphCalls.filter(call => call.method === "POST" && call.path.endsWith(path));

// ---------------------------------------------------------------- set-up

let clockMs = T0;
const now = () => clockMs;

beforeEach(() => {
  jest.clearAllMocks();
  mockAds.length = 0;
  mockAds.push(adDoc());
  graphCalls = [];
  containers = new Map();
  published = [];
  nextId = 0;
  quota = { used: 0, total: 100 };
  videoStatuses = ["IN_PROGRESS", "FINISHED"];
  failures = [];
  clockMs = T0;
  global.fetch = jest.fn(fakeGraph) as typeof fetch;
  mockPriceDoubt.mockResolvedValue(null);
  mockSource.mockResolvedValue(instagramSource());
  mockPostText.mockReturnValue("Жаңа тауарлар\n\nКукла — 5 000 ₸");
  mockSign.mockImplementation(
    async (_ws: string, file: { path: string }) =>
      `https://signed.test/${file.path}`
  );
  mockAdmission.mockResolvedValue(null);
  mockWhatsApp.mockResolvedValue({ connected: true, displayPhone: "shop" });
  mockCtwaReadiness.mockResolvedValue({
    connected: true,
    adAccountName: "Airi.chat ad account",
    currency: "USD",
    pageName: "Airi.chat",
    pageHasWhatsApp: false,
    instagramPlacements: false,
    runEnabled: false,
    runMaxDailyCents: 100,
    runMaxDays: 3,
  });
  resetProductsMetaReadinessCache();
});

const press = (request: Partial<ProductAdPublishRequest> = {}) =>
  publishProductAd({
    workspaceId: WS,
    adId: AD,
    request: { requestId: "press-1", destination: "reel", ...request },
    now,
  });

const poll = (postId: string) =>
  advanceProductAdPost({ workspaceId: WS, adId: AD, postId, now });

const storedPosts = () =>
  ((mockAds[0].meta as Doc | undefined)?.posts as Doc[] | undefined) ?? [];

// ---------------------------------------------------------------- a Reel

describe("posting a Reel", () => {
  it("stores the post, makes the container, then publishes once it's processed", async () => {
    videoStatuses = ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"];
    const pressed = await press();
    expect(pressed).toMatchObject({
      created: true,
      post: {
        destination: "reel",
        state: "processing",
        renderNo: 2,
        motion: "filmed_sold",
        still: null,
        slides: [],
        permalink: null,
        requestedAt: new Date(T0).toISOString(),
      },
    });
    expect(posted("/media")).toEqual([
      {
        method: "POST",
        path: `${IG_USER}/media`,
        params: {
          caption: "Жаңа тауарлар\n\nКукла — 5 000 ₸",
          media_type: "REELS",
          video_url: "https://signed.test/ads/2-video.mp4",
          share_to_feed: "true",
          cover_url: "https://signed.test/ads/2-poster.jpg",
        },
      },
    ]);
    const postId = "post" in pressed ? pressed.post.id : "";
    expect(storedPosts()[0]).toMatchObject({
      requestId: "press-1",
      containerId: "c-1",
      leaseUntil: null,
    });

    // Instagram is still processing: nothing published yet.
    clockMs += 3_000;
    expect(await poll(postId)).toMatchObject({ post: { state: "processing" } });
    expect(posted("/media_publish")).toHaveLength(0);

    clockMs += 3_000;
    expect(await poll(postId)).toMatchObject({
      post: {
        state: "published",
        permalink: "https://www.instagram.com/p/m-2/",
        errorCode: null,
        publishedAt: new Date(clockMs).toISOString(),
      },
    });
    expect(posted("/media_publish")).toHaveLength(1);
    expect(storedPosts()[0]).toMatchObject({
      mediaId: "m-2",
      leaseUntil: null,
    });

    // Done: asking again changes nothing and calls nothing.
    const calls = graphCalls.length;
    expect(await poll(postId)).toMatchObject({ post: { state: "published" } });
    expect(graphCalls).toHaveLength(calls);
  });

  it("answers a repeated press with the same post and posts nothing twice", async () => {
    const first = await press();
    const again = await press();
    expect(again).toEqual({
      post: "post" in first ? first.post : null,
      created: false,
    });
    expect(storedPosts()).toHaveLength(1);
    expect(posted("/media")).toHaveLength(1);
  });

  it("refuses a second post to the same place while one is in flight", async () => {
    await press();
    expect(await press({ requestId: "press-2" })).toEqual({
      refused: "post_busy",
    });
    // Another place is free.
    expect(
      await press({ requestId: "press-3", destination: "story" })
    ).toMatchObject({ created: true, post: { destination: "story" } });
  });

  it("lets a post left processing long ago give way, failed", async () => {
    const first = await press();
    clockMs += PRODUCT_POST_STALE_MS + 1_000;
    const second = await press({ requestId: "press-2" });
    expect(second).toMatchObject({ created: true });
    expect(storedPosts()[0]).toMatchObject({
      id: "post" in first ? first.post.id : "",
      state: "failed",
      errorCode: "post_failed",
    });
  });

  it("keeps an ambiguous publishing post reserved even after the processing deadline", async () => {
    videoStatuses = ["FINISHED"];
    failures.push({
      match: call => call.path.endsWith("/media_publish"),
      answer: () =>
        graphError(2, "Service temporarily unavailable", undefined, 503),
    });
    expect(await press()).toMatchObject({ post: { state: "publishing" } });
    clockMs += PRODUCT_POST_STALE_MS + 1_000;
    expect(await press({ requestId: "press-2" })).toEqual({
      refused: "post_busy",
    });
    expect(storedPosts()).toHaveLength(1);
    expect(storedPosts()[0]).toMatchObject({ state: "publishing" });
    expect(posted("/media_publish")).toHaveLength(1);
  });

  it("does not replace stale processing while another request still holds its lease", async () => {
    await press();
    clockMs += PRODUCT_POST_STALE_MS + 1_000;
    storedPosts()[0].leaseUntil = new Date(clockMs + PRODUCT_POST_LEASE_MS);
    expect(await press({ requestId: "press-2" })).toEqual({
      refused: "post_busy",
    });
    expect(storedPosts()).toHaveLength(1);
    expect(storedPosts()[0]).toMatchObject({ state: "processing" });
  });

  it("leaves a post another request holds alone", async () => {
    videoStatuses = ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"];
    const pressed = await press();
    const postId = "post" in pressed ? pressed.post.id : "";
    const post = storedPosts()[0];
    post.leaseUntil = new Date(clockMs + PRODUCT_POST_LEASE_MS);
    const calls = graphCalls.length;
    expect(await poll(postId)).toMatchObject({ post: { state: "processing" } });
    expect(graphCalls).toHaveLength(calls);
    // Once the lease runs out, the next poll goes on.
    clockMs += PRODUCT_POST_LEASE_MS + 1;
    await poll(postId);
    expect(graphCalls.length).toBeGreaterThan(calls);
  });

  it("settles a lost media_publish answer by reading the container, never publishing twice", async () => {
    videoStatuses = ["FINISHED"];
    failures.push({
      match: call => call.path.endsWith("/media_publish"),
      answer: () => {
        // Instagram publishes, but the answer is lost.
        const container = containers.get("c-1")!;
        container.status = ["PUBLISHED"];
        published.push({
          id: "m-9",
          container: "c-1",
          timestamp: "2026-11-04T05:50:03+0000",
          params: container.params,
        });
        return graphError(2, "Service temporarily unavailable", undefined, 503);
      },
    });
    const pressed = await press();
    const postId = "post" in pressed ? pressed.post.id : "";
    expect(pressed).toMatchObject({ post: { state: "publishing" } });

    clockMs += 3_000;
    expect(await poll(postId)).toMatchObject({
      post: {
        state: "published",
        permalink: "https://www.instagram.com/p/m-9/",
        publishedAt: "2026-11-04T05:50:03.000Z",
      },
    });
    expect(posted("/media_publish")).toHaveLength(1);
  });

  it("publishes again only when the container wasn't published and nothing new is live", async () => {
    videoStatuses = ["FINISHED"];
    failures.push({
      match: call => call.path.endsWith("/media_publish"),
      answer: () =>
        graphError(2, "Service temporarily unavailable", undefined, 503),
    });
    const pressed = await press();
    const postId = "post" in pressed ? pressed.post.id : "";
    expect(storedPosts()[0]).toMatchObject({ state: "publishing" });

    clockMs += 3_000;
    expect(await poll(postId)).toMatchObject({ post: { state: "published" } });
    expect(posted("/media_publish")).toHaveLength(2);
    expect(published).toHaveLength(1);
  });

  it("never takes another post's media for its own lost answer", async () => {
    // The first picture goes out at once.
    await press({
      requestId: "press-a",
      destination: "post",
      still: { kind: "room", productId: DOLL },
    });
    // The second's answer is lost, and Instagram took nothing.
    failures.push({
      match: call => call.path.endsWith("/media_publish"),
      answer: () =>
        graphError(2, "Service temporarily unavailable", undefined, 503),
    });
    clockMs += 10_000;
    const second = await press({
      requestId: "press-b",
      destination: "post",
      still: { kind: "room", productId: MUG },
    });
    expect(second).toMatchObject({ post: { state: "publishing" } });

    clockMs += 3_000;
    expect(await poll("post" in second ? second.post.id : "")).toMatchObject({
      post: {
        state: "published",
        permalink: "https://www.instagram.com/p/m-4/",
      },
    });
    expect(published.map(media => media.container)).toEqual(["c-1", "c-3"]);
  });

  it("settles a refused ask as published when an earlier one did publish it", async () => {
    videoStatuses = ["FINISHED"];
    // The first ask publishes but its answer is lost; the newest media lag behind.
    failures.push({
      match: call => call.path.endsWith("/media_publish"),
      answer: () => {
        containers.get("c-1")!.status = ["FINISHED", "PUBLISHED"];
        return graphError(2, "Service temporarily unavailable", undefined, 503);
      },
    });
    const pressed = await press();
    const postId = "post" in pressed ? pressed.post.id : "";
    clockMs += 3_000;
    // Asked again, Instagram refuses: the container is published by now.
    failures.push({
      match: call => call.path.endsWith("/media_publish"),
      answer: () => graphError(9004, "The media has already been published"),
    });
    expect(await poll(postId)).toMatchObject({ post: { state: "publishing" } });
    clockMs += 3_000;
    expect(await poll(postId)).toMatchObject({
      post: { state: "published", errorCode: null },
    });
  });

  it("never publishes blind when the newest media can't be read", async () => {
    videoStatuses = ["FINISHED"];
    failures.push({
      match: call => call.path.endsWith("/media_publish"),
      answer: () =>
        graphError(2, "Service temporarily unavailable", undefined, 503),
    });
    const pressed = await press();
    const postId = "post" in pressed ? pressed.post.id : "";
    failures.push({
      match: call => call.path.endsWith("/media") && call.method === "GET",
      answer: () =>
        graphError(2, "Service temporarily unavailable", undefined, 503),
    });
    clockMs += 3_000;
    expect(await poll(postId)).toMatchObject({ post: { state: "publishing" } });
    expect(posted("/media_publish")).toHaveLength(1);
  });

  it("keeps a refused publish pending when its follow-up status cannot be read", async () => {
    videoStatuses = ["FINISHED"];
    failures.push({
      match: call => call.path.endsWith("/media_publish"),
      answer: () => {
        containers.get("c-1")!.status = ["PUBLISHED"];
        failures.push({
          match: call => call.method === "GET" && call.path === "c-1",
          answer: () =>
            graphError(2, "Service temporarily unavailable", undefined, 503),
        });
        return graphError(9004, "The media has already been published");
      },
    });
    const first = await press();
    expect(first).toMatchObject({
      post: { state: "publishing", errorCode: null },
    });
    expect(await press({ requestId: "press-2" })).toEqual({
      refused: "post_busy",
    });
    clockMs += 3_000;
    expect(await poll("post" in first ? first.post.id : "")).toMatchObject({
      post: { state: "published" },
    });
    expect(posted("/media_publish")).toHaveLength(1);
  });

  it("does not turn an unknown publish into a new attempt when its account read is refused", async () => {
    videoStatuses = ["FINISHED"];
    failures.push({
      match: call => call.path.endsWith("/media_publish"),
      answer: () =>
        graphError(2, "Service temporarily unavailable", undefined, 503),
    });
    const first = await press();
    failures.push({
      match: call => call.method === "GET" && call.path === "c-1",
      answer: () => graphError(190, "Access token expired"),
    });
    clockMs += 3_000;
    expect(await poll("post" in first ? first.post.id : "")).toMatchObject({
      post: { state: "publishing", errorCode: null },
    });
    expect(await press({ requestId: "press-2" })).toEqual({
      refused: "post_busy",
    });
    expect(posted("/media_publish")).toHaveLength(1);
  });

  it("keeps an earlier ambiguous publish pending when a later ask says media is not ready", async () => {
    videoStatuses = ["FINISHED"];
    failures.push({
      match: call => call.path.endsWith("/media_publish"),
      answer: () =>
        graphError(2, "Service temporarily unavailable", undefined, 503),
    });
    const first = await press();
    failures.push({
      match: call => call.path.endsWith("/media_publish"),
      answer: () => graphError(9007, "Media ID is not available", 2207027),
    });
    clockMs += 3_000;
    expect(await poll("post" in first ? first.post.id : "")).toMatchObject({
      post: { state: "publishing" },
    });
    clockMs += PRODUCT_POST_STALE_MS + 1_000;
    expect(await press({ requestId: "press-2" })).toEqual({
      refused: "post_busy",
    });
    expect(storedPosts()).toHaveLength(1);
  });

  it("goes back to waiting when Instagram says the media isn't ready", async () => {
    videoStatuses = ["FINISHED"];
    failures.push({
      match: call => call.path.endsWith("/media_publish"),
      answer: () => graphError(9007, "Media ID is not available", 2207027),
    });
    const pressed = await press();
    expect(pressed).toMatchObject({ post: { state: "processing" } });
    clockMs += 3_000;
    expect(await poll("post" in pressed ? pressed.post.id : "")).toMatchObject({
      post: { state: "published" },
    });
  });

  it("reads the permalink on the next poll when media_publish took the request's time", async () => {
    videoStatuses = ["FINISHED"];
    failures.push({
      match: call => call.path.endsWith("/media_publish"),
      answer: () => {
        // Instagram publishes, slowly: no time is left for the permalink.
        clockMs += 7_500;
        const container = containers.get("c-1")!;
        container.status = ["PUBLISHED"];
        published.push({
          id: "m-7",
          container: "c-1",
          timestamp: "2026-11-04T05:50:07+0000",
          params: container.params,
        });
        return json({ id: "m-7" });
      },
    });
    const pressed = await press();
    const postId = "post" in pressed ? pressed.post.id : "";
    const publishedAt = new Date(T0 + 7_500).toISOString();
    expect(pressed).toMatchObject({
      post: { state: "publishing", permalink: null, publishedAt },
    });
    expect(storedPosts()[0]).toMatchObject({
      mediaId: "m-7",
      leaseUntil: null,
    });
    expect(
      graphCalls.filter(call => call.path === "m-7" && call.method === "GET")
    ).toHaveLength(0);

    clockMs += 3_000;
    expect(await poll(postId)).toMatchObject({
      post: {
        state: "published",
        permalink: "https://www.instagram.com/p/m-7/",
        publishedAt,
        errorCode: null,
      },
    });
    expect(posted("/media_publish")).toHaveLength(1);
    // Settled: nothing more is asked.
    const calls = graphCalls.length;
    await poll(postId);
    expect(graphCalls).toHaveLength(calls);
  });

  it("asks once more for a permalink Graph didn't give, then settles without it", async () => {
    videoStatuses = ["FINISHED"];
    const noPermalink = {
      match: (call: GraphCall) =>
        call.method === "GET" && call.path.startsWith("m-"),
      answer: () =>
        graphError(2, "Service temporarily unavailable", undefined, 503),
    };
    failures.push(noPermalink, { ...noPermalink });
    const pressed = await press();
    const postId = "post" in pressed ? pressed.post.id : "";
    expect(pressed).toMatchObject({ post: { state: "publishing" } });

    clockMs += 3_000;
    expect(await poll(postId)).toMatchObject({
      post: { state: "published", permalink: null, errorCode: null },
    });
    expect(posted("/media_publish")).toHaveLength(1);
    expect(storedPosts()[0]).toMatchObject({
      mediaId: "m-2",
      leaseUntil: null,
    });
  });

  it.each([
    [
      "ERROR",
      "Error: Media upload has failed with error code 2207026",
      "Instagram couldn't use the video's format.",
    ],
    ["EXPIRED", null, "Instagram's upload expired before it was posted."],
  ])(
    "fails a container Instagram marks %s, with its reason",
    async (code, status, message) => {
      videoStatuses = [code];
      if (status)
        failures.push({
          match: call => call.method === "GET" && call.path === "c-1",
          answer: () => json({ status_code: code, status }),
        });
      const pressed = await press();
      expect(pressed).toMatchObject({
        post: {
          state: "failed",
          errorCode: "post_failed",
          errorMessage: message,
        },
      });
      expect(posted("/media_publish")).toHaveLength(0);
    }
  );

  it("stores Graph's refusal of the container on the post", async () => {
    failures.push({
      match: call => call.path.endsWith("/media") && call.method === "POST",
      answer: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 100,
              message: "Invalid parameter",
              error_user_msg: "The aspect ratio is not supported.",
            },
          }),
          { status: 400 }
        ),
    });
    expect(await press()).toMatchObject({
      created: true,
      post: {
        state: "failed",
        errorCode: "post_failed",
        errorMessage: "The aspect ratio is not supported.",
      },
    });
  });

  it("waits out Meta's own trouble making the container, then makes it", async () => {
    failures.push({
      match: call => call.path.endsWith("/media") && call.method === "POST",
      answer: () =>
        graphError(2, "Service temporarily unavailable", undefined, 503),
    });
    const pressed = await press();
    expect(pressed).toMatchObject({ post: { state: "processing" } });
    expect(storedPosts()[0]).toMatchObject({ containerId: null });
    clockMs += 3_000;
    await poll("post" in pressed ? pressed.post.id : "");
    expect(storedPosts()[0]).toMatchObject({ containerId: "c-1" });
  });

  it("stores the daily limit when media_publish says it's reached", async () => {
    videoStatuses = ["FINISHED"];
    failures.push({
      match: call => call.path.endsWith("/media_publish"),
      answer: () => graphError(9, "Application request limit reached", 2207042),
    });
    expect(await press()).toMatchObject({
      post: { state: "failed", errorCode: "instagram_quota" },
    });
  });

  it("fails the post when the ad changed before its container was made", async () => {
    failures.push({
      match: call => call.path.endsWith("/media") && call.method === "POST",
      answer: () =>
        graphError(2, "Service temporarily unavailable", undefined, 503),
    });
    const pressed = await press();
    (mockAds[0].render as Doc).renderNo = 3;
    clockMs += 3_000;
    expect(await poll("post" in pressed ? pressed.post.id : "")).toMatchObject({
      post: { state: "failed", errorCode: "post_failed" },
    });
  });
});

// ---------------------------------------------------------------- pictures

describe("posting pictures", () => {
  it("posts a feed picture at once, with the studio colourway asked for", async () => {
    const pressed = await press({
      destination: "post",
      still: { kind: "studio", productId: DOLL, colourway: "night" },
      caption: "Кукла",
    });
    expect(pressed).toMatchObject({
      created: true,
      post: {
        state: "published",
        motion: null,
        still: { kind: "studio", productId: DOLL, colourway: "night" },
        permalink: "https://www.instagram.com/p/m-2/",
      },
    });
    expect(posted("/media")[0].params).toEqual({
      caption: "Кукла",
      image_url: "https://signed.test/s/studio-doll-night.jpg",
    });
  });

  it("takes a product's default studio colourway, its first", async () => {
    await press({
      destination: "post",
      still: { kind: "studio", productId: DOLL },
    });
    expect(posted("/media")[0].params.image_url).toBe(
      "https://signed.test/s/studio-doll-sand.jpg"
    );
    expect(storedPosts()[0].still).toMatchObject({ colourway: "sand" });
  });

  it("uses v2's one picture as In a room of the first product without a still set", async () => {
    mockAds[0] = adDoc({ stillSet: undefined });
    await press({
      destination: "post",
      still: { kind: "room", productId: DOLL },
    });
    expect(posted("/media")[0].params.image_url).toBe(
      "https://signed.test/ads/1-feed.jpg"
    );
  });

  it("refuses a picture the latest video doesn't have, storing nothing", async () => {
    mockAds[0] = adDoc({
      stillSet: { ...(adDoc().stillSet as Doc), renderNo: 1 },
    });
    expect(
      await press({
        destination: "post",
        still: { kind: "studio", productId: DOLL },
      })
    ).toEqual({
      refused: "invalid_request",
      issues: [`still: the latest video has no feed studio picture of ${DOLL}`],
    });
    expect(storedPosts()).toHaveLength(0);
    expect(graphCalls).toHaveLength(0);
  });

  it("posts a picture Story without a caption", async () => {
    expect(
      await press({
        destination: "story",
        still: { kind: "price_list", productId: null },
        caption: "ignored",
      })
    ).toMatchObject({ post: { state: "published", destination: "story" } });
    expect(posted("/media")[0].params).toEqual({
      media_type: "STORIES",
      image_url: "https://signed.test/s/price-list.jpg",
    });
  });

  it("posts a video Story from the ad's video", async () => {
    const pressed = await press({ destination: "story" });
    expect(pressed).toMatchObject({
      post: { motion: "filmed_sold", still: null },
    });
    expect(posted("/media")[0].params).toEqual({
      media_type: "STORIES",
      video_url: "https://signed.test/ads/2-video.mp4",
    });
  });

  it("posts a carousel: Collection, then In a room of each product, by default", async () => {
    const pressed = await press({ destination: "carousel" });
    expect(pressed).toMatchObject({
      post: {
        state: "published",
        slides: [
          { kind: "collection", productId: null, colourway: null },
          { kind: "room", productId: DOLL, colourway: null },
          { kind: "room", productId: MUG, colourway: null },
        ],
      },
    });
    const made = posted("/media").map(call => call.params);
    expect(made).toEqual([
      {
        image_url: "https://signed.test/s/collection.jpg",
        is_carousel_item: "true",
      },
      {
        image_url: "https://signed.test/s/room-doll.jpg",
        is_carousel_item: "true",
      },
      {
        image_url: "https://signed.test/s/room-mug.jpg",
        is_carousel_item: "true",
      },
      {
        caption: "Жаңа тауарлар\n\nКукла — 5 000 ₸",
        media_type: "CAROUSEL",
        children: "c-1,c-2,c-3",
      },
    ]);
    expect(storedPosts()[0]).toMatchObject({
      childIds: ["c-1", "c-2", "c-3"],
      containerId: "c-4",
    });
  });

  it("goes on with a carousel's items after a pause, keeping their order", async () => {
    failures.push({
      match: call =>
        call.method === "POST" &&
        call.params.image_url?.endsWith("room-mug.jpg"),
      answer: () =>
        graphError(2, "Service temporarily unavailable", undefined, 503),
    });
    const pressed = await press({ destination: "carousel" });
    expect(storedPosts()[0]).toMatchObject({
      childIds: ["c-1", "c-2"],
      containerId: null,
    });
    clockMs += 3_000;
    expect(await poll("post" in pressed ? pressed.post.id : "")).toMatchObject({
      post: { state: "published" },
    });
    expect(posted("/media").at(-1)?.params.children).toBe("c-1,c-2,c-3");
  });

  it("waits for a carousel's items Instagram is still processing, then makes it", async () => {
    failures.push({
      match: call =>
        call.method === "POST" && call.params.media_type === "CAROUSEL",
      answer: () => graphError(9007, "Media ID is not available", 2207027),
    });
    const pressed = await press({ destination: "carousel" });
    expect(pressed).toMatchObject({ post: { state: "processing" } });
    expect(storedPosts()[0]).toMatchObject({
      childIds: ["c-1", "c-2", "c-3"],
      containerId: null,
      errorCode: null,
    });
    clockMs += 3_000;
    expect(await poll("post" in pressed ? pressed.post.id : "")).toMatchObject({
      post: { state: "published" },
    });
    // The items were made once; the carousel on the second ask.
    expect(posted("/media")).toHaveLength(5);
    expect(posted("/media").at(-1)?.params.children).toBe("c-1,c-2,c-3");
  });

  it("refuses a carousel with fewer than two pictures", async () => {
    mockAds[0] = adDoc({ stillSet: undefined });
    expect(await press({ destination: "carousel" })).toEqual({
      refused: "invalid_request",
      issues: ["slides: the latest video has fewer than 2 pictures to post"],
    });
  });
});

// ---------------------------------------------------------------- refusals

describe("what stops a press before anything is stored", () => {
  it("is ad_not_found for another workspace's ad", async () => {
    expect(
      await publishProductAd({
        workspaceId: "workspace-2",
        adId: AD,
        request: { requestId: "r", destination: "reel" },
        now,
      })
    ).toEqual({ refused: "ad_not_found" });
  });

  it("is ad_not_ready while a run makes the ad", async () => {
    mockAds[0].status = "making";
    expect(await press()).toEqual({ refused: "ad_not_ready" });
  });

  it("is price_to_check when a product has a red tag", async () => {
    mockPriceDoubt.mockResolvedValue({ _id: DOLL });
    expect(await press()).toEqual({ refused: "price_to_check" });
    expect(mockPriceDoubt).toHaveBeenCalledWith({
      workspaceId: WS,
      _id: { $in: [DOLL, MUG] },
      "doubts.about": "price",
    });
    expect(storedPosts()).toHaveLength(0);
  });

  it.each([
    ["no source", null],
    ["no token", instagramSource({ page_access_token: "" })],
    [
      "no publishing grant",
      instagramSource({ granted_permissions: ["instagram_business_basic"] }),
    ],
  ])("is instagram_not_connected with %s", async (_label, source) => {
    mockSource.mockResolvedValue(source);
    expect(await press()).toEqual({ refused: "instagram_not_connected" });
    expect(storedPosts()).toHaveLength(0);
  });

  it("is instagram_quota when today's limit is used up", async () => {
    quota = { used: 100, total: 100 };
    expect(await press()).toEqual({ refused: "instagram_quota" });
  });

  it("goes ahead when the limit can't be read", async () => {
    failures.push({
      match: call => call.path.endsWith("content_publishing_limit"),
      answer: () => graphError(10, "Permission denied", undefined, 403),
    });
    expect(await press()).toMatchObject({ created: true });
  });

  it("is invalid_request for a caption over the hashtag limit from the post text", async () => {
    mockPostText.mockReturnValue(
      Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ")
    );
    expect(await press()).toEqual({
      refused: "invalid_request",
      issues: ["caption: at most 30 hashtags"],
    });
  });
});

describe("a post's poll", () => {
  it("is post_not_found for a post the ad hasn't, ad_not_found for no ad", async () => {
    expect(await poll("751f1f77bcf86cd799439099")).toEqual({
      refused: "post_not_found",
    });
    expect(
      await advanceProductAdPost({
        workspaceId: "workspace-2",
        adId: AD,
        postId: "751f1f77bcf86cd799439099",
        now,
      })
    ).toEqual({ refused: "ad_not_found" });
  });

  it("fails the post when Instagram was disconnected meanwhile", async () => {
    const pressed = await press();
    mockSource.mockResolvedValue(null);
    clockMs += 3_000;
    expect(await poll("post" in pressed ? pressed.post.id : "")).toMatchObject({
      post: { state: "failed", errorCode: "instagram_not_connected" },
    });
  });
});

// ---------------------------------------------------------------- readiness

describe("readiness", () => {
  it("answers Instagram, Meta Ads, WhatsApp and AI, names and counts only", async () => {
    quota = { used: 3, total: 100 };
    mockAdmission.mockResolvedValue("ai_disabled");
    const meta = await productsMetaReadiness(WS, { now });
    expect(meta).toEqual({
      instagram: {
        connected: true,
        username: "airi.chat__",
        canPublish: true,
        quotaLeft: 97,
      },
      ads: expect.objectContaining({ connected: true, pageHasWhatsApp: false }),
      whatsapp: { connected: true },
      ai: { blocked: "ai_disabled" },
    });
    expect(JSON.stringify(meta)).not.toContain("token-1");
    expect(JSON.stringify(meta)).not.toContain(IG_USER);
  });

  it("is cached 60 s per workspace, unless asked fresh", async () => {
    mockCtwaReadiness.mockResolvedValue({
      ...(await mockCtwaReadiness()),
      pageHasWhatsApp: true,
    });
    await productsMetaReadiness(WS, { now });
    clockMs += 30_000;
    mockSource.mockResolvedValue(null);
    expect((await productsMetaReadiness(WS, { now })).instagram.connected).toBe(
      true
    );
    expect(
      (await productsMetaReadiness(WS, { now, fresh: true })).instagram
        .connected
    ).toBe(false);
    mockSource.mockResolvedValue(instagramSource());
    clockMs += 61_000;
    expect((await productsMetaReadiness(WS, { now })).instagram.connected).toBe(
      true
    );
  });

  it("is cached 15 s while something isn't ready", async () => {
    // The Page has no WhatsApp linked yet.
    expect((await productsMetaReadiness(WS, { now })).ads.pageHasWhatsApp).toBe(
      false
    );
    mockCtwaReadiness.mockResolvedValue({
      ...(await mockCtwaReadiness()),
      pageHasWhatsApp: true,
    });
    clockMs += 10_000;
    expect((await productsMetaReadiness(WS, { now })).ads.pageHasWhatsApp).toBe(
      false
    );
    clockMs += 6_000;
    expect((await productsMetaReadiness(WS, { now })).ads.pageHasWhatsApp).toBe(
      true
    );
    expect((await productsMetaReadiness(WS, { now })).instagram.connected).toBe(
      true
    );
  });

  it("says false or null for what can't be read, never throwing", async () => {
    mockSource.mockRejectedValue(new Error("Supabase down"));
    mockCtwaReadiness.mockRejectedValue(new Error("Graph down"));
    mockWhatsApp.mockRejectedValue(new Error("Mongo down"));
    mockAdmission.mockRejectedValue(new Error("ledger down"));
    expect(await productsMetaReadiness(WS, { now })).toEqual({
      instagram: {
        connected: false,
        username: null,
        canPublish: false,
        quotaLeft: null,
      },
      ads: {
        connected: false,
        adAccountName: null,
        currency: null,
        pageName: null,
        pageHasWhatsApp: null,
        instagramPlacements: false,
        runEnabled: false,
        runMaxDailyCents: 100,
        runMaxDays: 3,
      },
      whatsapp: { connected: false },
      ai: { blocked: null },
    });
  });

  it("can't publish without the grant, and reads no limit then", async () => {
    mockSource.mockResolvedValue(
      instagramSource({ granted_permissions: "instagram_business_basic" })
    );
    expect((await productsMetaReadiness(WS, { now })).instagram).toEqual({
      connected: true,
      username: "airi.chat__",
      canPublish: false,
      quotaLeft: null,
    });
    expect(graphCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- the real schema

describe("the queries, cast by the real schema", () => {
  const { ProductAd: RealProductAd } = jest.requireActual<
    typeof import("@/models/product-ad")
  >("@/models/product-ad");
  const castUpdate = jest.requireActual<
    (
      schema: unknown,
      update: unknown,
      options: unknown,
      model: unknown,
      filter: unknown
    ) => Doc
  >("mongoose/lib/helpers/query/castUpdate");
  const castFilter = (filter: Doc) =>
    RealProductAd.find().cast(RealProductAd, filter) as Doc;
  const at = new Date(T0);
  const ids = { workspaceId: WS, adId: AD, postId: "751f1f77bcf86cd799439099" };

  it("casts every filter", () => {
    expect(() =>
      castFilter(
        productPostQueries.insertFilter({
          ...ids,
          requestId: "r",
          destination: "reel",
          staleBefore: at,
        })
      )
    ).not.toThrow();
    expect(() =>
      castFilter(
        productPostQueries.staleFilter({
          ...ids,
          destination: "reel",
          staleBefore: at,
          now: at,
        })
      )
    ).not.toThrow();
    expect(() =>
      castFilter(productPostQueries.leaseFilter({ ...ids, now: at }))
    ).not.toThrow();
    expect(() =>
      castFilter(productPostQueries.heldFilter({ ...ids, lease: at }))
    ).not.toThrow();
  });

  it("casts the push and the positional changes onto the post's own paths", () => {
    const filter = productPostQueries.heldFilter({ ...ids, lease: at });
    const pushed = castUpdate(
      RealProductAd.schema,
      productPostQueries.insertUpdate({
        id: ids.postId,
        requestId: "r",
        destination: "post",
        still: { kind: "studio", productId: DOLL, colourway: "night" },
        slides: [],
        renderNo: 2,
        motion: null,
        caption: "Hi",
        state: "processing",
        containerId: null,
        childIds: [],
        mediaId: null,
        permalink: null,
        errorCode: null,
        errorMessage: null,
        requestedAt: at,
        publishedAt: null,
        leaseUntil: null,
      }),
      {},
      RealProductAd,
      filter
    );
    expect(pushed).toMatchObject({
      $push: { "meta.posts": { $slice: -50 } },
    });
    const set = castUpdate(
      RealProductAd.schema,
      productPostQueries.postUpdate({
        state: "published",
        mediaId: "m-1",
        publishedAt: at,
        childIds: ["c-1"],
        leaseUntil: null,
      }),
      {},
      RealProductAd,
      filter
    );
    expect(set).toEqual({
      $set: {
        "meta.posts.$.state": "published",
        "meta.posts.$.mediaId": "m-1",
        "meta.posts.$.publishedAt": at,
        "meta.posts.$.childIds": ["c-1"],
        "meta.posts.$.leaseUntil": null,
      },
    });
  });
});

import "server-only";
import {
  GraphApiError,
  containerStatus,
  createContainerForAccount,
  isGraphIdUnavailableError,
  isGraphMediaNotReadyError,
  isGraphPermissionError,
  isGraphQuotaError,
  isGraphTokenError,
  isGraphTransientError,
  loadInstagramPublishAccount,
  permalinkOf,
  publishContainerForAccount,
  publishingQuota,
  recentMedia,
  type InstagramContainer,
  type InstagramPublishAccount,
  type InstagramRecentMedia,
} from "@/lib/instagram/publish";
import { ensureMediaApiCreativeAssetReadUrlPort } from "@/lib/google/creative-asset-read-url-media-api-adapter";
import { logger } from "@/lib/logger";
import { captionIssues, isAdObjectId } from "@/lib/products/ad-request";
import { adAdmissionStop, adPostText } from "@/lib/products/ads";
import { ctwaReadiness, productsCtwaRunCaps } from "@/lib/products/ctwa";
import { productsWhatsAppConnection } from "@/lib/products/kits";
import { toAdPostRecord } from "@/lib/products/meta-records";
import { productPhotoUrl } from "@/lib/products/photo-urls";
import {
  PRODUCT_AD_CAPTION_MAX,
  PRODUCT_AD_CAROUSEL_MAX_SLIDES,
  PRODUCT_AD_CAROUSEL_MIN_SLIDES,
  productAdMotionOf,
  type ProductAdPostDestination,
  type ProductAdPostRecord,
  type ProductAdPublishRequest,
  type ProductAdStillChoice,
  type ProductAdStillFormat,
  type ProductsCtwaReadiness,
  type ProductsMetaFailureCode,
  type ProductsMetaReadiness,
  type StoredFileRef,
} from "@/lib/products/types";
import {
  PRODUCT_AD_POSTS_MAX,
  ProductAd,
  type IProductAd,
  type ProductAdStoredPost,
} from "@/models/product-ad";
import { WorkspaceProduct } from "@/models/workspace-product";
import mongoose from "mongoose";

// Studio v3's Instagram posts of an ad (stream P1): "Post Reel", "Post
// Story", "Post" and "Post carousel" through the Instagram Graph API, and the
// readiness the workbench reads first (GET /products/meta).
//
// A press stores the post on the ad (meta.posts) before any Graph call, so a
// repeat of the same press answers that post and two presses never post
// twice. Each request then advances it a step at a time, at most about 8 s,
// under a 30 s lease on the post: create the container(s) with freshly
// signed links, wait for Instagram to process them, mark the post
// "publishing", call media_publish, read the permalink. A media_publish whose
// answer is lost is settled by reading the container (PUBLISHED: find the
// media among the newest) before ever asking again. Once stored, a refusal
// lands on the post (failed, with Meta's reason in plain English).

/** A poll holds the post this long; another poll leaves it alone meanwhile. */
export const PRODUCT_POST_LEASE_MS = 30_000;
/** How long one request advances a post. */
export const PRODUCT_POST_ADVANCE_MS = 8_000;
/** How long the press itself advances the post, after its checks. */
const PRODUCT_POST_PRESS_ADVANCE_MS = 6_000;
/** The longest one Graph call may take inside that. */
const GRAPH_CALL_MAX_MS = 6_000;
/** Below this much time left, a request stops and leaves the rest to the next. */
const GRAPH_CALL_MIN_MS = 1_000;
/**
 * A post still processing after this long no longer holds its destination:
 * the next press marks it failed (it was never published) and posts anew.
 */
export const PRODUCT_POST_STALE_MS = 15 * 60_000;
/** A published media counts as this post's when Instagram dates it this close before the press (clock skew). */
const MEDIA_MATCH_SKEW_MS = 60_000;

const IN_FLIGHT = ["processing", "publishing"] as const;

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

// ---------------------------------------------------------------------------
// What a post sends: the ad's video or its stills

type StillPick = { choice: ProductAdStillChoice; ref: StoredFileRef };

const usableRef = (
  ref: Partial<StoredFileRef> | null | undefined
): StoredFileRef | null =>
  ref?.bucket && ref.path ? { bucket: ref.bucket, path: ref.path } : null;

/** The stills of the video shown (the render's own set), in stored order. */
function shownStills(doc: IProductAd) {
  const set = doc.stillSet;
  return set && doc.render && set.renderNo === doc.render.renderNo
    ? (set.items ?? [])
    : [];
}

/**
 * The still a choice names in `format`, from the video shown: for studio,
 * the colourway asked for, else the product's default (its first). v2's one
 * 4:5 picture (`stills.feed`) is In a room of the first product.
 */
export function findAdStill(
  doc: IProductAd,
  choice: ProductAdStillChoice,
  format: ProductAdStillFormat
): StillPick | null {
  const productId = choice.productId ?? null;
  const candidates = shownStills(doc).filter(
    item =>
      item.kind === choice.kind &&
      item.format === format &&
      (item.productId ?? null) === productId &&
      usableRef(item.ref)
  );
  const item =
    choice.kind === "studio" && choice.colourway
      ? candidates.find(entry => entry.colourway === choice.colourway)
      : candidates[0];
  if (item)
    return {
      choice: {
        kind: item.kind,
        productId: item.productId ?? null,
        colourway: item.colourway ?? null,
      },
      ref: usableRef(item.ref)!,
    };
  const first = doc.products[0]?.productId ?? null;
  const feed = usableRef(doc.stills?.feed);
  if (
    feed &&
    choice.kind === "room" &&
    format === "feed" &&
    (productId === null || productId === first)
  )
    return { choice: { kind: "room", productId, colourway: null }, ref: feed };
  return null;
}

/** A carousel without slides asked: Collection, then In a room (or Studio) of each product. */
function defaultSlides(doc: IProductAd): StillPick[] {
  const picks: StillPick[] = [];
  const collection = findAdStill(
    doc,
    { kind: "collection", productId: null },
    "feed"
  );
  if (collection) picks.push(collection);
  for (const product of doc.products) {
    const pick =
      findAdStill(
        doc,
        { kind: "room", productId: product.productId },
        "feed"
      ) ??
      findAdStill(
        doc,
        { kind: "studio", productId: product.productId },
        "feed"
      );
    if (pick) picks.push(pick);
  }
  return picks.slice(0, PRODUCT_AD_CAROUSEL_MAX_SLIDES);
}

const stillFormat = (destination: ProductAdPostDestination) =>
  destination === "story" ? "story" : "feed";

const stillIssue = (choice: ProductAdStillChoice, format: string) =>
  `still: the latest video has no ${format} ${choice.kind} picture${
    choice.productId ? ` of ${choice.productId}` : ""
  }`;

/** What a post sends, resolved against the ad; the issues when something isn't there. */
type PostPlan = {
  still: StillPick | null;
  slides: StillPick[];
};

function planPost(
  doc: IProductAd,
  post: {
    destination: ProductAdPostDestination;
    still?: ProductAdStillChoice | null;
    slides?: ProductAdStillChoice[] | null;
  }
): PostPlan | { issues: string[] } {
  const format = stillFormat(post.destination);
  if (post.destination === "carousel") {
    const slides = post.slides
      ? post.slides.map(choice => findAdStill(doc, choice, format))
      : defaultSlides(doc);
    const missing = post.slides
      ? post.slides.filter((_, index) => !slides[index])
      : [];
    if (missing.length)
      return { issues: missing.map(choice => stillIssue(choice, format)) };
    if (slides.length < PRODUCT_AD_CAROUSEL_MIN_SLIDES)
      return {
        issues: [
          `slides: the latest video has fewer than ${PRODUCT_AD_CAROUSEL_MIN_SLIDES} pictures to post`,
        ],
      };
    return { still: null, slides: slides as StillPick[] };
  }
  if (post.still) {
    const still = findAdStill(doc, post.still, format);
    return still
      ? { still, slides: [] }
      : { issues: [stillIssue(post.still, format)] };
  }
  if (!usableRef(doc.render?.video))
    return { issues: ["video: the ad has no video yet"] };
  return { still: null, slides: [] };
}

// ---------------------------------------------------------------------------
// The red tag

/**
 * Whether one of these products has an open doubt about its price (the red
 * tag): Meta actions wait until the owner settles it.
 */
export async function adPriceToCheck(
  workspaceId: string,
  productIds: readonly string[]
): Promise<boolean> {
  const ids = productIds.filter(isAdObjectId);
  if (!ids.length) return false;
  const found = await WorkspaceProduct.exists({
    workspaceId,
    _id: { $in: ids },
    "doubts.about": "price",
  });
  return Boolean(found);
}

// ---------------------------------------------------------------------------
// The queries, shared with their cast test

export const productPostQueries = {
  /** The ad, unless a post has this request id or another post holds the destination. */
  insertFilter: (params: {
    workspaceId: string;
    adId: string;
    requestId: string;
    destination: ProductAdPostDestination;
    staleBefore: Date;
  }) => ({
    _id: params.adId,
    workspaceId: params.workspaceId,
    "meta.posts": {
      $not: {
        $elemMatch: {
          $or: [
            { requestId: params.requestId },
            {
              destination: params.destination,
              state: { $in: [...IN_FLIGHT] },
            },
          ],
        },
      },
    },
  }),
  insertUpdate: (post: ProductAdStoredPost) => ({
    $push: {
      "meta.posts": { $each: [post], $slice: -PRODUCT_AD_POSTS_MAX },
    },
  }),
  /** A post processing since before `staleBefore`, not leased now. */
  staleFilter: (params: {
    workspaceId: string;
    adId: string;
    destination: ProductAdPostDestination;
    staleBefore: Date;
    now: Date;
  }) => ({
    _id: params.adId,
    workspaceId: params.workspaceId,
    "meta.posts": {
      $elemMatch: {
        destination: params.destination,
        state: "processing",
        requestedAt: { $lte: params.staleBefore },
        $or: [{ leaseUntil: null }, { leaseUntil: { $lte: params.now } }],
      },
    },
  }),
  /** The post, in flight and not leased now. */
  leaseFilter: (params: {
    workspaceId: string;
    adId: string;
    postId: string;
    now: Date;
  }) => ({
    _id: params.adId,
    workspaceId: params.workspaceId,
    "meta.posts": {
      $elemMatch: {
        id: params.postId,
        state: { $in: [...IN_FLIGHT] },
        $or: [{ leaseUntil: null }, { leaseUntil: { $lte: params.now } }],
      },
    },
  }),
  /** The post, while this lease holds it. */
  heldFilter: (params: {
    workspaceId: string;
    adId: string;
    postId: string;
    lease: Date;
  }) => ({
    _id: params.adId,
    workspaceId: params.workspaceId,
    "meta.posts": {
      $elemMatch: { id: params.postId, leaseUntil: params.lease },
    },
  }),
  /** Changes to the matched post ($ = the post the filter matched). */
  postUpdate: (changes: Partial<ProductAdStoredPost>) => ({
    $set: Object.fromEntries(
      Object.entries(changes).map(([key, value]) => [
        `meta.posts.$.${key}`,
        value,
      ])
    ),
  }),
};

const findAd = (workspaceId: string, adId: string) =>
  ProductAd.findOne({ _id: adId, workspaceId }).lean<IProductAd | null>();

const postOf = (doc: IProductAd | null, postId: string) =>
  doc?.meta?.posts?.find(post => post.id === postId) ?? null;

// ---------------------------------------------------------------------------
// Pressing Post

export type ProductAdPublishRefusal =
  | { refused: "ad_not_found" }
  | { refused: "ad_not_ready" }
  | { refused: "invalid_request"; issues: string[] }
  | { refused: "price_to_check" }
  | { refused: "instagram_not_connected" }
  | { refused: "instagram_quota" }
  | { refused: "post_busy" };

/** Options tests set: the clock. */
type Clock = { now?: () => number };

/**
 * "Post" (after its confirm): stores the post on the ad and advances it as
 * far as one request goes. A repeated press (same request id) answers its
 * post as it is (`created` false). Refused before anything is stored when
 * the ad isn't ready, the picture isn't in its latest video, a price needs
 * checking, Instagram isn't connected (or can't publish), its daily limit is
 * used up, or another post of the ad is going to the same place.
 */
export async function publishProductAd(
  params: {
    workspaceId: string;
    adId: string;
    request: ProductAdPublishRequest;
  } & Clock
): Promise<
  { post: ProductAdPostRecord; created: boolean } | ProductAdPublishRefusal
> {
  const { workspaceId, adId, request } = params;
  const clock = params.now ?? Date.now;
  const doc = await findAd(workspaceId, adId);
  if (!doc) return { refused: "ad_not_found" };
  const repeat = doc.meta?.posts?.find(
    post => post.requestId === request.requestId
  );
  if (repeat) return { post: toAdPostRecord(repeat), created: false };
  if (doc.status !== "ready" || !doc.render) return { refused: "ad_not_ready" };

  const plan = planPost(doc, request);
  if ("issues" in plan)
    return { refused: "invalid_request", issues: plan.issues };
  const caption =
    request.destination === "story"
      ? ""
      : (request.caption ??
        cut(
          adPostText({ ...doc, wordsCode: doc.wordsCode ?? null }) ?? "",
          PRODUCT_AD_CAPTION_MAX
        ));
  const issues = captionIssues(caption);
  if (issues.length) return { refused: "invalid_request", issues };

  if (
    await adPriceToCheck(
      workspaceId,
      doc.products.map(product => product.productId)
    )
  )
    return { refused: "price_to_check" };
  const account = await loadInstagramPublishAccount(workspaceId);
  if (!account?.canPublish) return { refused: "instagram_not_connected" };
  const quota = await publishingQuota(account.access, account.accountIds[0], {
    timeoutMs: 3_000,
  });
  if (quota && quota.used >= quota.total) return { refused: "instagram_quota" };

  const now = new Date(clock());
  const staleBefore = new Date(now.getTime() - PRODUCT_POST_STALE_MS);
  if (doc.meta === null)
    await ProductAd.updateOne(
      { _id: adId, workspaceId, meta: null },
      { $unset: { meta: "" } }
    );
  // A post left processing long ago was never published: it gives way.
  await ProductAd.updateOne(
    productPostQueries.staleFilter({
      workspaceId,
      adId,
      destination: request.destination,
      staleBefore,
      now,
    }),
    productPostQueries.postUpdate({
      state: "failed",
      errorCode: "post_failed",
      errorMessage: "Instagram didn't finish processing it in time.",
      leaseUntil: null,
    })
  );

  const video =
    request.destination === "reel" ||
    (request.destination === "story" && !plan.still);
  const post: ProductAdStoredPost = {
    id: new mongoose.Types.ObjectId().toHexString(),
    requestId: request.requestId,
    destination: request.destination,
    still: plan.still?.choice ?? null,
    slides: plan.slides.map(slide => slide.choice),
    renderNo: doc.render.renderNo,
    motion: video ? productAdMotionOf(doc.motion) : null,
    caption,
    state: "processing",
    containerId: null,
    childIds: [],
    mediaId: null,
    permalink: null,
    errorCode: null,
    errorMessage: null,
    requestedAt: now,
    publishedAt: null,
    leaseUntil: null,
  };
  const pushed = await ProductAd.updateOne(
    productPostQueries.insertFilter({
      workspaceId,
      adId,
      requestId: request.requestId,
      destination: request.destination,
      staleBefore,
    }),
    productPostQueries.insertUpdate(post)
  );
  if (pushed.matchedCount === 0) {
    const current = await findAd(workspaceId, adId);
    if (!current) return { refused: "ad_not_found" };
    const same = current.meta?.posts?.find(
      entry => entry.requestId === request.requestId
    );
    return same
      ? { post: toAdPostRecord(same), created: false }
      : { refused: "post_busy" };
  }
  logger.info("[Products] ad post stored", {
    event: "products.ad_post_stored",
    workspaceId,
    adId,
    postId: post.id,
    destination: post.destination,
  });
  const advanced = await advanceProductAdPost({
    workspaceId,
    adId,
    postId: post.id,
    account,
    // The checks above took their share of the request's 10 s.
    budgetMs: PRODUCT_POST_PRESS_ADVANCE_MS,
    now: clock,
  });
  return {
    post: "post" in advanced ? advanced.post : toAdPostRecord(post),
    created: true,
  };
}

// ---------------------------------------------------------------------------
// Advancing a post

/** The lease was lost (it ran out, or another request took the post). */
class LeaseLost extends Error {}

type Failure = { code: ProductsMetaFailureCode; message: string };

/** Meta's reason for a refused post, in plain English. */
function postFailure(error: unknown): Failure {
  if (isGraphQuotaError(error))
    return {
      code: "instagram_quota",
      message: "Instagram's daily posting limit is reached.",
    };
  if (isGraphTokenError(error))
    return {
      code: "instagram_not_connected",
      message:
        "Instagram's sign-in has expired. Reconnect Instagram in Integrations.",
    };
  if (isGraphIdUnavailableError(error))
    return {
      code: "instagram_not_connected",
      message:
        "The connected Instagram account can't be posted to. Reconnect Instagram in Integrations.",
    };
  if (error instanceof GraphApiError && isGraphPermissionError(error))
    return {
      code: "instagram_not_connected",
      message:
        "Instagram didn't allow posting from this connection. Reconnect Instagram in Integrations.",
    };
  return { code: "post_failed", message: graphReason(error) };
}

/** Instagram's error codes that come back inside a container's status, in plain English. */
const STATUS_REASONS: Array<[RegExp, string]> = [
  [/2207026/, "Instagram couldn't use the video's format."],
  [/2207004|2207005/, "Instagram couldn't use the picture's size or format."],
  [/2207003|2207020|2207052/, "Instagram couldn't download the media in time."],
  [/2207006|2207008/, "Instagram couldn't find the media to post."],
];

function graphReason(error: unknown): string {
  if (error instanceof GraphApiError) {
    const subcode = String(error.graphSubcode ?? "");
    const known = STATUS_REASONS.find(([pattern]) => pattern.test(subcode));
    if (known) return known[1];
    return cut(error.userMessage ?? error.message, 480);
  }
  return "Instagram didn't answer.";
}

function statusReason(message: string | null): string {
  const known = message
    ? STATUS_REASONS.find(([pattern]) => pattern.test(message))
    : undefined;
  if (known) return known[1];
  return message
    ? cut(
        `Instagram couldn't process it: ${message.replace(/^error:\s*/i, "")}`,
        480
      )
    : "Instagram couldn't process it.";
}

/** The containers a post makes, with links signed now (Instagram downloads them later). */
async function signedMedia(
  workspaceId: string,
  doc: IProductAd,
  post: ProductAdStoredPost
): Promise<
  | { kind: "single"; container: InstagramContainer }
  | { kind: "carousel"; imageUrls: string[] }
  | null
> {
  ensureMediaApiCreativeAssetReadUrlPort();
  const sign = (ref: StoredFileRef | null) =>
    ref ? productPhotoUrl(workspaceId, ref) : Promise.resolve(null);
  const plan = planPost(doc, post);
  if ("issues" in plan) return null;
  const caption = post.caption ?? "";
  if (post.destination === "carousel") {
    const urls = await Promise.all(plan.slides.map(slide => sign(slide.ref)));
    return urls.every(Boolean)
      ? { kind: "carousel", imageUrls: urls as string[] }
      : null;
  }
  if (plan.still) {
    const imageUrl = await sign(plan.still.ref);
    if (!imageUrl) return null;
    return {
      kind: "single",
      container:
        post.destination === "story"
          ? { kind: "story", imageUrl }
          : { kind: "image", imageUrl, caption },
    };
  }
  const [videoUrl, coverUrl] = await Promise.all([
    sign(usableRef(doc.render?.video)),
    post.destination === "reel"
      ? sign(usableRef(doc.render?.poster))
      : Promise.resolve(null),
  ]);
  if (!videoUrl) return null;
  return {
    kind: "single",
    container:
      post.destination === "story"
        ? { kind: "story", videoUrl }
        : { kind: "reel", videoUrl, caption, coverUrl, shareToFeed: true },
  };
}

/** Whether a newest media is the kind this post publishes. */
function mediaFits(
  media: InstagramRecentMedia,
  destination: ProductAdPostDestination
): boolean {
  if (destination === "story") return true;
  if (destination === "reel")
    return media.productType === null || media.productType === "REELS";
  if (destination === "carousel")
    return media.mediaType === null || media.mediaType === "CAROUSEL_ALBUM";
  return media.mediaType === null || media.mediaType === "IMAGE";
}

/**
 * Advances one post as far as one request goes. Answers the post as it is
 * then; refuses when the ad or the post isn't there. A post another request
 * holds, or that is done, is answered as it is.
 */
export async function advanceProductAdPost(
  params: {
    workspaceId: string;
    adId: string;
    postId: string;
    /** The Instagram account, when the caller has just read it. */
    account?: InstagramPublishAccount | null;
    /** How long this request may advance it; PRODUCT_POST_ADVANCE_MS when absent. */
    budgetMs?: number;
  } & Clock
): Promise<
  | { post: ProductAdPostRecord }
  | { refused: "ad_not_found" }
  | { refused: "post_not_found" }
> {
  const { workspaceId, adId, postId } = params;
  const clock = params.now ?? Date.now;
  const startedAt = clock();
  const lease = new Date(startedAt + PRODUCT_POST_LEASE_MS);
  const leased = await ProductAd.findOneAndUpdate(
    productPostQueries.leaseFilter({
      workspaceId,
      adId,
      postId,
      now: new Date(startedAt),
    }),
    productPostQueries.postUpdate({ leaseUntil: lease }),
    { new: true }
  ).lean<IProductAd | null>();
  const leasedPost = postOf(leased, postId);
  if (leased && leasedPost) {
    try {
      await advanceLeased({
        workspaceId,
        adId,
        doc: leased,
        post: leasedPost,
        lease,
        account: params.account,
        deadline: startedAt + (params.budgetMs ?? PRODUCT_POST_ADVANCE_MS),
        clock,
      });
    } catch (error) {
      if (!(error instanceof LeaseLost))
        logger.error("[Products] ad post advance failed", error, {
          event: "products.ad_post_advance_failed",
          workspaceId,
          adId,
          postId,
        });
    } finally {
      // Let the next poll go on at once (matches only while this lease holds).
      await ProductAd.updateOne(
        productPostQueries.heldFilter({ workspaceId, adId, postId, lease }),
        productPostQueries.postUpdate({ leaseUntil: null })
      ).catch(() => undefined);
    }
  }
  const current = await findAd(workspaceId, adId);
  if (!current) return { refused: "ad_not_found" };
  const post = postOf(current, postId);
  return post ? { post: toAdPostRecord(post) } : { refused: "post_not_found" };
}

async function advanceLeased(ctx: {
  workspaceId: string;
  adId: string;
  doc: IProductAd;
  post: ProductAdStoredPost;
  lease: Date;
  account?: InstagramPublishAccount | null;
  deadline: number;
  clock: () => number;
}): Promise<void> {
  const { workspaceId, adId, doc, lease, clock } = ctx;
  let post = ctx.post;
  const held = productPostQueries.heldFilter({
    workspaceId,
    adId,
    postId: post.id,
    lease,
  });
  const save = async (changes: Partial<ProductAdStoredPost>) => {
    const result = await ProductAd.updateOne(
      held,
      productPostQueries.postUpdate(changes)
    );
    if (result.matchedCount === 0) throw new LeaseLost();
    post = { ...post, ...changes };
  };
  const fail = (failure: Failure) =>
    save({
      state: "failed",
      errorCode: failure.code,
      errorMessage: cut(failure.message, 500),
      leaseUntil: null,
    });
  /** The time one Graph call may take now; null when too little is left. */
  const callTime = () => {
    const left = ctx.deadline - clock();
    return left < GRAPH_CALL_MIN_MS
      ? null
      : { timeoutMs: Math.min(GRAPH_CALL_MAX_MS, left) };
  };
  /** A refusal lands on the post; Meta's own trouble waits for the next poll. */
  const refused = async (error: unknown) => {
    // Once media_publish was dispatched, a failed read/reconnection does
    // not prove that nothing was posted. Keep reconciling the same post.
    if (post.state === "publishing") return;
    if (!isGraphQuotaError(error) && isGraphTransientError(error)) return;
    await fail(postFailure(error));
  };

  const account =
    ctx.account ?? (await loadInstagramPublishAccount(workspaceId));
  if (!account?.canPublish) {
    if (post.state === "publishing") return;
    await fail({
      code: "instagram_not_connected",
      message:
        "Instagram isn't connected any more. Reconnect it in Integrations.",
    });
    return;
  }
  const { access, accountIds } = account;

  // 1. The container(s), made once, with links signed now.
  if (post.state === "processing" && !post.containerId) {
    if (doc.render?.renderNo !== post.renderNo) {
      await fail({
        code: "post_failed",
        message: "The ad changed before Instagram got it. Post it again.",
      });
      return;
    }
    const media = await signedMedia(workspaceId, doc, post);
    if (!media) {
      await fail({
        code: "post_failed",
        message: "The video or picture couldn't be prepared for Instagram.",
      });
      return;
    }
    try {
      if (media.kind === "carousel") {
        const childIds = [...(post.childIds ?? [])];
        for (const imageUrl of media.imageUrls.slice(childIds.length)) {
          const time = callTime();
          if (!time) return;
          const { containerId } = await createContainerForAccount(
            access,
            accountIds,
            { kind: "carousel_item", imageUrl },
            time
          );
          childIds.push(containerId);
          await save({ childIds: [...childIds] });
        }
        const time = callTime();
        if (!time) return;
        const { containerId } = await createContainerForAccount(
          access,
          accountIds,
          { kind: "carousel", children: childIds, caption: post.caption ?? "" },
          time
        );
        await save({ containerId });
      } else {
        const time = callTime();
        if (!time) return;
        const { containerId } = await createContainerForAccount(
          access,
          accountIds,
          media.container,
          time
        );
        await save({ containerId });
      }
    } catch (error) {
      if (error instanceof LeaseLost) throw error;
      // A carousel's items still processing at Instagram: the next poll
      // makes the carousel from the items kept.
      if (media.kind === "carousel" && isGraphMediaNotReadyError(error)) return;
      await refused(error);
      return;
    }
  }
  const containerId = post.containerId;
  if (!containerId) return;

  // A media_publish that answered, but its permalink wasn't read (no time
  // left, or Graph didn't give it): read it once more, then settle either
  // way. Out on Meta and the receipt link the post by it.
  if (post.state === "publishing" && post.mediaId) {
    const time = callTime();
    if (!time) return;
    const permalink = await permalinkOf(access, post.mediaId, time);
    await save({
      state: "published",
      permalink,
      publishedAt: post.publishedAt ?? new Date(clock()),
      errorCode: null,
      errorMessage: null,
      leaseUntil: null,
    });
    return;
  }

  // 2. Where Instagram is with it.
  const statusTime = callTime();
  if (!statusTime) return;
  let status: { code: string; message: string | null };
  try {
    status = await containerStatus(access, containerId, statusTime);
  } catch (error) {
    await refused(error);
    return;
  }
  if (status.code === "ERROR" || status.code === "FAILED") {
    await fail({ code: "post_failed", message: statusReason(status.message) });
    return;
  }
  if (status.code === "EXPIRED") {
    await fail({
      code: "post_failed",
      message: "Instagram's upload expired before it was posted.",
    });
    return;
  }

  // 3. A media_publish whose answer was lost: find what it published before asking again.
  if (status.code === "PUBLISHED" || post.state === "publishing") {
    const time = callTime();
    if (!time) return;
    const found = await recentMedia(
      access,
      accountIds[0],
      post.destination === "story" ? "stories" : "media",
      time
    ).catch(() => null);
    // Without the newest media it can't be told: never publish again blind.
    if (found === null && status.code !== "PUBLISHED") return;
    const since = new Date(post.requestedAt).getTime() - MEDIA_MATCH_SKEW_MS;
    // Media this ad's other posts already are can't be this one.
    const taken = new Set(
      (doc.meta?.posts ?? []).flatMap(entry =>
        entry.id !== post.id && entry.mediaId ? [entry.mediaId] : []
      )
    );
    const match = found?.find(
      media =>
        !taken.has(media.id) &&
        media.publishedAt !== null &&
        media.publishedAt.getTime() >= since &&
        mediaFits(media, post.destination)
    );
    if (match || status.code === "PUBLISHED") {
      await save({
        state: "published",
        mediaId: match?.id ?? null,
        permalink: match?.permalink ?? null,
        publishedAt: match?.publishedAt ?? new Date(clock()),
        errorCode: null,
        errorMessage: null,
        leaseUntil: null,
      });
      return;
    }
  }
  if (status.code !== "FINISHED") return;

  // 4. Publish: marked first, so a lost answer is never published twice.
  const publishTime = callTime();
  if (!publishTime) return;
  const wasPublishing = post.state === "publishing";
  await save({ state: "publishing" });
  let mediaId = "";
  try {
    ({ mediaId } = await publishContainerForAccount(
      access,
      accountIds,
      containerId,
      publishTime
    ));
  } catch (error) {
    if (isGraphMediaNotReadyError(error)) {
      // Instagram took nothing: back to waiting for the container.
      // A prior dispatch may still have published, though; don't make an
      // ambiguous post eligible for stale processing replacement.
      if (!wasPublishing) await save({ state: "processing" });
      return;
    }
    if (!isGraphQuotaError(error) && isGraphTransientError(error)) return;
    // Refused because an earlier ask did publish it: the next poll finds it.
    const after = await containerStatus(access, containerId, {
      timeoutMs: GRAPH_CALL_MIN_MS * 2,
    }).catch(() => null);
    if (!after || after.code === "PUBLISHED" || wasPublishing) return;
    await fail(postFailure(error));
    return;
  }
  if (!mediaId) return;
  const permalinkTime = callTime();
  const permalink = permalinkTime
    ? await permalinkOf(access, mediaId, permalinkTime)
    : null;
  if (!permalink) {
    // It's live; the next poll reads the permalink (above) and settles it.
    await save({ mediaId, publishedAt: new Date(clock()) });
    logger.info("[Products] ad post published, permalink pending", {
      event: "products.ad_post_published",
      workspaceId,
      adId,
      postId: post.id,
      destination: post.destination,
    });
    return;
  }
  await save({
    state: "published",
    mediaId,
    permalink,
    publishedAt: new Date(clock()),
    errorCode: null,
    errorMessage: null,
    leaseUntil: null,
  });
  logger.info("[Products] ad post published", {
    event: "products.ad_post_published",
    workspaceId,
    adId,
    postId: post.id,
    destination: post.destination,
  });
}

// ---------------------------------------------------------------------------
// Readiness: GET /products/meta

/** Readiness is cached this long per workspace (in this server's memory). */
export const PRODUCTS_META_READINESS_TTL_MS = 60_000;
/**
 * While something isn't ready (Instagram can't publish, Meta Ads isn't
 * connected, the Page has no WhatsApp linked), a shorter while: the owner is
 * likely fixing it in another tab and comes back to check.
 */
export const PRODUCTS_META_NOT_READY_TTL_MS = 15_000;
const READINESS_CALL_MS = 4_000;

const readinessCache = new Map<
  string,
  { expiresAt: number; value: ProductsMetaReadiness }
>();

/** Test-only: forget every cached readiness. */
export function resetProductsMetaReadinessCache(): void {
  readinessCache.clear();
}

/** `work`, or `fallback` when it fails or takes longer than `ms`. */
function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>(resolve => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([work.catch(() => fallback), late]).finally(() =>
    clearTimeout(timer)
  );
}

function adsNotRead(): ProductsCtwaReadiness {
  const caps = productsCtwaRunCaps();
  return {
    connected: false,
    adAccountName: null,
    currency: null,
    pageName: null,
    pageHasWhatsApp: null,
    instagramPlacements: false,
    runEnabled: caps.enabled,
    runMaxDailyCents: caps.maxDailyCents,
    runMaxDays: caps.maxDays,
  };
}

async function instagramReadiness(
  workspaceId: string
): Promise<ProductsMetaReadiness["instagram"]> {
  const account = await loadInstagramPublishAccount(workspaceId);
  if (!account?.connected)
    return {
      connected: false,
      username: null,
      canPublish: false,
      quotaLeft: null,
    };
  const quota = account.canPublish
    ? await publishingQuota(account.access, account.accountIds[0], {
        timeoutMs: READINESS_CALL_MS,
      })
    : null;
  return {
    connected: true,
    username: account.username,
    canPublish: account.canPublish,
    quotaLeft: quota ? Math.max(0, quota.total - quota.used) : null,
  };
}

/**
 * What the workspace can do on Meta now: Instagram (connected, the @name,
 * whether it can publish, posts left today), Meta Ads (P2's ctwaReadiness),
 * the WhatsApp number, and what stops a make's AI action. Booleans, names
 * and counts only. Cached 60 s per workspace; `fresh` reads again ("Check
 * again"). Never throws: what can't be read is false or null.
 */
export async function productsMetaReadiness(
  workspaceId: string,
  options: { fresh?: boolean } & Clock = {}
): Promise<ProductsMetaReadiness> {
  const clock = options.now ?? Date.now;
  const cached = readinessCache.get(workspaceId);
  if (!options.fresh && cached && cached.expiresAt > clock())
    return cached.value;
  const [instagram, ads, whatsapp, blocked] = await Promise.all([
    within(instagramReadiness(workspaceId), READINESS_CALL_MS + 1_000, {
      connected: false,
      username: null,
      canPublish: false,
      quotaLeft: null,
    }),
    within(ctwaReadiness(workspaceId), READINESS_CALL_MS + 1_000, adsNotRead()),
    within(
      productsWhatsAppConnection(workspaceId).then(connection => ({
        connected: connection.connected,
      })),
      READINESS_CALL_MS,
      { connected: false }
    ),
    within(adAdmissionStop(workspaceId), READINESS_CALL_MS, null),
  ]);
  const value: ProductsMetaReadiness = {
    instagram,
    ads,
    whatsapp,
    ai: { blocked },
  };
  const ready =
    instagram.canPublish && ads.connected && ads.pageHasWhatsApp === true;
  readinessCache.set(workspaceId, {
    expiresAt:
      clock() +
      (ready ? PRODUCTS_META_READINESS_TTL_MS : PRODUCTS_META_NOT_READY_TTL_MS),
    value,
  });
  return value;
}

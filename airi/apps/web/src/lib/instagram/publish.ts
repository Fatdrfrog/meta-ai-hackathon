import "server-only";
import { decryptMaybeString } from "@/lib/crypto";
import { fetchSourceWithCredentials } from "@/lib/sources/utils";
import { resolveInstagramGraphBase } from "@icecore/shared/lib/meta/graph-version";
import {
  readTrimmedString as normalizeIdentifier,
  readUniqueStringArray,
} from "@icecore/shared/lib/value-utils";

// Publishing to Instagram through the Graph API: the connected account and
// its token, media containers (a picture, a Reel, a Story, a carousel and its
// items), their status, media_publish and the permalink. Shared by
// /api/sources/instagram/publish and the Products studio's posts. Tokens go
// only to Meta: never into a log, an error message or an answer.

type GraphErrorPayload = {
  error?: {
    message?: string;
    type?: string;
    code?: number | string;
    error_subcode?: number | string;
    error_user_msg?: string;
    fbtrace_id?: string;
  };
};

/** A refusal from the Graph API, with Meta's codes. */
export class GraphApiError extends Error {
  status: number;
  graphCode?: number;
  graphType?: string;
  graphSubcode?: number;
  graphTraceId?: string;
  /** Meta's message meant for the person (error_user_msg), when it gave one. */
  userMessage?: string;

  constructor(
    status: number,
    message: string,
    options?: {
      graphCode?: number;
      graphType?: string;
      graphSubcode?: number;
      graphTraceId?: string;
      userMessage?: string;
    }
  ) {
    super(message);
    this.name = "GraphApiError";
    this.status = status;
    this.graphCode = options?.graphCode;
    this.graphType = options?.graphType;
    this.graphSubcode = options?.graphSubcode;
    this.graphTraceId = options?.graphTraceId;
    this.userMessage = options?.userMessage;
  }
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

const trimmedOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export function toGraphApiError(
  status: number,
  json: Record<string, unknown>,
  fallbackMessage: string
): GraphApiError {
  const payload = json as GraphErrorPayload;
  const graphError = payload.error || {};
  const message =
    typeof graphError.message === "string" && graphError.message.trim()
      ? graphError.message.trim()
      : fallbackMessage;

  return new GraphApiError(status, message, {
    graphCode: toOptionalNumber(graphError.code),
    graphType:
      typeof graphError.type === "string" ? graphError.type.trim() : undefined,
    graphSubcode: toOptionalNumber(graphError.error_subcode),
    graphTraceId:
      typeof graphError.fbtrace_id === "string"
        ? graphError.fbtrace_id.trim()
        : undefined,
    userMessage: trimmedOrUndefined(graphError.error_user_msg),
  });
}

export function isGraphPermissionError(error: GraphApiError): boolean {
  const message = error.message.toLowerCase();
  return (
    error.graphCode === 10 ||
    error.graphCode === 200 ||
    message.includes("permission") ||
    message.includes("not authorized")
  );
}

export function isGraphIdUnavailableError(error: unknown): boolean {
  if (!(error instanceof GraphApiError)) return false;
  if (![400, 403, 404].includes(error.status)) return false;

  const message = error.message.toLowerCase();
  return (
    message.includes("unsupported post request") ||
    message.includes("object with id") ||
    message.includes("does not exist") ||
    message.includes("invalid user id") ||
    message.includes("cannot be loaded due to missing permissions")
  );
}

export function isGraphMediaIdNotAvailableError(error: unknown): boolean {
  if (!(error instanceof GraphApiError)) return false;
  const message = error.message.toLowerCase();
  return message.includes("media id") && message.includes("not available");
}

/** The token is invalid or expired (code 190): the account must be reconnected. */
export const isGraphTokenError = (error: unknown): boolean =>
  error instanceof GraphApiError && error.graphCode === 190;

/**
 * Instagram's 24-hour publishing limit is used up (code 9, subcode 2207042,
 * or its message).
 */
export function isGraphQuotaError(error: unknown): boolean {
  if (!(error instanceof GraphApiError)) return false;
  if (error.graphSubcode === 2207042) return true;
  const message = error.message.toLowerCase();
  return (
    error.graphCode === 9 &&
    (message.includes("maximum number of") || message.includes("limit"))
  );
}

/**
 * The media isn't ready to publish yet (code 9007, subcodes 2207027 and
 * 2207055, or "Media ID is not available"): asking again later can work.
 */
export function isGraphMediaNotReadyError(error: unknown): boolean {
  if (!(error instanceof GraphApiError)) return false;
  return (
    error.graphCode === 9007 ||
    error.graphSubcode === 2207027 ||
    error.graphSubcode === 2207055 ||
    isGraphMediaIdNotAvailableError(error)
  );
}

/**
 * Whether asking again later can succeed: Meta's own trouble (5xx, codes 1
 * and 2), rate limits (4, 17, 32, 613), or no answer at all (a network error
 * or a timeout, which isn't a GraphApiError).
 */
export function isGraphTransientError(error: unknown): boolean {
  if (!(error instanceof GraphApiError)) return true;
  if (error.status >= 500) return true;
  return [1, 2, 4, 17, 32, 613].includes(error.graphCode ?? -1);
}

/**
 * The permissions a connection was granted. Instagram Login stores them as
 * Meta's comma-separated string, other paths as a JSON array (or its text);
 * both read here, lower-cased. Empty when unknown.
 */
export function grantedPermissions(raw: unknown): Set<string> {
  let values: unknown[] = [];
  if (Array.isArray(raw)) {
    values = raw;
  } else if (typeof raw === "string") {
    const text = raw.trim();
    if (text.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(text);
        values = Array.isArray(parsed) ? parsed : [];
      } catch {
        values = [];
      }
    } else {
      values = text.split(/[,\s]+/);
    }
  }
  return new Set(
    values
      .filter((value): value is string => typeof value === "string")
      .map(value => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** The permission publishing needs, by how the account was connected. */
export function resolvePublishPermission(authMethod: string): string {
  return authMethod === "instagram_business_login"
    ? "instagram_business_content_publish"
    : "instagram_content_publish";
}

/** The account ids media may be published to, the most likely first. */
export function resolveInstagramAccountIdCandidates(
  credentials: Record<string, unknown>
): string[] {
  const businessId = normalizeIdentifier(
    credentials.instagram_business_account_id
  );
  const scopedId = normalizeIdentifier(credentials.instagram_scoped_id);
  const pageId = normalizeIdentifier(credentials.page_id);
  return readUniqueStringArray([businessId, scopedId, pageId]);
}

/** graph.instagram.com for Instagram Login, graph.facebook.com for Facebook Login. */
export function resolveGraphApiBase(authMethod: string): string {
  return resolveInstagramGraphBase(authMethod);
}

/** How long one Graph call may take; no limit when absent. */
export type GraphCallOptions = { timeoutMs?: number };

const callSignal = (options?: GraphCallOptions) =>
  options?.timeoutMs !== undefined
    ? AbortSignal.timeout(Math.max(1, Math.floor(options.timeoutMs)))
    : undefined;

async function graphAnswer(
  response: Response
): Promise<Record<string, unknown>> {
  const json = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw toGraphApiError(
      response.status,
      json,
      `Graph API request failed (${response.status})`
    );
  }
  return json;
}

export async function graphPost(
  url: string,
  body: URLSearchParams,
  options?: GraphCallOptions
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    cache: "no-store",
    signal: callSignal(options),
  });
  return graphAnswer(response);
}

export async function graphGet(
  url: string,
  options?: GraphCallOptions
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
    signal: callSignal(options),
  });
  return graphAnswer(response);
}

/** A connected account's Graph base and token. */
export type InstagramAccess = { graphBase: string; accessToken: string };

/**
 * A media container to create:
 * - image: a feed picture (JPEG);
 * - reel: a video Reel, shared to the feed, with an optional cover;
 * - story: a picture or a video Story (Stories take no caption);
 * - carousel_item: one picture of a carousel;
 * - carousel: the carousel itself, from its items' container ids, in order.
 */
export type InstagramContainer =
  | { kind: "image"; imageUrl: string; caption?: string }
  | {
      kind: "reel";
      videoUrl: string;
      caption?: string;
      coverUrl?: string | null;
      shareToFeed?: boolean;
    }
  | { kind: "story"; imageUrl: string }
  | { kind: "story"; videoUrl: string }
  | { kind: "carousel_item"; imageUrl: string }
  | { kind: "carousel"; children: string[]; caption?: string };

/** The parameters that create `container`, without the token. */
export function containerParams(
  container: InstagramContainer
): URLSearchParams {
  const params = new URLSearchParams();
  switch (container.kind) {
    case "image":
      if (container.caption !== undefined)
        params.set("caption", container.caption);
      params.set("image_url", container.imageUrl);
      break;
    case "reel":
      if (container.caption !== undefined)
        params.set("caption", container.caption);
      params.set("media_type", "REELS");
      params.set("video_url", container.videoUrl);
      params.set(
        "share_to_feed",
        container.shareToFeed === false ? "false" : "true"
      );
      if (container.coverUrl) params.set("cover_url", container.coverUrl);
      break;
    case "story":
      params.set("media_type", "STORIES");
      if ("videoUrl" in container) params.set("video_url", container.videoUrl);
      else params.set("image_url", container.imageUrl);
      break;
    case "carousel_item":
      params.set("image_url", container.imageUrl);
      params.set("is_carousel_item", "true");
      break;
    case "carousel":
      if (container.caption !== undefined)
        params.set("caption", container.caption);
      params.set("media_type", "CAROUSEL");
      params.set("children", container.children.join(","));
      break;
  }
  return params;
}

/** Creates `container` on the account; its container id. */
export async function createContainer(
  access: InstagramAccess,
  accountId: string,
  container: InstagramContainer,
  options?: GraphCallOptions
): Promise<string> {
  const body = new URLSearchParams();
  body.set("access_token", access.accessToken);
  for (const [key, value] of containerParams(container)) body.set(key, value);
  const response = await graphPost(
    `${access.graphBase}/${encodeURIComponent(accountId)}/media`,
    body,
    options
  );
  const id = String(response.id || "");
  if (!id) throw new Error("Failed to create Instagram media container");
  return id;
}

/**
 * Creates `container` on the first of the account ids that takes it,
 * skipping ids Meta says aren't available: the account id it used and the
 * container id. Throws the last refusal when none does.
 */
export async function createContainerForAccount(
  access: InstagramAccess,
  accountIds: readonly string[],
  container: InstagramContainer,
  options?: GraphCallOptions
): Promise<{ accountId: string; containerId: string }> {
  let lastError: unknown = null;
  for (const accountId of accountIds) {
    try {
      const containerId = await createContainer(
        access,
        accountId,
        container,
        options
      );
      return { accountId, containerId };
    } catch (error) {
      lastError = error;
      if (isGraphIdUnavailableError(error)) continue;
      throw error;
    }
  }
  throw lastError ?? new Error("Instagram account ID is missing");
}

/**
 * Where a container is: status_code (IN_PROGRESS, FINISHED, PUBLISHED,
 * ERROR, EXPIRED), upper-cased, and Meta's status text (an ERROR's reason).
 */
export type InstagramContainerStatus = { code: string; message: string | null };

export async function containerStatus(
  access: InstagramAccess,
  containerId: string,
  options?: GraphCallOptions
): Promise<InstagramContainerStatus> {
  const url = new URL(`${access.graphBase}/${encodeURIComponent(containerId)}`);
  url.searchParams.set("fields", "status_code,status");
  url.searchParams.set("access_token", access.accessToken);
  const json = await graphGet(url.toString(), options);
  return {
    code: String(json.status_code || json.status || "").toUpperCase(),
    message: trimmedOrUndefined(json.status) ?? null,
  };
}

/**
 * Waits for a video container to finish processing, asking every `delayMs`
 * up to `maxAttempts` times (about 2 minutes by default). Throws when
 * Instagram fails it, or when it is still processing at the end.
 */
export async function waitForContainerReady(
  access: InstagramAccess,
  containerId: string,
  options: { maxAttempts?: number; delayMs?: number } = {}
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 48;
  const delayMs = options.delayMs ?? 2500;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { code } = await containerStatus(access, containerId);

    if (code === "FINISHED" || code === "PUBLISHED") {
      return;
    }

    if (code === "ERROR" || code === "FAILED" || code === "EXPIRED") {
      throw new Error(`Instagram video processing failed with status: ${code}`);
    }

    if (attempt < maxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(
    "Instagram video or Reel is still processing. Try again in 1-2 minutes; some videos take longer to process."
  );
}

/**
 * Publishes a finished container: the published media's id ("" when Meta
 * answered without one) and Meta's whole answer.
 */
export async function publishContainer(
  access: InstagramAccess,
  accountId: string,
  containerId: string,
  options?: GraphCallOptions
): Promise<{ mediaId: string; response: Record<string, unknown> }> {
  const body = new URLSearchParams();
  body.set("access_token", access.accessToken);
  body.set("creation_id", containerId);
  const response = await graphPost(
    `${access.graphBase}/${encodeURIComponent(accountId)}/media_publish`,
    body,
    options
  );
  return { mediaId: String(response.id || ""), response };
}

/**
 * Publishes a finished container from the first of the account ids that
 * takes it, skipping ids Meta says aren't available (the container was
 * made on one of them). Throws the last refusal when none does.
 */
export async function publishContainerForAccount(
  access: InstagramAccess,
  accountIds: readonly string[],
  containerId: string,
  options?: GraphCallOptions
): Promise<{ accountId: string; mediaId: string }> {
  let lastError: unknown = null;
  for (const accountId of accountIds) {
    try {
      const { mediaId } = await publishContainer(
        access,
        accountId,
        containerId,
        options
      );
      return { accountId, mediaId };
    } catch (error) {
      lastError = error;
      if (isGraphIdUnavailableError(error)) continue;
      throw error;
    }
  }
  throw lastError ?? new Error("Instagram account ID is missing");
}

/** A published media's permalink; null when Meta doesn't give one. Never throws. */
export async function permalinkOf(
  access: InstagramAccess,
  mediaId: string,
  options?: GraphCallOptions
): Promise<string | null> {
  try {
    const url = new URL(`${access.graphBase}/${encodeURIComponent(mediaId)}`);
    url.searchParams.set("fields", "id,permalink,media_type");
    url.searchParams.set("access_token", access.accessToken);
    const json = await graphGet(url.toString(), options);
    return trimmedOrUndefined(json.permalink) ?? null;
  } catch {
    return null;
  }
}

/**
 * Instagram's 24-hour publishing limit: posts used and allowed (100 today).
 * Null when it can't be read. Never throws.
 */
export async function publishingQuota(
  access: InstagramAccess,
  accountId: string,
  options?: GraphCallOptions
): Promise<{ used: number; total: number } | null> {
  try {
    const url = new URL(
      `${access.graphBase}/${encodeURIComponent(accountId)}/content_publishing_limit`
    );
    url.searchParams.set("fields", "quota_usage,config");
    url.searchParams.set("access_token", access.accessToken);
    const json = await graphGet(url.toString(), options);
    const entry = Array.isArray(json.data)
      ? (json.data[0] as Record<string, unknown> | undefined)
      : undefined;
    const used = toOptionalNumber(entry?.quota_usage);
    const config = entry?.config as Record<string, unknown> | undefined;
    const total = toOptionalNumber(config?.quota_total);
    if (used === undefined || total === undefined) return null;
    return { used: Math.max(0, used), total: Math.max(0, total) };
  } catch {
    return null;
  }
}

/** One of the account's newest media, as a lost media_publish answer is looked up by. */
export type InstagramRecentMedia = {
  id: string;
  /** When Instagram published it; null when it can't be read. */
  publishedAt: Date | null;
  permalink: string | null;
  /** IMAGE, VIDEO or CAROUSEL_ALBUM; null when unknown. */
  mediaType: string | null;
  /** FEED, REELS or STORY; null when unknown. */
  productType: string | null;
};

const graphTime = (value: unknown): Date | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  // Graph writes "2026-11-04T05:50:12+0000"; ISO wants "+00:00".
  const iso = value.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time) : null;
};

/**
 * The account's newest media (`edge` "media": posts, Reels and carousels)
 * or its live Stories (`edge` "stories"), newest first, at most `limit`.
 */
export async function recentMedia(
  access: InstagramAccess,
  accountId: string,
  edge: "media" | "stories",
  options?: GraphCallOptions & { limit?: number }
): Promise<InstagramRecentMedia[]> {
  const url = new URL(
    `${access.graphBase}/${encodeURIComponent(accountId)}/${edge}`
  );
  url.searchParams.set(
    "fields",
    "id,timestamp,permalink,media_type,media_product_type"
  );
  url.searchParams.set("limit", String(options?.limit ?? 5));
  url.searchParams.set("access_token", access.accessToken);
  const json = await graphGet(url.toString(), options);
  const rows = Array.isArray(json.data) ? json.data : [];
  return rows.flatMap(row => {
    const entry = row as Record<string, unknown>;
    const id = normalizeIdentifier(entry.id);
    if (!id) return [];
    return [
      {
        id,
        publishedAt: graphTime(entry.timestamp),
        permalink: trimmedOrUndefined(entry.permalink) ?? null,
        mediaType: trimmedOrUndefined(entry.media_type)?.toUpperCase() ?? null,
        productType:
          trimmedOrUndefined(entry.media_product_type)?.toUpperCase() ?? null,
      },
    ];
  });
}

/**
 * The workspace's connected Instagram account, as publishing reads it:
 * - connected: a token and an account id are stored;
 * - canPublish: connected, and the publishing permission was granted (or
 *   the grants weren't recorded);
 * - username: the @name without "@", null when unknown.
 * The token stays on the server.
 */
export type InstagramPublishAccount = {
  connected: boolean;
  canPublish: boolean;
  username: string | null;
  authMethod: string;
  requiredPermission: string;
  access: InstagramAccess;
  accountIds: string[];
};

/** The account read from a source's credentials; null when nothing is connected. */
export function instagramPublishAccount(
  credentials: Record<string, unknown> | null | undefined
): InstagramPublishAccount | null {
  if (!credentials) return null;
  const authMethod = String(credentials.auth_method || "");
  const requiredPermission = resolvePublishPermission(authMethod);
  const accessToken = decryptMaybeString(credentials.page_access_token);
  const accountIds = resolveInstagramAccountIdCandidates(credentials);
  const connected = Boolean(accessToken) && accountIds.length > 0;
  const granted = grantedPermissions(credentials.granted_permissions);
  const username = normalizeIdentifier(credentials.username).replace(/^@/, "");
  return {
    connected,
    canPublish:
      connected && (granted.size === 0 || granted.has(requiredPermission)),
    username: username || null,
    authMethod,
    requiredPermission,
    access: { graphBase: resolveGraphApiBase(authMethod), accessToken },
    accountIds,
  };
}

/** The workspace's Instagram account for publishing; null when no source is connected. */
export async function loadInstagramPublishAccount(
  workspaceId: string
): Promise<InstagramPublishAccount | null> {
  const source = await fetchSourceWithCredentials(undefined, "instagram", {
    workspace_id: workspaceId,
  });
  if (!source?.workspace_id) return null;
  return instagramPublishAccount(
    (source.credentials || {}) as Record<string, unknown>
  );
}

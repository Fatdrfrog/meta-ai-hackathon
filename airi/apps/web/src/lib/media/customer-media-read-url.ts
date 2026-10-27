/**
 * Read URLs for end-customer chat media stored in Supabase Storage.
 *
 * Messages persist the public object URL of each upload. Those stored URLs
 * are treated as references: every place that serves media to a browser or
 * hands it to a provider exchanges them for short-lived signed URLs, so the
 * buckets can be made private without breaking readers.
 */

import { BUSINESS_MEDIA_PREFIXES } from "@/lib/media/business-media-bucket";
import { CUSTOMER_MEDIA_BUCKET_NAMES } from "@/lib/storage-buckets";

const CUSTOMER_MEDIA_BUCKETS = new Set<string>(CUSTOMER_MEDIA_BUCKET_NAMES);

/**
 * The private `avatars` bucket also holds end-customer profile photos that the
 * Telegram webhook saves (`app/api/telegram/helpers.ts`). Staff photos there
 * are read elsewhere and are not customer media.
 */
const CUSTOMER_AVATAR_BUCKET = "avatars";
const CUSTOMER_AVATAR_PREFIXES = ["telegram/"];

/** Long enough for a staff inbox or widget session. */
export const CUSTOMER_MEDIA_DISPLAY_TTL_SECONDS = 12 * 60 * 60;
/** Covers providers that download asynchronously (transcription queues). */
export const CUSTOMER_MEDIA_PROVIDER_TTL_SECONDS = 24 * 60 * 60;

const PUBLIC_OBJECT_PATH = "/storage/v1/object/public/";

/**
 * Other names for the configured project's storage. Messages saved before
 * the Supabase region move keep the Singapore project's host, and
 * api.airi.chat is the custom domain that follows the project across moves
 * (docs/infrastructure/supabase-eu-move.md). Their objects are signed in
 * whichever project NEXT_PUBLIC_SUPABASE_URL points at.
 */
const STORAGE_ORIGIN_ALIASES = new Set([
  "https://wnycyavumykzejnjelfb.supabase.co",
  "https://api.airi.chat",
]);

type CustomerMediaObject = { bucket: string; path: string };

function readSupabaseOrigin(): string | null {
  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!configured) return null;
  try {
    return new URL(configured).origin;
  } catch {
    return null;
  }
}

export function parseCustomerMediaObject(
  value: unknown
): CustomerMediaObject | null {
  if (typeof value !== "string" || !value) return null;
  const origin = readSupabaseOrigin();
  if (!origin) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    (url.origin !== origin && !STORAGE_ORIGIN_ALIASES.has(url.origin)) ||
    !url.pathname.startsWith(PUBLIC_OBJECT_PATH)
  ) {
    return null;
  }

  const objectPath = url.pathname.slice(PUBLIC_OBJECT_PATH.length);
  const separator = objectPath.indexOf("/");
  if (separator <= 0) return null;
  const bucket = objectPath.slice(0, separator);
  let path: string;
  try {
    path = decodeURIComponent(objectPath.slice(separator + 1));
  } catch {
    return null;
  }
  if (!path) return null;
  if (bucket === CUSTOMER_AVATAR_BUCKET) {
    return CUSTOMER_AVATAR_PREFIXES.some(prefix => path.startsWith(prefix))
      ? { bucket, path }
      : null;
  }
  if (!CUSTOMER_MEDIA_BUCKETS.has(bucket)) return null;
  // Business assets providers fetch by a stable public link stay public.
  if (BUSINESS_MEDIA_PREFIXES.some(prefix => path.startsWith(prefix))) {
    return null;
  }
  return { bucket, path };
}

/**
 * Signs every customer-media URL in `urls` (one request per bucket) and maps
 * each input to its read URL. Other URLs map to themselves. A signing failure
 * keeps the stored URL, which still works while the bucket is public.
 */
export async function resolveCustomerMediaReadUrls(
  urls: Iterable<unknown>,
  ttlSeconds: number
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const pathsByBucket = new Map<string, Map<string, string[]>>();

  for (const value of urls) {
    if (typeof value !== "string" || resolved.has(value)) continue;
    resolved.set(value, value);
    const object = parseCustomerMediaObject(value);
    if (!object) continue;
    const byPath = pathsByBucket.get(object.bucket) ?? new Map();
    byPath.set(object.path, [...(byPath.get(object.path) ?? []), value]);
    pathsByBucket.set(object.bucket, byPath);
  }

  if (pathsByBucket.size === 0) return resolved;
  // Loaded on demand: senders such as whatsapp.ts import this module widely.
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  await Promise.all(
    [...pathsByBucket].map(async ([bucket, byPath]) => {
      const { data, error } = await supabaseAdmin.storage
        .from(bucket)
        .createSignedUrls([...byPath.keys()], ttlSeconds);
      if (error || !data) {
        console.warn("[customer-media] signing failed", {
          bucket,
          objects: byPath.size,
          error: error?.message,
        });
        return;
      }
      for (const entry of data) {
        if (entry.error || !entry.signedUrl || !entry.path) continue;
        for (const original of byPath.get(entry.path) ?? []) {
          resolved.set(original, entry.signedUrl);
        }
      }
    })
  );

  return resolved;
}

export async function resolveCustomerMediaReadUrl<T>(
  url: T,
  ttlSeconds: number
): Promise<T | string> {
  if (!parseCustomerMediaObject(url)) return url;
  const resolved = await resolveCustomerMediaReadUrls([url], ttlSeconds);
  return resolved.get(url as string) ?? (url as string);
}

/** Only this request reads the link; it never leaves the server. */
const CUSTOMER_MEDIA_DOWNLOAD_TTL_SECONDS = 60;

type CustomerMediaDownload =
  | { kind: "downloaded"; bytes: Uint8Array; contentType: string | null }
  | { kind: "missing" }
  | { kind: "too_large" };

function isMissingStorageObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, statusCode, message } = error as {
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
  };
  return (
    status === 404 ||
    statusCode === "404" ||
    (typeof message === "string" && /not found/i.test(message))
  );
}

/**
 * Reads a customer-media object server-side without holding more than
 * `maxBytes`, for providers that must receive the bytes inline.
 */
export async function downloadCustomerMediaObject(
  object: CustomerMediaObject,
  maxBytes: number
): Promise<CustomerMediaDownload> {
  const [
    { supabaseAdmin },
    { JsonBodyTooLargeError, readBodyBytesWithinLimit },
  ] = await Promise.all([
    import("@/lib/supabase/admin"),
    import("@/lib/api/json-body"),
  ]);
  const { data, error } = await supabaseAdmin.storage
    .from(object.bucket)
    .createSignedUrl(object.path, CUSTOMER_MEDIA_DOWNLOAD_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    if (isMissingStorageObject(error)) return { kind: "missing" };
    throw new Error("Customer media could not be signed for download");
  }

  const response = await fetch(data.signedUrl, { redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 400 || response.status === 404) {
      return { kind: "missing" };
    }
    throw new Error(`Customer media download failed: HTTP ${response.status}`);
  }
  try {
    const bytes = await readBodyBytesWithinLimit(response, maxBytes);
    return {
      kind: "downloaded",
      bytes,
      contentType: response.headers.get("content-type"),
    };
  } catch (error) {
    if (!(error instanceof JsonBodyTooLargeError)) throw error;
    await response.body?.cancel().catch(() => undefined);
    return { kind: "too_large" };
  }
}

type MediaFields = {
  imageUrl?: unknown;
  mediaUrl?: unknown;
  attachments?: unknown;
  /** A message's author or a conversation's customer, with `avatar_url`. */
  author?: unknown;
  user?: unknown;
};

const AVATAR_HOLDER_FIELDS = ["author", "user"] as const;

function readAvatarUrl(holder: unknown): unknown {
  return holder && typeof holder === "object"
    ? (holder as { avatar_url?: unknown }).avatar_url
    : undefined;
}

function readAttachments(message: MediaFields): Array<{ url?: unknown }> {
  return Array.isArray(message.attachments)
    ? message.attachments.filter(
        (attachment): attachment is { url?: unknown } =>
          Boolean(attachment) && typeof attachment === "object"
      )
    : [];
}

/**
 * Returns copies of `messages` whose `imageUrl`, `mediaUrl`,
 * `attachments[].url`, `author.avatar_url` and `user.avatar_url` point at
 * signed URLs for customer media. Other fields and non-customer URLs are
 * unchanged.
 */
export async function withCustomerMediaReadUrls<T extends object>(
  messages: readonly T[],
  ttlSeconds: number = CUSTOMER_MEDIA_DISPLAY_TTL_SECONDS
): Promise<T[]> {
  const urls = messages.flatMap(message => {
    const fields = message as MediaFields;
    return [
      fields.imageUrl,
      fields.mediaUrl,
      ...readAttachments(fields).map(attachment => attachment.url),
      ...AVATAR_HOLDER_FIELDS.map(field => readAvatarUrl(fields[field])),
    ];
  });
  if (!urls.some(url => parseCustomerMediaObject(url))) return [...messages];

  const resolved = await resolveCustomerMediaReadUrls(urls, ttlSeconds);
  const read = (value: unknown): unknown =>
    typeof value === "string" ? (resolved.get(value) ?? value) : value;

  return messages.map(message => {
    const fields = message as MediaFields;
    const next: MediaFields = { ...fields };
    if ("imageUrl" in fields) next.imageUrl = read(fields.imageUrl);
    if ("mediaUrl" in fields) next.mediaUrl = read(fields.mediaUrl);
    if (Array.isArray(fields.attachments)) {
      next.attachments = fields.attachments.map((attachment: unknown) =>
        attachment &&
        typeof attachment === "object" &&
        typeof (attachment as { url?: unknown }).url === "string"
          ? {
              ...attachment,
              url: read((attachment as { url: string }).url),
            }
          : attachment
      );
    }
    for (const field of AVATAR_HOLDER_FIELDS) {
      const holder = fields[field];
      const avatarUrl = readAvatarUrl(holder);
      if (typeof avatarUrl === "string") {
        next[field] = { ...(holder as object), avatar_url: read(avatarUrl) };
      }
    }
    return next as T;
  });
}

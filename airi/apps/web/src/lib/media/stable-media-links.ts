/**
 * Keeps one signed link per stored object while a conversation stays open.
 *
 * Every conversation response signs customer media afresh, so each refetch
 * hands the thread new links for the same files. A new `src` makes the
 * browser reload media already on screen: a video went back to "Loading
 * video…" and downloaded again on every refresh.
 */

const SIGNED_OBJECT_PATH = "/storage/v1/object/sign/";
// Display links are signed for 12 hours (CUSTOMER_MEDIA_DISPLAY_TTL_SECONDS);
// a kept link is replaced well before it can expire.
const STABLE_LINK_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** The stored object a signed link points at, without its token. */
export function signedMediaObjectKey(url: unknown): string | null {
  if (typeof url !== "string" || !url.includes(SIGNED_OBJECT_PATH)) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return parsed.pathname.startsWith(SIGNED_OBJECT_PATH)
      ? `${parsed.origin}${parsed.pathname}`
      : null;
  } catch {
    return null;
  }
}

type StableMediaLink = ReturnType<typeof createStableMediaLinks>;

/** The message with its media links swapped for the kept ones. */
export function withStableMediaLinks<
  T extends {
    imageUrl?: string | null;
    attachments?: ReadonlyArray<{ url?: string | null }> | null;
  },
>(message: T, stableMediaLink: StableMediaLink): T {
  const imageUrl = stableMediaLink(message.imageUrl);
  let attachmentsChanged = false;
  const attachments = message.attachments?.map(attachment => {
    const url = stableMediaLink(attachment.url);
    if (url === attachment.url) return attachment;
    attachmentsChanged = true;
    return { ...attachment, url };
  });
  if (imageUrl === message.imageUrl && !attachmentsChanged) return message;
  return {
    ...message,
    imageUrl,
    ...(attachmentsChanged ? { attachments } : {}),
  } as T;
}

export function createStableMediaLinks(now: () => number = Date.now) {
  const kept = new Map<string, { url: string; keptAt: number }>();
  return function stableMediaLink<T>(url: T): T | string {
    const key = signedMediaObjectKey(url);
    if (!key) return url;
    const current = kept.get(key);
    if (current && now() - current.keptAt < STABLE_LINK_MAX_AGE_MS) {
      return current.url;
    }
    kept.set(key, { url: url as string, keptAt: now() });
    return url;
  };
}

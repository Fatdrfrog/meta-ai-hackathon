import { createHash, randomUUID } from "node:crypto";
import { buildCacheKey, cache as sharedCache } from "@icecore/shared/lib/cache";
import {
  uploadWhatsAppMediaFromUrl,
  type WhatsAppUploadMediaKind,
} from "@/lib/whatsapp/media-upload";
import { WHATSAPP_TEMPLATE_HEADER_MEDIA_FALLBACK_MIME_TYPES } from "@/lib/whatsapp/media-types";
import { isWhatsAppCdnUrl } from "@/lib/whatsapp/templates/header-media-utils";
import type { WhatsAppTemplateSendComponentInput } from "@/lib/whatsapp/templates/message-types";

export { isWhatsAppCdnUrl };

export type WhatsAppHeaderMediaUploadCache = Map<string, Promise<string>>;

// Uploaded Cloud API media lasts 30 days. Refresh conservatively after one day.
// https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media
const MEDIA_ID_TTL_SECONDS = 24 * 60 * 60;
const UPLOAD_LOCK_TTL_SECONDS = 120;
const CONTENTION_WAIT_MS = 2_000;
const CONTENTION_POLL_MS = 250;

type CachedMediaId = { id: string; expiresAt: number };

function coordinationUnavailable(): Error {
  return new Error(
    "WhatsApp template header media cache is temporarily unavailable"
  );
}

async function readReusableMediaId(key: string): Promise<string | null> {
  const entry = await sharedCache.readWithStatus<CachedMediaId>(key);
  if (entry.status === "unavailable") throw coordinationUnavailable();
  if (entry.status === "miss") return null;
  if (
    !entry.value ||
    typeof entry.value.id !== "string" ||
    !entry.value.id.trim() ||
    !Number.isFinite(entry.value.expiresAt)
  )
    throw coordinationUnavailable();
  return entry.value.expiresAt > Date.now() ? entry.value.id : null;
}

function filenameFromUrl(link: string): string | undefined {
  try {
    const pathname = new URL(link).pathname;
    return pathname.split("/").filter(Boolean).at(-1) || undefined;
  } catch {
    return undefined;
  }
}

async function resolveWhatsAppHeaderMediaId(params: {
  phoneNumberId: string;
  accessToken: string;
  kind: WhatsAppUploadMediaKind;
  link: string;
  filename?: string;
  cache: WhatsAppHeaderMediaUploadCache;
}): Promise<string> {
  const digest = createHash("sha256")
    .update(JSON.stringify([params.kind, params.link, params.filename || ""]))
    .digest("hex");
  const cacheKey = buildCacheKey("whatsapp:template-header-media:v1", [
    params.phoneNumberId,
    digest,
  ]);
  let pendingUpload = params.cache.get(cacheKey);
  if (!pendingUpload) {
    pendingUpload = (async () => {
      const lockKey = `${cacheKey}:lock`;
      const ownerToken = randomUUID();
      const deadline = Date.now() + CONTENTION_WAIT_MS;
      for (;;) {
        const cached = await readReusableMediaId(cacheKey);
        if (cached) return cached;
        const acquisition = await sharedCache.acquireLock(
          lockKey,
          ownerToken,
          UPLOAD_LOCK_TTL_SECONDS
        );
        if (acquisition === "unavailable") throw coordinationUnavailable();
        if (acquisition === "acquired") {
          let releaseLock = true;
          try {
            // Another owner may have published between our read and acquisition.
            const published = await readReusableMediaId(cacheKey);
            if (published) return published;
            const uploaded = await uploadWhatsAppMediaFromUrl({
              phoneNumberId: params.phoneNumberId,
              accessToken: params.accessToken,
              mediaUrl: params.link,
              kind: params.kind,
              fallbackMimeType:
                WHATSAPP_TEMPLATE_HEADER_MEDIA_FALLBACK_MIME_TYPES[params.kind],
              filename: params.filename || filenameFromUrl(params.link),
            });
            // Retain the lease if publication is unavailable: immediate retries
            // must not start another upload while the cache is failing.
            releaseLock = false;
            const publication = await sharedCache.publishIfLockOwned({
              lockKey,
              ownerToken,
              valueKey: cacheKey,
              value: {
                id: uploaded.id,
                expiresAt: Date.now() + MEDIA_ID_TTL_SECONDS * 1000,
              } satisfies CachedMediaId,
              ttlSeconds: MEDIA_ID_TTL_SECONDS,
            });
            if (publication !== "published") throw coordinationUnavailable();
            return uploaded.id;
          } finally {
            if (releaseLock)
              await sharedCache.compareAndDelete(lockKey, ownerToken);
          }
        }
        if (Date.now() >= deadline) {
          throw new Error(
            "WhatsApp template header media upload is in progress; retry shortly"
          );
        }
        await new Promise(resolve => setTimeout(resolve, CONTENTION_POLL_MS));
      }
    })().finally(() => {
      // Only coalesce in-flight requests here. Shared records own expiration,
      // including when a caller retains this map across sends or retries.
      if (params.cache.get(cacheKey) === pendingUpload)
        params.cache.delete(cacheKey);
    });
    params.cache.set(cacheKey, pendingUpload);
  }
  return pendingUpload;
}

export async function normalizeWhatsAppTemplateHeaderMediaComponents<
  T extends WhatsAppTemplateSendComponentInput,
>(params: {
  components: T[] | undefined;
  phoneNumberId: string;
  accessToken: string;
  cache?: WhatsAppHeaderMediaUploadCache;
}): Promise<T[] | undefined> {
  if (!params.components?.length) return params.components;

  const cache = params.cache ?? new Map<string, Promise<string>>();
  let changed = false;
  const normalized: T[] = [];

  for (const component of params.components) {
    if (component.type === "carousel") {
      let cardChanged = false;
      const cards: typeof component.cards = [];
      for (const card of component.cards) {
        const nested = await normalizeWhatsAppTemplateHeaderMediaComponents({
          components: card.components,
          phoneNumberId: params.phoneNumberId,
          accessToken: params.accessToken,
          cache,
        });
        if (nested !== card.components) {
          cardChanged = true;
        }
        cards.push({
          ...card,
          components: nested ?? card.components,
        });
      }
      if (cardChanged) {
        changed = true;
        normalized.push({
          ...component,
          cards,
        } as T);
      } else {
        normalized.push(component);
      }
      continue;
    }

    if (component.type !== "header") {
      normalized.push(component);
      continue;
    }

    const parameters: typeof component.parameters = [];
    for (const parameter of component.parameters) {
      if (
        parameter.type === "image" &&
        parameter.image.link &&
        !parameter.image.id &&
        isWhatsAppCdnUrl(parameter.image.link)
      ) {
        const id = await resolveWhatsAppHeaderMediaId({
          phoneNumberId: params.phoneNumberId,
          accessToken: params.accessToken,
          kind: "image",
          link: parameter.image.link,
          cache,
        });
        parameters.push({ type: "image", image: { id } });
        changed = true;
        continue;
      }

      if (
        parameter.type === "video" &&
        parameter.video.link &&
        !parameter.video.id &&
        isWhatsAppCdnUrl(parameter.video.link)
      ) {
        const id = await resolveWhatsAppHeaderMediaId({
          phoneNumberId: params.phoneNumberId,
          accessToken: params.accessToken,
          kind: "video",
          link: parameter.video.link,
          cache,
        });
        parameters.push({ type: "video", video: { id } });
        changed = true;
        continue;
      }

      if (
        parameter.type === "document" &&
        parameter.document.link &&
        !parameter.document.id &&
        isWhatsAppCdnUrl(parameter.document.link)
      ) {
        const id = await resolveWhatsAppHeaderMediaId({
          phoneNumberId: params.phoneNumberId,
          accessToken: params.accessToken,
          kind: "document",
          link: parameter.document.link,
          filename: parameter.document.filename,
          cache,
        });
        parameters.push({
          type: "document",
          document: {
            id,
            ...(parameter.document.filename
              ? { filename: parameter.document.filename }
              : {}),
          },
        });
        changed = true;
        continue;
      }

      parameters.push(parameter);
    }

    normalized.push({
      ...component,
      parameters,
    } as T);
  }

  return changed ? normalized : params.components;
}

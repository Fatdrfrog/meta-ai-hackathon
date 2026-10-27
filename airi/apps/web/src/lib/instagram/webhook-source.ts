import type { Source } from "@icecore/shared/types/sources";
import type { InstagramSourceData } from "@/lib/instagram/webhook-shared";
import {
  asRecord,
  readNonEmptyStringOrUndefined as optionalString,
  readFiniteNumber,
} from "@icecore/shared/lib/value-utils";

export type InstagramWebhookCommentPayload = {
  id: string;
  text: string;
  timestamp?: string;
  parent_id?: string;
  hidden?: boolean;
  like_count?: number;
  from?: { id: string; username?: string };
  media?: {
    id: string;
    media_product_type?: string;
    media_type?: string;
    permalink?: string;
    shortcode?: string;
    timestamp?: string;
    caption?: string;
    media_url?: string;
    thumbnail_url?: string;
    username?: string;
  };
};

const INSTAGRAM_WEBHOOK_SOURCE_CREDENTIAL_KEYS = [
  "instagram_scoped_id",
  "instagram_business_account_id",
  "page_id",
] as const;

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function resolveInstagramEndpointId(
  credentials: Record<string, unknown>,
  fallbackIds: string[]
): string {
  const authMethod = String(credentials.auth_method || "");
  const candidates =
    authMethod === "instagram_business_login"
      ? [
          credentials.instagram_scoped_id,
          credentials.instagram_business_account_id,
          credentials.page_id,
          ...fallbackIds,
        ]
      : [
          credentials.page_id,
          credentials.instagram_business_account_id,
          credentials.instagram_scoped_id,
          ...fallbackIds,
        ];

  return candidates.map(value => String(value || "")).find(Boolean) || "";
}

export function buildInstagramSourceData(
  source: Source | null | undefined,
  fallbackIds: string[]
): InstagramSourceData | null {
  if (!source?.workspace_id) return null;
  const credentials = asRecord(source.credentials);
  const pageAccessToken = credentials.page_access_token;
  if (!pageAccessToken) return null;

  const pageId = resolveInstagramEndpointId(credentials, fallbackIds);
  if (!pageId) return null;

  return {
    id: source.id,
    workspace_id: source.workspace_id,
    pageAccessToken: pageAccessToken as InstagramSourceData["pageAccessToken"],
    pageId,
    instagramScopedId: optionalString(credentials.instagram_scoped_id),
    instagramBusinessAccountId: optionalString(
      credentials.instagram_business_account_id
    ),
    instagramUsername: optionalString(credentials.username),
    authMethod: optionalString(credentials.auth_method),
  };
}

export async function resolveInstagramWebhookSource(
  recipientId: string,
  entryId: string
): Promise<Source | null> {
  const { fetchSourceWithCredentials } = await import("@/lib/sources/utils");
  const ids = [recipientId, entryId].filter(Boolean);

  for (const id of ids) {
    for (const key of INSTAGRAM_WEBHOOK_SOURCE_CREDENTIAL_KEYS) {
      const source = await fetchSourceWithCredentials(undefined, "instagram", {
        [`credentials->>${key}`]: id,
      });
      if (source?.workspace_id) return source;
    }
  }

  return null;
}

export async function resolveInstagramWebhookSourceData(
  recipientId: string,
  entryId: string
): Promise<InstagramSourceData | null> {
  const source = await resolveInstagramWebhookSource(recipientId, entryId);
  return buildInstagramSourceData(source, [recipientId, entryId]);
}

export function normalizeInstagramWebhookComment(
  comment: Record<string, unknown>
): InstagramWebhookCommentPayload {
  const from = asRecord(comment.from);
  const media = asRecord(comment.media);

  return {
    id: String(comment.id || ""),
    text: String(comment.text || ""),
    timestamp: optionalString(comment.timestamp),
    parent_id: optionalString(comment.parent_id),
    hidden: optionalBoolean(comment.hidden),
    like_count: readFiniteNumber(comment.like_count) ?? undefined,
    from:
      "id" in from
        ? {
            id: String(from.id || ""),
            username: optionalString(from.username),
          }
        : undefined,
    media:
      "id" in media
        ? {
            id: String(media.id || ""),
            media_product_type: optionalString(media.media_product_type),
            media_type: optionalString(media.media_type),
            permalink: optionalString(media.permalink),
            shortcode: optionalString(media.shortcode),
            timestamp: optionalString(media.timestamp),
            caption: optionalString(media.caption),
            media_url: optionalString(media.media_url),
            thumbnail_url: optionalString(media.thumbnail_url),
            username: optionalString(media.username),
          }
        : undefined,
  };
}

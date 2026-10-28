import "server-only";
import crypto from "crypto";
import {
  ensureBusinessMediaBucket,
  resolveBusinessMediaBucket,
} from "@/lib/media/business-media-bucket";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { storeSupabaseWorkspaceBuffer } from "@icecore/airi-runtime/storage-quota";

// Where WhatsApp template header samples are kept: the public business media
// bucket, which Meta downloads them from when the template is submitted.

function sanitizePathSegment(segment: string): string {
  return (
    segment
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 80) || "workspace"
  );
}

export function getWhatsAppTemplateHeaderMediaBucket(): string {
  return resolveBusinessMediaBucket(
    process.env.SUPABASE_WHATSAPP_TEMPLATE_MEDIA_BUCKET
  );
}

export function createWhatsAppTemplateHeaderMediaPath(params: {
  fileName: string;
  workspaceId: string;
}): string {
  const random = crypto.randomBytes(8).toString("hex");
  return `whatsapp-template-headers/${sanitizePathSegment(
    params.workspaceId
  )}/${Date.now()}-${random}-${params.fileName}`;
}

/**
 * Stores a header sample in the workspace's media, counted against its
 * storage, and gives its public link. `fileName` must be storage-safe.
 */
export async function storeWhatsAppTemplateHeaderMedia(params: {
  workspaceId: string;
  fileName: string;
  buffer: Buffer;
  mimeType: string;
}): Promise<{ url: string; bucket: string; path: string }> {
  const bucket = getWhatsAppTemplateHeaderMediaBucket();
  await ensureBusinessMediaBucket(supabaseAdmin.storage, bucket);
  const path = createWhatsAppTemplateHeaderMediaPath(params);
  await storeSupabaseWorkspaceBuffer({
    storage: supabaseAdmin.storage,
    workspaceId: params.workspaceId,
    bucket,
    path,
    buffer: params.buffer,
    mimeType: params.mimeType,
  });
  const {
    data: { publicUrl },
  } = supabaseAdmin.storage.from(bucket).getPublicUrl(path);
  return { url: publicUrl, bucket, path };
}

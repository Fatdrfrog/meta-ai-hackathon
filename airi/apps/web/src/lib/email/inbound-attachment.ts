import { supabaseAdmin } from "@/lib/supabase/admin";
import { storeSupabaseWorkspaceBuffer } from "@icecore/airi-runtime/storage-quota";

export type StoredEmailAttachment = {
  filename: string;
  url: string;
  contentType: string;
  sizeBytes: number;
  storage_path: string;
};

export function resolveEmailInlineAttachments(
  html: string,
  attachments: Array<{ ContentID?: string }>,
  stored: Array<StoredEmailAttachment | null>
): string {
  for (const [index, attachment] of attachments.entries()) {
    const url = stored[index]?.url;
    if (attachment.ContentID && url)
      html = html.replaceAll(
        `cid:${attachment.ContentID.replace(/[<>]/g, "")}`,
        url
      );
  }
  return html;
}

export async function storeEmailInboundAttachment(
  workspaceId: string,
  messageId: string,
  attachment: {
    Name: string;
    Content?: string;
    ContentLink?: string;
    ContentType?: string;
    ContentLength?: number;
  }
): Promise<StoredEmailAttachment | null> {
  try {
    const bucket = "email-attachments";
    const path = `${workspaceId}/${messageId}/${attachment.Name}`;
    let buffer: Buffer | null = null;
    let mimeType = attachment.ContentType || "application/octet-stream";
    if (attachment.Content) buffer = Buffer.from(attachment.Content, "base64");
    else if (attachment.ContentLink) {
      const response = await fetch(attachment.ContentLink);
      if (!response.ok)
        throw new Error(`Attachment download failed: ${response.status}`);
      buffer = Buffer.from(await response.arrayBuffer());
      mimeType =
        attachment.ContentType ||
        response.headers.get("content-type") ||
        mimeType;
    }
    if (!buffer) return null;
    await storeSupabaseWorkspaceBuffer({
      storage: supabaseAdmin.storage,
      workspaceId,
      bucket,
      path,
      buffer,
      mimeType,
    });
    const { data } = supabaseAdmin.storage.from(bucket).getPublicUrl(path);
    return {
      filename: attachment.Name,
      url: data.publicUrl,
      contentType: mimeType,
      sizeBytes: buffer.byteLength,
      storage_path: path,
    };
  } catch (error) {
    console.warn("[Email Inbound] Attachment storage unavailable", {
      workspaceId,
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

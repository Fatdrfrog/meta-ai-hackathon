import {
  CONVERSATION_ATTACHMENT_BUCKET_NAME,
  CONVERSATION_DIRECT_ATTACHMENT_MAX_BYTES,
  validateConversationAttachmentFile,
} from "@/lib/conversation-attachments";
import { getHiddenConversationPlanGateResponse } from "@/lib/limits/company-limits";
import connectDB from "@/lib/mongoose";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  createReservedSupabaseUpload,
  storeSupabaseWorkspaceBuffer,
  StorageQuotaError,
} from "@icecore/airi-runtime/storage-quota";
import {
  getSupabaseRouteAuth,
  isSupabaseRouteAuthError,
} from "@/lib/supabase/route-auth";
import { uploadWhatsAppMediaFile } from "@/lib/whatsapp/media-upload";
import { resolveWhatsAppSendContext } from "@/lib/whatsapp/send-context";
import { Conversation } from "@/models/conversation";
import type { OutboundAttachment } from "@/types/outbound-attachment";
import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { sanitizeStorageFilename } from "@icecore/shared/lib/storage-filename";

type Params = Promise<{ id: string }>;

type UploadConversation = {
  workspaceId: string;
  channel: string;
  sourceId?: string | null;
  external_thread?: { type?: string } | null;
};

type DirectUploadInitPayload = {
  mode?: "direct";
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
};

// The bucket only has to be prepared once per process.
let attachmentBucketReady: Promise<void> | null = null;

function ensureAttachmentBucket(): Promise<void> {
  attachmentBucketReady ??= (async () => {
    const { data, error } = await supabaseAdmin.storage.getBucket(
      CONVERSATION_ATTACHMENT_BUCKET_NAME
    );
    if (data && !error) return;

    const { error: createError } = await supabaseAdmin.storage.createBucket(
      CONVERSATION_ATTACHMENT_BUCKET_NAME,
      {
        // Readers sign stored URLs (customer-media-read-url), so a recreated
        // bucket never needs to be public.
        public: false,
        fileSizeLimit: CONVERSATION_DIRECT_ATTACHMENT_MAX_BYTES,
      }
    );

    if (createError && !/already exists/i.test(createError.message)) {
      throw new Error(
        `Failed to prepare attachment storage: ${createError.message}`
      );
    }
  })().catch(error => {
    attachmentBucketReady = null;
    throw error;
  });
  return attachmentBucketReady;
}

function buildOutboundAttachmentPath(params: {
  channel: string;
  workspaceId: string;
  conversationId: string;
  fileName: string;
}): string {
  const random = crypto.randomBytes(8).toString("hex");
  return `outbound/${params.channel}/${params.workspaceId}/${params.conversationId}/${Date.now()}-${random}-${params.fileName}`;
}

function getAttachmentPublicUrl(storagePath: string): string {
  return supabaseAdmin.storage
    .from(CONVERSATION_ATTACHMENT_BUCKET_NAME)
    .getPublicUrl(storagePath).data.publicUrl;
}

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
) {
  const uploadContext: Record<string, unknown> = {
    route: "/api/conversations/[id]/reply/upload",
  };

  try {
    const auth = await getSupabaseRouteAuth(request);
    if (isSupabaseRouteAuthError(auth)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { supabase, user } = auth;

    const { id: conversationId } = await params;
    uploadContext.conversationId = conversationId;

    await connectDB();
    const conversation = await Conversation.findById(conversationId)
      .select("workspaceId channel sourceId external_thread")
      .lean<UploadConversation | null>();
    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    const { workspaceId, channel } = conversation;
    uploadContext.channel = channel;
    uploadContext.workspaceId = workspaceId;

    const hasAccess = await verifyWorkspaceAccess(
      supabase,
      user.id,
      workspaceId
    );
    if (!hasAccess) {
      return NextResponse.json(
        { error: "Access denied to this conversation" },
        { status: 403 }
      );
    }

    const planGateResponse = await getHiddenConversationPlanGateResponse(
      supabase,
      workspaceId,
      conversationId
    );
    if (planGateResponse) {
      return planGateResponse;
    }

    const isInstagramCommentThread =
      channel === "instagram" &&
      conversation.external_thread?.type === "comment";
    const contentType = request.headers.get("content-type") || "";

    // Non-WhatsApp attachments upload straight to storage: this call only
    // reserves quota and returns a signed upload token.
    if (contentType.toLowerCase().includes("application/json")) {
      const payload = (await request
        .json()
        .catch(() => null)) as DirectUploadInitPayload | null;
      if (payload?.mode !== "direct") {
        return NextResponse.json(
          { error: "Unsupported upload request" },
          { status: 400 }
        );
      }
      if (channel === "whatsapp") {
        return NextResponse.json(
          { error: "WhatsApp attachments must be uploaded to Meta" },
          { status: 400 }
        );
      }

      const fileSize =
        typeof payload.fileSize === "number" &&
        Number.isFinite(payload.fileSize)
          ? payload.fileSize
          : undefined;
      if (fileSize !== undefined && fileSize <= 0) {
        return NextResponse.json({ error: "Empty file" }, { status: 400 });
      }

      uploadContext.fileName = payload.fileName || null;
      uploadContext.mimeType = payload.mimeType || null;
      uploadContext.fileSize = fileSize || null;

      const validation = validateConversationAttachmentFile({
        channel,
        fileName: payload.fileName,
        mimeType: payload.mimeType,
        fileSize,
        isInstagramCommentThread,
      });
      if (!validation.ok) {
        return NextResponse.json({ error: validation.error }, { status: 400 });
      }

      await ensureAttachmentBucket();
      const safeOriginalName = sanitizeStorageFilename(
        payload.fileName || "attachment",
        `file-${Date.now()}`
      );
      const storagePath = buildOutboundAttachmentPath({
        channel,
        workspaceId,
        conversationId,
        fileName: safeOriginalName,
      });
      const upload = await createReservedSupabaseUpload({
        storage: supabaseAdmin.storage,
        workspaceId,
        bucket: CONVERSATION_ATTACHMENT_BUCKET_NAME,
        path: storagePath,
        declaredBytes: fileSize || 0,
      });

      return NextResponse.json({
        success: true,
        upload: {
          bucket: CONVERSATION_ATTACHMENT_BUCKET_NAME,
          path: storagePath,
          token: upload.token,
        },
        attachment: {
          url: getAttachmentPublicUrl(storagePath),
          mediaType: validation.attachment.mediaType,
          mimeType: validation.attachment.mimeType,
          fileName: payload.fileName || safeOriginalName,
          ...(typeof fileSize === "number" ? { fileSize } : {}),
        } satisfies OutboundAttachment,
      });
    }

    // WhatsApp attachments go to Meta first (for the media id), then a copy
    // is kept in storage for the inbox.
    if (channel !== "whatsapp") {
      return NextResponse.json(
        { error: "Unsupported upload request" },
        { status: 400 }
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (file.size <= 0) {
      return NextResponse.json({ error: "Empty file" }, { status: 400 });
    }

    const mimeType = file.type || "application/octet-stream";
    const safeOriginalName = sanitizeStorageFilename(
      file.name || "attachment",
      `file-${Date.now()}`
    );
    uploadContext.fileName = file.name || safeOriginalName;
    uploadContext.mimeType = mimeType;
    uploadContext.fileSize = file.size;

    const validation = validateConversationAttachmentFile({
      channel,
      fileName: file.name || safeOriginalName,
      mimeType,
      fileSize: file.size,
    });
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const sendContext = await resolveWhatsAppSendContext({
      workspaceId,
      sourceId: conversation.sourceId,
    });

    if (!sendContext) {
      return NextResponse.json(
        { error: "WhatsApp credentials incomplete" },
        { status: 400 }
      );
    }

    const uploaded = await uploadWhatsAppMediaFile({
      phoneNumberId: sendContext.phoneNumberId,
      accessToken: sendContext.accessToken,
      file,
      fallbackMimeType: mimeType,
      filename: file.name || safeOriginalName,
    });

    await ensureAttachmentBucket();
    const storagePath = buildOutboundAttachmentPath({
      channel,
      workspaceId,
      conversationId,
      fileName: safeOriginalName,
    });
    await storeSupabaseWorkspaceBuffer({
      storage: supabaseAdmin.storage,
      workspaceId,
      bucket: CONVERSATION_ATTACHMENT_BUCKET_NAME,
      path: storagePath,
      buffer: Buffer.from(await file.arrayBuffer()),
      mimeType: uploaded.mimeType,
    });

    return NextResponse.json({
      success: true,
      attachment: {
        url: getAttachmentPublicUrl(storagePath),
        whatsappMediaId: uploaded.id,
        mediaType: validation.attachment.mediaType,
        mimeType: uploaded.mimeType,
        fileName: file.name || safeOriginalName,
        fileSize: uploaded.sizeBytes,
      } satisfies OutboundAttachment,
    });
  } catch (error) {
    if (error instanceof StorageQuotaError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    const message =
      error instanceof Error ? error.message : "Internal server error";
    const status =
      error instanceof MetaGraphRequestError &&
      error.status >= 400 &&
      error.status < 500
        ? error.status
        : error instanceof MetaGraphRequestError
          ? 502
          : 500;

    console.error("[ReplyUpload] Attachment upload failed", {
      ...uploadContext,
      status,
      error: message,
      metaStatus:
        error instanceof MetaGraphRequestError ? error.status : undefined,
      metaDetails:
        error instanceof MetaGraphRequestError ? error.details : undefined,
    });

    return NextResponse.json({ error: message }, { status });
  }
}

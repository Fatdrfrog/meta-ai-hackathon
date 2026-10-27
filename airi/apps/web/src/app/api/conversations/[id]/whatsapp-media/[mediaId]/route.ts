import {
  CUSTOMER_MEDIA_DISPLAY_TTL_SECONDS,
  resolveCustomerMediaReadUrl,
} from "@/lib/media/customer-media-read-url";
import { getHiddenConversationPlanGateResponse } from "@/lib/limits/company-limits";
import {
  fetchWhatsAppMediaFromMeta,
  isPermanentWhatsAppMediaProviderError,
} from "@/lib/media/whatsapp-media-graph";
import { resolveDurableMessageMediaUrl } from "@/lib/media/whatsapp-media-url";
import connectDB from "@/lib/mongoose";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import { createClient } from "@/lib/supabase/server";
import { resolveWhatsAppSendContext } from "@/lib/whatsapp/send-context";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import { NextRequest, NextResponse } from "next/server";

type Params = Promise<{ id: string; mediaId: string }>;

type ConversationMediaAccess = {
  _id: unknown;
  workspaceId: string;
  channel?: string | null;
  sourceId?: string | null;
};

type MessageMediaAccess = {
  _id: unknown;
  imageUrl?: string | null;
  attachments?: Array<{ url?: string | null }> | null;
};

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function getContentDisposition(
  contentType: string,
  fileName: string | null
): string | null {
  const normalizedType = contentType.toLowerCase();
  const disposition = /^(image|video|audio)\//.test(normalizedType)
    ? "inline"
    : "attachment";
  const normalizedFileName = fileName?.trim();

  if (!normalizedFileName) {
    return disposition;
  }

  return `${disposition}; filename*=UTF-8''${encodeHeaderValue(
    normalizedFileName
  )}`;
}

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Params }
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: conversationId, mediaId } = await params;
  const normalizedMediaId = mediaId.trim();
  if (!normalizedMediaId) {
    return NextResponse.json({ error: "Missing media id" }, { status: 400 });
  }

  await connectDB();
  const conversation = await Conversation.findById(conversationId)
    .select("_id workspaceId channel sourceId")
    .lean<ConversationMediaAccess | null>()
    .exec();

  if (!conversation) {
    return NextResponse.json(
      { error: "Conversation not found" },
      { status: 404 }
    );
  }

  if (conversation.channel !== "whatsapp") {
    return NextResponse.json(
      { error: "Media proxy is only available for WhatsApp conversations" },
      { status: 400 }
    );
  }

  const { workspaceId } = conversation;
  const hasAccess = await verifyWorkspaceAccess(supabase, user.id, workspaceId);
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

  const mediaMessage = await Message.findOne({
    conversation: conversation._id,
    workspaceId,
    channel: "whatsapp",
    whatsappMediaId: normalizedMediaId,
  })
    .select("_id imageUrl attachments")
    .lean<MessageMediaAccess | null>()
    .exec();

  if (!mediaMessage) {
    return NextResponse.json(
      { error: "WhatsApp media not found for this conversation" },
      { status: 404 }
    );
  }

  const durableUrl = resolveDurableMessageMediaUrl(mediaMessage);
  if (durableUrl) {
    return NextResponse.redirect(
      await resolveCustomerMediaReadUrl(
        durableUrl,
        CUSTOMER_MEDIA_DISPLAY_TTL_SECONDS
      ),
      302
    );
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

  let mediaInfo: {
    url: string;
    mime_type?: string;
    file_size?: number | string;
  };
  let downloadResponse: Response;

  try {
    const result = await fetchWhatsAppMediaFromMeta({
      mediaId: normalizedMediaId,
      accessToken: sendContext.accessToken,
      phoneNumberId: sendContext.phoneNumberId,
    });
    mediaInfo = result.mediaInfo;
    downloadResponse = result.response;
  } catch (error) {
    if (isPermanentWhatsAppMediaProviderError(error)) {
      return NextResponse.json(
        {
          error:
            "WhatsApp media is no longer available from Meta and no stored copy exists.",
          code: "whatsapp_media_unavailable",
        },
        { status: 410 }
      );
    }

    return NextResponse.json(
      { error: "Failed to fetch WhatsApp media from Meta" },
      { status: 502 }
    );
  }

  if (!downloadResponse.ok || !downloadResponse.body) {
    return NextResponse.json(
      {
        error: `Failed to fetch WhatsApp media: HTTP ${downloadResponse.status}`,
      },
      { status: 502 }
    );
  }

  const contentType =
    mediaInfo.mime_type ||
    downloadResponse.headers.get("content-type") ||
    "application/octet-stream";
  const responseHeaders = new Headers();
  responseHeaders.set("Content-Type", contentType);
  responseHeaders.set("Cache-Control", "private, no-store");
  responseHeaders.set("X-Content-Type-Options", "nosniff");

  const contentLength =
    downloadResponse.headers.get("content-length") ||
    (typeof mediaInfo.file_size === "number"
      ? String(mediaInfo.file_size)
      : null);
  if (contentLength) {
    responseHeaders.set("Content-Length", contentLength);
  }

  const disposition = getContentDisposition(
    contentType,
    request.nextUrl.searchParams.get("filename")
  );
  if (disposition) {
    responseHeaders.set("Content-Disposition", disposition);
  }

  return new NextResponse(downloadResponse.body, {
    status: 200,
    headers: responseHeaders,
  });
}

import {
  buildWhatsAppCallParticipantIdentity,
  buildWhatsAppCallRoomName,
  mintLiveKitMediaToken,
  resolveLiveKitMediaTokenTtlSeconds,
  resolveLiveKitCallingConfigFromEnv,
} from "@/lib/calling/livekit-adapter";
import connectDB from "@/lib/mongoose";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import WhatsAppCallSession from "@/models/whatsapp-call-session";
import { NextResponse } from "next/server";

type Params = Promise<{ workspaceId: string; callSessionId: string }>;

type LeanWhatsAppCallSession = {
  _id?: unknown;
  workspaceId?: string | null;
  callId?: string | null;
  state?: string | null;
};

const TERMINAL_CALL_STATES = new Set(["terminated", "missed", "failed"]);

export async function GET(_request: Request, { params }: { params: Params }) {
  const { workspaceId, callSessionId } = await params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) {
    return access.response;
  }

  const liveKit = resolveLiveKitCallingConfigFromEnv();
  if (!liveKit) {
    return NextResponse.json(
      { error: "WhatsApp call media is not configured" },
      { status: 503 }
    );
  }

  await connectDB();
  const session = await WhatsAppCallSession.findOne({
    _id: callSessionId,
    workspaceId,
  })
    .select("_id workspaceId callId state")
    .lean<LeanWhatsAppCallSession | null>()
    .exec();

  if (!session?._id || !session.callId) {
    return NextResponse.json(
      { error: "Call session not found" },
      { status: 404 }
    );
  }

  if (TERMINAL_CALL_STATES.has(session.state || "")) {
    return NextResponse.json(
      { error: "Call session has ended" },
      { status: 409 }
    );
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttlSeconds = resolveLiveKitMediaTokenTtlSeconds(
    liveKit.mediaTokenTtlSeconds
  );
  const roomName = buildWhatsAppCallRoomName({
    workspaceId,
    callId: session.callId,
  });
  const identity = buildWhatsAppCallParticipantIdentity({
    workspaceId,
    userId: access.userId,
  });
  const token = await mintLiveKitMediaToken({
    apiKey: liveKit.apiKey,
    apiSecret: liveKit.apiSecret,
    roomName,
    identity,
    ttlSeconds,
    nowSeconds,
  });

  return NextResponse.json({
    success: true,
    liveKitUrl: liveKit.url,
    roomName,
    token,
    identity,
    expiresAt: new Date((nowSeconds + ttlSeconds) * 1000).toISOString(),
  });
}

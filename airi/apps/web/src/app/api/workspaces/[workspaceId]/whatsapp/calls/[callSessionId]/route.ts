import { randomUUID } from "crypto";
import connectDB from "@/lib/mongoose";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import {
  signalWhatsAppCallCommandWorkflow,
  signalWithStartWhatsAppCallWorkflow,
} from "@/lib/temporal/whatsapp-call-client";
import WhatsAppCallCommand from "@/models/whatsapp-call-command";
import WhatsAppCallSession from "@/models/whatsapp-call-session";
import type {
  WhatsAppCallCommandAction,
  WhatsAppCallLifecycleState,
} from "@icecore/temporal";
import { NextResponse } from "next/server";
import { z } from "zod";
import { readIdString as stringOrNull } from "@icecore/shared/lib/value-utils";

type Params = Promise<{ workspaceId: string; callSessionId: string }>;

const CallCommandBodySchema = z.object({
  action: z.enum(["pre_accept", "accept", "reject", "terminate"]),
  sdp: z.string().trim().min(1).optional(),
});

type LeanWhatsAppCallSession = {
  _id?: unknown;
  workspaceId?: string | null;
  sourceId?: string | null;
  callId?: string | null;
  state?: string | null;
  conversationId?: unknown;
  phoneNumberId?: string | null;
  sessionSdp?: string | null;
  sessionSdpType?: string | null;
  latestEvent?: string | null;
  latestStatus?: string | null;
  contactName?: string | null;
  contactUsername?: string | null;
  lastProviderUpdateAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

function serializeCallSession(session: LeanWhatsAppCallSession) {
  return {
    _id: session._id != null ? String(session._id) : "",
    state: session.state || "unknown",
    latestEvent: session.latestEvent || null,
    latestStatus: session.latestStatus || null,
    contactName: session.contactName || null,
    contactUsername: session.contactUsername || null,
    lastProviderUpdateAt: session.lastProviderUpdateAt || null,
    updatedAt: session.updatedAt || null,
  };
}

function normalizeCallState(value: unknown): WhatsAppCallLifecycleState {
  switch (value) {
    case "incoming":
    case "pre_accepted":
    case "accepted":
    case "ringing":
    case "active":
    case "terminated":
    case "missed":
    case "failed":
      return value;
    default:
      return "unknown";
  }
}

export async function POST(request: Request, { params }: { params: Params }) {
  const { workspaceId, callSessionId } = await params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) {
    return access.response;
  }

  let body: z.infer<typeof CallCommandBodySchema>;
  try {
    body = CallCommandBodySchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "Invalid call command" },
      { status: 400 }
    );
  }

  await connectDB();
  const session = await WhatsAppCallSession.findOne({
    _id: callSessionId,
    workspaceId,
  })
    .lean<LeanWhatsAppCallSession | null>()
    .exec();

  if (!session?._id || !session.callId) {
    return NextResponse.json(
      { error: "Call session not found" },
      { status: 404 }
    );
  }

  if (!session.sourceId) {
    return NextResponse.json(
      { error: "Call session is missing source credentials" },
      { status: 409 }
    );
  }

  const correlationId = randomUUID();
  const command = await WhatsAppCallCommand.create({
    workspaceId,
    sourceId: session.sourceId,
    callSessionId,
    callId: session.callId,
    action: body.action,
    status: "pending",
    requestedBy: access.userId,
    correlationId,
    request: {
      hasSdp: Boolean(body.sdp),
    },
  });

  try {
    const workflow = await signalWithStartWhatsAppCallWorkflow({
      workspaceId,
      sourceId: session.sourceId,
      callSessionId,
      callId: session.callId,
      conversationId: stringOrNull(session.conversationId),
      phoneNumberId: session.phoneNumberId || null,
      state: normalizeCallState(session.state),
      sessionSdp: session.sessionSdp || null,
      sessionSdpType: session.sessionSdpType || null,
      receivedAt: new Date().toISOString(),
    });
    await signalWhatsAppCallCommandWorkflow({
      workflowId: workflow.workflowId,
      command: {
        commandId: String(command._id),
        workspaceId,
        callSessionId,
        callId: session.callId,
        action: body.action as WhatsAppCallCommandAction,
        sdp: body.sdp || null,
        requestedAt: new Date().toISOString(),
      },
    });

    return NextResponse.json(
      {
        success: true,
        workflowId: workflow.workflowId,
        command: {
          id: String(command._id),
          action: body.action,
          status: "pending",
          correlationId,
        },
        whatsapp_call_session: serializeCallSession(session),
      },
      { status: 202 }
    );
  } catch (error) {
    await WhatsAppCallCommand.updateOne(
      { _id: command._id },
      {
        $set: {
          status: "failed",
          providerError: {
            type: "temporal_dispatch_failed",
            message:
              error instanceof Error
                ? error.message
                : "Failed to dispatch WhatsApp call command",
          },
          failedAt: new Date(),
        },
      }
    );
    return NextResponse.json(
      { error: "Failed to dispatch WhatsApp call command" },
      { status: 502 }
    );
  }
}

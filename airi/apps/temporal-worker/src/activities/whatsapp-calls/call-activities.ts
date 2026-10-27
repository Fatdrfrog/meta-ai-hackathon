import {
  WHATSAPP_CALL_EMIT_REALTIME_ACTIVITY,
  WHATSAPP_CALL_CREATE_COMMAND_ACTIVITY,
  WHATSAPP_CALL_LOAD_SESSION_ACTIVITY,
  WHATSAPP_CALL_MARK_COMMAND_ACTIVITY,
  WHATSAPP_CALL_PREPARE_MEDIA_ACTIVITY,
  WHATSAPP_CALL_SEND_COMMAND_ACTIVITY,
  type WhatsAppCallCreateCommandActivityInput,
  type WhatsAppCallCreateCommandActivityResult,
  type WhatsAppCallEmitRealtimeActivityInput,
  type WhatsAppCallEmitRealtimeActivityResult,
  type WhatsAppCallLifecycleState,
  type WhatsAppCallLoadSessionActivityInput,
  type WhatsAppCallLoadSessionActivityResult,
  type WhatsAppCallMarkCommandActivityInput,
  type WhatsAppCallMarkCommandActivityResult,
  type WhatsAppCallPrepareMediaActivityInput,
  type WhatsAppCallPrepareMediaActivityResult,
  type WhatsAppCallSendCommandActivityInput,
  type WhatsAppCallSendCommandActivityResult,
} from "@icecore/temporal";
import {
  airiWorkerLogger,
  compactLogText,
} from "@icecore/airi-runtime/logging";
import {
  acceptWhatsAppCall,
  preAcceptWhatsAppCall,
  rejectWhatsAppCall,
  terminateWhatsAppCall,
} from "@icecore/airi-runtime/whatsapp-calling-service";
import { getWhatsAppCallMediaReadiness } from "@icecore/shared/lib/whatsapp/calling-media-readiness";
import { heartbeat } from "@temporalio/activity";
import { readIdString as stringOrNull } from "@icecore/shared/lib/value-utils";

type LeanCallSession = {
  _id?: unknown;
  workspaceId?: string | null;
  sourceId?: string | null;
  callId?: string | null;
  state?: WhatsAppCallLifecycleState | null;
  conversationId?: unknown;
  phoneNumberId?: string | null;
  sessionSdp?: string | null;
  sessionSdpType?: string | null;
};

type LeanCallCommand = {
  _id?: unknown;
  workspaceId?: string | null;
  sourceId?: string | null;
  callSessionId?: unknown;
  callId?: string | null;
  action?: WhatsAppCallSendCommandActivityInput["action"] | null;
  status?: string | null;
  correlationId?: string | null;
};

type SourceRow = {
  id?: string | null;
  workspace_id?: string | null;
  credentials?: unknown;
};

type WhatsAppCallWorkflowFailureStage = "prepare_media" | "command";

function normalizeCallState(value: unknown): WhatsAppCallLifecycleState {
  const normalized = stringOrNull(value);
  switch (normalized) {
    case "incoming":
    case "pre_accepted":
    case "accepted":
    case "ringing":
    case "active":
    case "terminated":
    case "missed":
    case "failed":
      return normalized;
    default:
      return "unknown";
  }
}

function actionRequiresSdp(
  action: WhatsAppCallSendCommandActivityInput["action"],
): boolean {
  return action === "pre_accept" || action === "accept";
}

function compactProviderError(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error) return compactLogText(error.message);
  if (typeof error === "object" && "message" in error) {
    return compactLogText((error as { message?: unknown }).message);
  }
  return compactLogText(error);
}

function logWhatsAppCallWorkflowFailure(params: {
  stage: WhatsAppCallWorkflowFailureStage;
  workspaceId: string;
  sourceId?: string | null;
  callSessionId: string;
  callId: string;
  commandId?: string | null;
  action?: WhatsAppCallSendCommandActivityInput["action"] | null;
  reason: string;
  error?: unknown;
}) {
  airiWorkerLogger.error("whatsapp.call.workflow.failure", undefined, {
    failureStage: params.stage,
    workspaceId: params.workspaceId,
    sourceId: params.sourceId || null,
    callSessionId: params.callSessionId,
    callId: params.callId,
    commandId: params.commandId || null,
    action: params.action || null,
    reason: params.reason,
    errorMessage: compactProviderError(params.error),
  });
}

function shouldLogMediaPreparationFailure(
  reason: WhatsAppCallPrepareMediaActivityResult["reason"],
): boolean {
  return (
    reason === "not_configured" ||
    reason === "source_credentials_incomplete" ||
    reason === "connector_not_accepted"
  );
}

function logMediaPreparationFailure(
  input: WhatsAppCallPrepareMediaActivityInput,
  reason: WhatsAppCallPrepareMediaActivityResult["reason"],
) {
  if (!reason || !shouldLogMediaPreparationFailure(reason)) return;
  logWhatsAppCallWorkflowFailure({
    stage: "prepare_media",
    workspaceId: input.workspaceId,
    sourceId: input.sourceId || null,
    callSessionId: input.callSessionId,
    callId: input.callId,
    reason,
  });
}

function failedCommandResult(
  input: WhatsAppCallSendCommandActivityInput,
  reason: string,
  providerError: unknown,
): WhatsAppCallSendCommandActivityResult {
  logWhatsAppCallWorkflowFailure({
    stage: "command",
    workspaceId: input.workspaceId,
    callSessionId: input.callSessionId,
    callId: input.callId,
    commandId: input.commandId,
    action: input.action,
    reason,
    error: providerError,
  });
  return {
    commandId: input.commandId,
    action: input.action,
    status: "failed",
    providerError,
  };
}

async function getConnectDb() {
  const module = await import("@/lib/mongoose");
  return module.default;
}

export async function loadWhatsAppCallSessionActivity(
  input: WhatsAppCallLoadSessionActivityInput,
): Promise<WhatsAppCallLoadSessionActivityResult> {
  heartbeat({ callId: input.callId, phase: "load_session" });
  const connectDB = await getConnectDb();
  const { default: WhatsAppCallSession } = await import(
    "@/models/whatsapp-call-session"
  );

  await connectDB();
  const session = await WhatsAppCallSession.findOne({
    _id: input.callSessionId,
    workspaceId: input.workspaceId,
    callId: input.callId,
  })
    .lean<LeanCallSession | null>()
    .exec();

  if (!session) {
    return {
      exists: false,
      state: "unknown",
      conversationId: null,
      phoneNumberId: null,
      sessionSdp: null,
      sessionSdpType: null,
    };
  }

  return {
    exists: true,
    state: normalizeCallState(session.state),
    conversationId: stringOrNull(session.conversationId),
    phoneNumberId: session.phoneNumberId || null,
    sessionSdp: session.sessionSdp || null,
    sessionSdpType: session.sessionSdpType || null,
  };
}

export async function prepareWhatsAppCallMediaActivity(
  input: WhatsAppCallPrepareMediaActivityInput,
): Promise<WhatsAppCallPrepareMediaActivityResult> {
  heartbeat({ callId: input.callId, phase: "prepare_media" });
  if (!input.sourceId) {
    return {
      mediaReady: false,
      roomName: null,
      connectorSessionId: null,
      sdpAnswer: null,
      reason: "source_media_disabled",
    };
  }
  const source = await loadSourceRow({
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
  });
  if (!source) {
    return {
      mediaReady: false,
      roomName: null,
      connectorSessionId: null,
      sdpAnswer: null,
      reason: "source_media_disabled",
    };
  }
  const sourceReadiness = getWhatsAppCallMediaReadiness(source.credentials);
  if (!sourceReadiness.enabled) {
    return {
      mediaReady: false,
      roomName: null,
      connectorSessionId: null,
      sdpAnswer: null,
      reason:
        sourceReadiness.reason === "source_calls_not_enabled"
          ? "source_calls_not_enabled"
          : "source_media_disabled",
    };
  }
  const { normalizeWhatsAppCredentials } = await import(
    "@/lib/whatsapp/credentials"
  );
  const credentials = normalizeWhatsAppCredentials(source.credentials);

  type LiveKitAdapterModule = typeof import("@/lib/calling/livekit-adapter");
  const liveKitModule = (await import("@/lib/calling/livekit-adapter")) as
    | Partial<LiveKitAdapterModule>
    | {
        default?: Partial<LiveKitAdapterModule>;
        "module.exports"?: Partial<LiveKitAdapterModule>;
      };
  const liveKitAdapter =
    "createWhatsAppCallRoom" in liveKitModule &&
    typeof liveKitModule.createLiveKitConnectorClient === "function" &&
    typeof liveKitModule.createWhatsAppCallRoom === "function" &&
    typeof liveKitModule.resolveLiveKitCallingConfigFromEnv === "function"
      ? liveKitModule
      : "default" in liveKitModule && liveKitModule.default
        ? liveKitModule.default
        : "module.exports" in liveKitModule
          ? liveKitModule["module.exports"]
          : null;
  if (
    !liveKitAdapter ||
    typeof liveKitAdapter.createLiveKitConnectorClient !== "function" ||
    typeof liveKitAdapter.createWhatsAppCallRoom !== "function" ||
    typeof liveKitAdapter.resolveLiveKitCallingConfigFromEnv !== "function"
  ) {
    throw new Error("LiveKit WhatsApp call adapter is unavailable.");
  }
  const {
    createLiveKitConnectorClient,
    createWhatsAppCallRoom,
    resolveLiveKitCallingConfigFromEnv,
  } = liveKitAdapter;
  const liveKit = resolveLiveKitCallingConfigFromEnv();
  if (!liveKit) {
    logMediaPreparationFailure(input, "not_configured");
    return {
      mediaReady: false,
      roomName: null,
      connectorSessionId: null,
      sdpAnswer: null,
      reason: "not_configured",
    };
  }

  if (!credentials.phoneNumberId || !credentials.accessToken) {
    logMediaPreparationFailure(input, "source_credentials_incomplete");
    return {
      mediaReady: false,
      roomName: null,
      connectorSessionId: null,
      sdpAnswer: null,
      reason: "source_credentials_incomplete",
    };
  }

  const room = await createWhatsAppCallRoom({
    workspaceId: input.workspaceId,
    callId: input.callId,
    whatsappSdpOffer: input.sessionSdp,
    whatsappPhoneNumberId: credentials.phoneNumberId,
    whatsappApiKey: credentials.accessToken,
    liveKit,
    client: createLiveKitConnectorClient(liveKit),
  });
  const reason: WhatsAppCallPrepareMediaActivityResult["reason"] | null =
    room.acceptedByConnector || room.sdpAnswer
      ? null
      : "connector_not_accepted";
  logMediaPreparationFailure(input, reason);

  return {
    mediaReady: Boolean(room.acceptedByConnector || room.sdpAnswer),
    roomName: room.roomName,
    connectorSessionId: room.connectorSessionId,
    sdpAnswer: room.sdpAnswer,
    providerAccepted: room.acceptedByConnector,
    reason,
  };
}

export async function createWhatsAppCallCommandActivity(
  input: WhatsAppCallCreateCommandActivityInput,
): Promise<WhatsAppCallCreateCommandActivityResult> {
  heartbeat({
    callId: input.callId,
    correlationId: input.correlationId,
    phase: "create_command",
  });
  const connectDB = await getConnectDb();
  const { default: WhatsAppCallCommand } = await import(
    "@/models/whatsapp-call-command"
  );

  await connectDB();
  const command = await WhatsAppCallCommand.findOneAndUpdate(
    {
      workspaceId: input.workspaceId,
      correlationId: input.correlationId,
    },
    {
      $setOnInsert: {
        workspaceId: input.workspaceId,
        sourceId: input.sourceId || null,
        callSessionId: input.callSessionId,
        callId: input.callId,
        action: input.action,
        status: "pending",
        requestedBy: input.requestedBy || null,
        correlationId: input.correlationId,
        request: input.request || null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )
    .lean<LeanCallCommand | null>()
    .exec();

  const commandId = stringOrNull(command?._id);
  if (!commandId) {
    throw new Error("Failed to create WhatsApp call command.");
  }

  return {
    commandId,
    status:
      command?.status === "sent" || command?.status === "failed"
        ? command.status
        : "pending",
    correlationId: input.correlationId,
  };
}

async function loadCommandAndSession(
  input: WhatsAppCallSendCommandActivityInput,
) {
  const connectDB = await getConnectDb();
  const { default: WhatsAppCallCommand } = await import(
    "@/models/whatsapp-call-command"
  );
  const { default: WhatsAppCallSession } = await import(
    "@/models/whatsapp-call-session"
  );

  await connectDB();
  const command = await WhatsAppCallCommand.findOne({
    _id: input.commandId,
    workspaceId: input.workspaceId,
    callSessionId: input.callSessionId,
    callId: input.callId,
  })
    .lean<LeanCallCommand | null>()
    .exec();

  const session = await WhatsAppCallSession.findOne({
    _id: input.callSessionId,
    workspaceId: input.workspaceId,
    callId: input.callId,
  })
    .lean<LeanCallSession | null>()
    .exec();

  return { command, session };
}

async function loadSourceRow(params: {
  workspaceId: string;
  sourceId: string;
}): Promise<SourceRow | null> {
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { data: source, error } = await supabaseAdmin
    .from("sources")
    .select("id,workspace_id,credentials")
    .eq("id", params.sourceId)
    .eq("workspace_id", params.workspaceId)
    .maybeSingle<SourceRow>();

  if (error) {
    throw new Error(`Failed to load WhatsApp source: ${error.message}`);
  }

  return source || null;
}

async function loadSourceCredentials(params: {
  workspaceId: string;
  sourceId: string;
}) {
  const source = await loadSourceRow(params);
  if (!source) {
    throw new Error("WhatsApp source not found for call command.");
  }

  const { normalizeWhatsAppCredentials } = await import(
    "@/lib/whatsapp/credentials"
  );
  return normalizeWhatsAppCredentials(source.credentials);
}

async function sendProviderCommand(params: {
  input: WhatsAppCallSendCommandActivityInput;
  phoneNumberId: string;
  accessToken: string;
  messagingAccountId?: string;
  correlationId: string;
}) {
  const account = {
    phoneNumberId: params.phoneNumberId,
    accessToken: params.accessToken,
    messagingAccountId: params.messagingAccountId,
    callId: params.input.callId,
    correlationId: params.correlationId,
  };
  switch (params.input.action) {
    case "pre_accept":
      return preAcceptWhatsAppCall({
        ...account,
        sdp: params.input.sdp || "",
      });
    case "accept":
      return acceptWhatsAppCall({
        ...account,
        sdp: params.input.sdp || "",
      });
    case "reject":
      return rejectWhatsAppCall(account);
    case "terminate":
      return terminateWhatsAppCall(account);
  }
}

export async function sendWhatsAppCallCommandActivity(
  input: WhatsAppCallSendCommandActivityInput,
): Promise<WhatsAppCallSendCommandActivityResult> {
  heartbeat({
    callId: input.callId,
    commandId: input.commandId,
    phase: "send",
  });
  const { command, session } = await loadCommandAndSession(input);

  if (!command) {
    return failedCommandResult(input, "command_not_found", {
      message: "Call command not found.",
    });
  }
  if (command.status === "sent") {
    return {
      commandId: input.commandId,
      action: input.action,
      status: "sent",
      providerResponse: { skipped: "already_sent" },
    };
  }
  if (actionRequiresSdp(input.action) && !input.sdp?.trim()) {
    return failedCommandResult(input, "sdp_not_ready", {
      message: "SDP answer is not ready for this WhatsApp call action.",
    });
  }

  const sourceId = command.sourceId || session?.sourceId || null;
  if (!sourceId) {
    return failedCommandResult(input, "source_not_found", {
      message: "Call command is missing source credentials.",
    });
  }

  const credentials = await loadSourceCredentials({
    workspaceId: input.workspaceId,
    sourceId,
  });
  const phoneNumberId = session?.phoneNumberId || credentials.phoneNumberId;
  if (!phoneNumberId || !credentials.accessToken) {
    return failedCommandResult(input, "source_credentials_incomplete", {
      message: "WhatsApp source credentials are incomplete.",
    });
  }

  const result = await sendProviderCommand({
    input,
    phoneNumberId,
    accessToken: credentials.accessToken,
    messagingAccountId: credentials.messagingAccountId,
    correlationId: command.correlationId || input.commandId,
  });

  if (!result.success) {
    return failedCommandResult(input, "provider_failed", result.error);
  }

  return {
    commandId: input.commandId,
    action: input.action,
    status: "sent",
    providerResponse: result.data.response,
  };
}

export async function markWhatsAppCallCommandActivity(
  input: WhatsAppCallMarkCommandActivityInput,
): Promise<WhatsAppCallMarkCommandActivityResult> {
  heartbeat({ commandId: input.commandId, phase: "mark_command" });
  const connectDB = await getConnectDb();
  const { default: WhatsAppCallCommand } = await import(
    "@/models/whatsapp-call-command"
  );

  await connectDB();
  await WhatsAppCallCommand.updateOne(
    { _id: input.commandId },
    {
      $set:
        input.status === "sent"
          ? {
              status: "sent",
              providerResponse: input.providerResponse || null,
              providerError: null,
              sentAt: new Date(),
            }
          : {
              status: "failed",
              providerResponse: null,
              providerError: input.providerError || null,
              failedAt: new Date(),
            },
    },
  ).exec();

  return {
    commandId: input.commandId,
    status: input.status,
  };
}

export async function emitWhatsAppCallRealtimeActivity(
  input: WhatsAppCallEmitRealtimeActivityInput,
): Promise<WhatsAppCallEmitRealtimeActivityResult> {
  heartbeat({ callSessionId: input.callSessionId, phase: "emit_realtime" });
  const { emitConversationCallUpdatedRealtimeEvent } = await import(
    "@/lib/realtime/server"
  );
  await emitConversationCallUpdatedRealtimeEvent({
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    callSessionId: input.callSessionId,
    state: input.state,
    reason: input.reason || undefined,
    dedupeKeySuffix: input.dedupeKeySuffix || undefined,
  });
  return { emitted: true };
}

export const whatsappCallActivityHandlers = {
  [WHATSAPP_CALL_LOAD_SESSION_ACTIVITY]: loadWhatsAppCallSessionActivity,
  [WHATSAPP_CALL_PREPARE_MEDIA_ACTIVITY]: prepareWhatsAppCallMediaActivity,
  [WHATSAPP_CALL_CREATE_COMMAND_ACTIVITY]: createWhatsAppCallCommandActivity,
  [WHATSAPP_CALL_SEND_COMMAND_ACTIVITY]: sendWhatsAppCallCommandActivity,
  [WHATSAPP_CALL_MARK_COMMAND_ACTIVITY]: markWhatsAppCallCommandActivity,
  [WHATSAPP_CALL_EMIT_REALTIME_ACTIVITY]: emitWhatsAppCallRealtimeActivity,
};

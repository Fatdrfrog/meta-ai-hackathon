import {
  WHATSAPP_CALL_COMMAND_SIGNAL,
  WHATSAPP_CALL_SESSION_EVENT_SIGNAL,
  WHATSAPP_CALL_WORKFLOW,
  WHATSAPP_CALL_WORKFLOW_CONTRACT_VERSION,
  buildWhatsAppCallWorkflowId,
  type WhatsAppCallCommandAction,
  type WhatsAppCallCommandSignal,
  type WhatsAppCallLifecycleState,
  type WhatsAppCallSessionSignal,
  type WhatsAppCallWorkflowInput,
} from "@icecore/temporal";

import { getTemporalClient, getTemporalWebClientConfig } from "./client";

export type WhatsAppCallSessionSignalInput = {
  workspaceId: string;
  sourceId?: string | null;
  callSessionId: string;
  callId: string;
  conversationId?: string | null;
  phoneNumberId?: string | null;
  state: WhatsAppCallLifecycleState;
  sessionSdp?: string | null;
  sessionSdpType?: string | null;
  receivedAt?: string | null;
};

export type WhatsAppCallCommandSignalInput = {
  commandId: string;
  workspaceId: string;
  callSessionId: string;
  callId: string;
  action: WhatsAppCallCommandAction;
  sdp?: string | null;
  requestedAt?: string | null;
};

export function buildWhatsAppCallSessionSignal(
  input: WhatsAppCallSessionSignalInput
): WhatsAppCallSessionSignal {
  return {
    contractVersion: WHATSAPP_CALL_WORKFLOW_CONTRACT_VERSION,
    workspaceId: input.workspaceId,
    sourceId: input.sourceId || null,
    callSessionId: input.callSessionId,
    callId: input.callId,
    conversationId: input.conversationId || null,
    phoneNumberId: input.phoneNumberId || null,
    state: input.state,
    sessionSdp: input.sessionSdp || null,
    sessionSdpType: input.sessionSdpType || null,
    receivedAt: input.receivedAt || null,
  };
}

export function buildWhatsAppCallCommandSignal(
  input: WhatsAppCallCommandSignalInput
): WhatsAppCallCommandSignal {
  return {
    contractVersion: WHATSAPP_CALL_WORKFLOW_CONTRACT_VERSION,
    commandId: input.commandId,
    workspaceId: input.workspaceId,
    callSessionId: input.callSessionId,
    callId: input.callId,
    action: input.action,
    sdp: input.sdp || null,
    requestedAt: input.requestedAt || null,
  };
}

export function buildWhatsAppCallWorkflowInput(params: {
  workflowId: string;
  signal: WhatsAppCallSessionSignal;
}): WhatsAppCallWorkflowInput {
  return {
    contractVersion: WHATSAPP_CALL_WORKFLOW_CONTRACT_VERSION,
    workflowId: params.workflowId,
    workspaceId: params.signal.workspaceId,
    sourceId: params.signal.sourceId || null,
    callSessionId: params.signal.callSessionId,
    callId: params.signal.callId,
    conversationId: params.signal.conversationId || null,
    phoneNumberId: params.signal.phoneNumberId || null,
    startedAt: params.signal.receivedAt || new Date().toISOString(),
    initialSession: params.signal,
  };
}

export async function signalWithStartWhatsAppCallWorkflow(
  input: WhatsAppCallSessionSignalInput
): Promise<{
  workflowId: string;
  taskQueue: string;
}> {
  const client = getTemporalClient();
  const config = getTemporalWebClientConfig();
  const signal = buildWhatsAppCallSessionSignal(input);
  const workflowId = buildWhatsAppCallWorkflowId({
    workspaceId: signal.workspaceId,
    phoneNumberId: signal.phoneNumberId,
    callId: signal.callId,
  });

  await client.workflow.signalWithStart(WHATSAPP_CALL_WORKFLOW, {
    workflowId,
    taskQueue: config.taskQueue,
    args: [
      buildWhatsAppCallWorkflowInput({
        workflowId,
        signal,
      }),
    ],
    signal: WHATSAPP_CALL_SESSION_EVENT_SIGNAL,
    signalArgs: [signal],
  });

  return {
    workflowId,
    taskQueue: config.taskQueue,
  };
}

export async function signalWhatsAppCallCommandWorkflow(params: {
  workflowId: string;
  command: WhatsAppCallCommandSignalInput;
}): Promise<void> {
  const client = getTemporalClient();
  const handle = client.workflow.getHandle(params.workflowId);
  await handle.signal(
    WHATSAPP_CALL_COMMAND_SIGNAL,
    buildWhatsAppCallCommandSignal(params.command)
  );
}

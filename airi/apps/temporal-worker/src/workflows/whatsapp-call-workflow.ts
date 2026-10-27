import {
  assertContractVersion,
  WHATSAPP_CALL_COMMAND_SIGNAL,
  WHATSAPP_CALL_CREATE_COMMAND_ACTIVITY,
  WHATSAPP_CALL_EMIT_REALTIME_ACTIVITY,
  WHATSAPP_CALL_FINALIZE_RECORDING_ACTIVITY,
  WHATSAPP_CALL_LOAD_SESSION_ACTIVITY,
  WHATSAPP_CALL_MARK_COMMAND_ACTIVITY,
  WHATSAPP_CALL_PREPARE_MEDIA_ACTIVITY,
  WHATSAPP_CALL_SEND_COMMAND_ACTIVITY,
  WHATSAPP_CALL_SESSION_EVENT_SIGNAL,
  WHATSAPP_CALL_START_RECORDING_ACTIVITY,
  WHATSAPP_CALL_STATE_QUERY,
  WHATSAPP_CALL_WORKFLOW_CONTRACT_VERSION,
  isTerminalWhatsAppCallState,
  type WhatsAppCallCreateCommandActivityInput,
  type WhatsAppCallCreateCommandActivityResult,
  type WhatsAppCallCommandSignal,
  type WhatsAppCallEmitRealtimeActivityInput,
  type WhatsAppCallEmitRealtimeActivityResult,
  type WhatsAppCallFinalizeRecordingActivityInput,
  type WhatsAppCallFinalizeRecordingActivityResult,
  type WhatsAppCallLifecycleState,
  type WhatsAppCallLoadSessionActivityInput,
  type WhatsAppCallLoadSessionActivityResult,
  type WhatsAppCallMarkCommandActivityInput,
  type WhatsAppCallMarkCommandActivityResult,
  type WhatsAppCallPrepareMediaActivityInput,
  type WhatsAppCallPrepareMediaActivityResult,
  type WhatsAppCallSendCommandActivityInput,
  type WhatsAppCallSendCommandActivityResult,
  type WhatsAppCallSessionSignal,
  type WhatsAppCallStartRecordingActivityInput,
  type WhatsAppCallStartRecordingActivityResult,
  type WhatsAppCallStateQueryResult,
  type WhatsAppCallWorkflowInput,
} from "@icecore/temporal";
import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  patched,
  proxyActivities,
  setHandler,
  setWorkflowOptions,
} from "@temporalio/workflow";

const MAX_SIGNALS_PER_RUN = 500;
const IDLE_CLOSE_TIMEOUT = "12 hours";
const MAX_PROCESSED_COMMAND_IDS = 512;

const sessionEventSignal = defineSignal<[WhatsAppCallSessionSignal]>(
  WHATSAPP_CALL_SESSION_EVENT_SIGNAL,
);
const commandSignal = defineSignal<[WhatsAppCallCommandSignal]>(
  WHATSAPP_CALL_COMMAND_SIGNAL,
);
const stateQuery = defineQuery<WhatsAppCallStateQueryResult>(
  WHATSAPP_CALL_STATE_QUERY,
);

const activities = proxyActivities<{
  [WHATSAPP_CALL_LOAD_SESSION_ACTIVITY]: (
    input: WhatsAppCallLoadSessionActivityInput,
  ) => Promise<WhatsAppCallLoadSessionActivityResult>;
  [WHATSAPP_CALL_PREPARE_MEDIA_ACTIVITY]: (
    input: WhatsAppCallPrepareMediaActivityInput,
  ) => Promise<WhatsAppCallPrepareMediaActivityResult>;
  [WHATSAPP_CALL_CREATE_COMMAND_ACTIVITY]: (
    input: WhatsAppCallCreateCommandActivityInput,
  ) => Promise<WhatsAppCallCreateCommandActivityResult>;
  [WHATSAPP_CALL_SEND_COMMAND_ACTIVITY]: (
    input: WhatsAppCallSendCommandActivityInput,
  ) => Promise<WhatsAppCallSendCommandActivityResult>;
  [WHATSAPP_CALL_MARK_COMMAND_ACTIVITY]: (
    input: WhatsAppCallMarkCommandActivityInput,
  ) => Promise<WhatsAppCallMarkCommandActivityResult>;
  [WHATSAPP_CALL_EMIT_REALTIME_ACTIVITY]: (
    input: WhatsAppCallEmitRealtimeActivityInput,
  ) => Promise<WhatsAppCallEmitRealtimeActivityResult>;
  [WHATSAPP_CALL_START_RECORDING_ACTIVITY]: (
    input: WhatsAppCallStartRecordingActivityInput,
  ) => Promise<WhatsAppCallStartRecordingActivityResult>;
  [WHATSAPP_CALL_FINALIZE_RECORDING_ACTIVITY]: (
    input: WhatsAppCallFinalizeRecordingActivityInput,
  ) => Promise<WhatsAppCallFinalizeRecordingActivityResult>;
}>({
  scheduleToCloseTimeout: "10 minutes",
  startToCloseTimeout: "300s",
  heartbeatTimeout: "30s",
  retry: {
    maximumAttempts: 5,
    initialInterval: "2s",
    backoffCoefficient: 2,
    maximumInterval: "60s",
  },
});

const loadSessionActivity = activities[WHATSAPP_CALL_LOAD_SESSION_ACTIVITY] as (
  input: WhatsAppCallLoadSessionActivityInput,
) => Promise<WhatsAppCallLoadSessionActivityResult>;
const prepareMediaActivity = activities[
  WHATSAPP_CALL_PREPARE_MEDIA_ACTIVITY
] as (
  input: WhatsAppCallPrepareMediaActivityInput,
) => Promise<WhatsAppCallPrepareMediaActivityResult>;
const createCommandActivity = activities[
  WHATSAPP_CALL_CREATE_COMMAND_ACTIVITY
] as (
  input: WhatsAppCallCreateCommandActivityInput,
) => Promise<WhatsAppCallCreateCommandActivityResult>;
const sendCommandActivity = activities[WHATSAPP_CALL_SEND_COMMAND_ACTIVITY] as (
  input: WhatsAppCallSendCommandActivityInput,
) => Promise<WhatsAppCallSendCommandActivityResult>;
const markCommandActivity = activities[WHATSAPP_CALL_MARK_COMMAND_ACTIVITY] as (
  input: WhatsAppCallMarkCommandActivityInput,
) => Promise<WhatsAppCallMarkCommandActivityResult>;
const emitRealtimeActivity = activities[
  WHATSAPP_CALL_EMIT_REALTIME_ACTIVITY
] as (
  input: WhatsAppCallEmitRealtimeActivityInput,
) => Promise<WhatsAppCallEmitRealtimeActivityResult>;
const startRecordingActivity = activities[
  WHATSAPP_CALL_START_RECORDING_ACTIVITY
] as (
  input: WhatsAppCallStartRecordingActivityInput,
) => Promise<WhatsAppCallStartRecordingActivityResult>;
const finalizeRecordingActivity = activities[
  WHATSAPP_CALL_FINALIZE_RECORDING_ACTIVITY
] as (
  input: WhatsAppCallFinalizeRecordingActivityInput,
) => Promise<WhatsAppCallFinalizeRecordingActivityResult>;

function nowIso(): string {
  return new Date().toISOString();
}

function isTerminalCallState(state: WhatsAppCallLifecycleState): boolean {
  return isTerminalWhatsAppCallState(state);
}

function latestProcessedCommandIds(value: Iterable<string>): string[] {
  const ids = Array.from(new Set(value)).filter(Boolean);
  if (ids.length <= MAX_PROCESSED_COMMAND_IDS) return ids;
  return ids.slice(ids.length - MAX_PROCESSED_COMMAND_IDS);
}

function buildInitialState(
  input: WhatsAppCallWorkflowInput,
): WhatsAppCallStateQueryResult {
  const carryoverState = input.carryover?.state || {};
  const initialSession = input.initialSession || null;
  const updatedAt = carryoverState.updatedAt || input.startedAt || nowIso();

  return {
    workflowId: input.workflowId,
    workspaceId: input.workspaceId,
    sourceId:
      carryoverState.sourceId ??
      input.sourceId ??
      initialSession?.sourceId ??
      null,
    callSessionId: input.callSessionId,
    callId: input.callId,
    conversationId:
      carryoverState.conversationId ??
      input.conversationId ??
      initialSession?.conversationId ??
      null,
    phoneNumberId:
      carryoverState.phoneNumberId ??
      input.phoneNumberId ??
      initialSession?.phoneNumberId ??
      null,
    lastSessionState:
      carryoverState.lastSessionState || initialSession?.state || "unknown",
    mediaPrepared: Boolean(carryoverState.mediaPrepared),
    connectorAccepted: Boolean(carryoverState.connectorAccepted),
    connectorSessionId: carryoverState.connectorSessionId || null,
    sdpAnswer: carryoverState.sdpAnswer || null,
    autoPreAcceptCommandId: carryoverState.autoPreAcceptCommandId || null,
    autoPreAcceptStatus: carryoverState.autoPreAcceptStatus || null,
    recordingStartAttempted: Boolean(carryoverState.recordingStartAttempted),
    recordingStarted: Boolean(carryoverState.recordingStarted),
    recordingEgressId: carryoverState.recordingEgressId || null,
    recordingFinalized: Boolean(carryoverState.recordingFinalized),
    transcriptionRequestId: carryoverState.transcriptionRequestId || null,
    transcriptionStatus: carryoverState.transcriptionStatus || null,
    transcriptionPollAttempts: carryoverState.transcriptionPollAttempts || 0,
    pendingSessionSignals: 0,
    pendingCommands: 0,
    processedCommandIds: latestProcessedCommandIds(
      carryoverState.processedCommandIds || [],
    ),
    ended: Boolean(carryoverState.ended),
    updatedAt,
  };
}

function applySessionSignal(
  state: WhatsAppCallStateQueryResult,
  signal: WhatsAppCallSessionSignal,
): void {
  if (
    signal.workspaceId !== state.workspaceId ||
    signal.callId !== state.callId
  ) {
    return;
  }

  state.sourceId = signal.sourceId ?? state.sourceId;
  state.callSessionId = signal.callSessionId || state.callSessionId;
  state.conversationId = signal.conversationId ?? state.conversationId;
  state.phoneNumberId = signal.phoneNumberId ?? state.phoneNumberId;
  state.lastSessionState = signal.state;
  state.ended = isTerminalCallState(signal.state);
  state.updatedAt = signal.receivedAt || nowIso();
}

function shouldPrepareMedia(
  state: WhatsAppCallStateQueryResult,
  signal: WhatsAppCallSessionSignal,
): signal is WhatsAppCallSessionSignal & { sessionSdp: string } {
  return Boolean(
    !state.mediaPrepared &&
      signal.sessionSdp &&
      (signal.state === "incoming" || signal.state === "pre_accepted"),
  );
}

function shouldAutoPreAccept(state: WhatsAppCallStateQueryResult): boolean {
  return Boolean(
    state.lastSessionState === "incoming" &&
      state.mediaPrepared &&
      !state.connectorAccepted &&
      state.sdpAnswer &&
      !state.autoPreAcceptCommandId,
  );
}

function shouldStartRecording(state: WhatsAppCallStateQueryResult): boolean {
  return Boolean(
    state.mediaPrepared &&
      !state.recordingStartAttempted &&
      !state.recordingStarted &&
      !isTerminalCallState(state.lastSessionState),
  );
}

function buildAutoPreAcceptCorrelationId(
  state: WhatsAppCallStateQueryResult,
): string {
  return `auto-pre-accept:${state.callSessionId}`;
}

function buildCarryover(input: {
  state: WhatsAppCallStateQueryResult;
  sessionQueue: WhatsAppCallSessionSignal[];
  commandQueue: WhatsAppCallCommandSignal[];
  processedCommandIds: Set<string>;
  processedCount: number;
}): NonNullable<WhatsAppCallWorkflowInput["carryover"]> {
  return {
    state: {
      ...input.state,
      pendingSessionSignals: 0,
      pendingCommands: 0,
      processedCommandIds: latestProcessedCommandIds(input.processedCommandIds),
    },
    pendingSessionSignals:
      input.sessionQueue.length > 0 ? [...input.sessionQueue] : [],
    pendingCommandSignals:
      input.commandQueue.length > 0 ? [...input.commandQueue] : [],
    processedCommandIds: latestProcessedCommandIds(input.processedCommandIds),
    processedCount: input.processedCount,
  };
}

async function emitCallUpdated(
  state: WhatsAppCallStateQueryResult,
  options: {
    reason?: "session" | "command" | string | null;
    dedupeKeySuffix?: string | null;
  } = {},
): Promise<void> {
  if (!state.conversationId) return;

  await emitRealtimeActivity({
    workspaceId: state.workspaceId,
    conversationId: state.conversationId,
    callSessionId: state.callSessionId,
    state: state.lastSessionState,
    reason: options.reason || null,
    dedupeKeySuffix: options.dedupeKeySuffix || null,
  });
}

export async function whatsappCallWorkflow(
  input: WhatsAppCallWorkflowInput,
): Promise<WhatsAppCallStateQueryResult> {
  assertContractVersion(
    input.contractVersion,
    { exact: WHATSAPP_CALL_WORKFLOW_CONTRACT_VERSION },
    "WhatsApp call workflow",
  );

  const sessionQueue: WhatsAppCallSessionSignal[] = [
    ...(input.carryover?.pendingSessionSignals || []),
  ];
  const commandQueue: WhatsAppCallCommandSignal[] = [
    ...(input.carryover?.pendingCommandSignals || []),
  ];
  const processedCommandIds = new Set<string>(
    input.carryover?.processedCommandIds ||
      input.carryover?.state?.processedCommandIds ||
      [],
  );
  let processedCount = input.carryover?.processedCount || 0;
  let processedThisRun = 0;
  let hydrated = Boolean(input.carryover?.state);

  const state = buildInitialState(input);

  const enqueueSession = (signal: WhatsAppCallSessionSignal) => {
    if (
      signal.contractVersion !== WHATSAPP_CALL_WORKFLOW_CONTRACT_VERSION ||
      signal.workspaceId !== state.workspaceId ||
      signal.callId !== state.callId
    ) {
      return;
    }
    sessionQueue.push(signal);
    state.pendingSessionSignals = sessionQueue.length;
  };

  const enqueueCommand = (command: WhatsAppCallCommandSignal) => {
    if (
      command.contractVersion !== WHATSAPP_CALL_WORKFLOW_CONTRACT_VERSION ||
      command.workspaceId !== state.workspaceId ||
      command.callId !== state.callId ||
      processedCommandIds.has(command.commandId) ||
      commandQueue.some((queued) => queued.commandId === command.commandId)
    ) {
      return;
    }
    commandQueue.push(command);
    state.pendingCommands = commandQueue.length;
  };

  if (input.initialSession) {
    enqueueSession(input.initialSession);
  }

  setHandler(sessionEventSignal, (signal) => {
    enqueueSession(signal);
  });

  setHandler(commandSignal, (command) => {
    enqueueCommand(command);
  });

  setHandler(stateQuery, () => ({
    ...state,
    pendingSessionSignals: sessionQueue.length,
    pendingCommands: commandQueue.length,
    processedCommandIds: latestProcessedCommandIds(processedCommandIds),
  }));

  while (true) {
    if (!hydrated) {
      const loaded = await loadSessionActivity({
        workspaceId: state.workspaceId,
        callSessionId: state.callSessionId,
        callId: state.callId,
      });
      hydrated = true;
      if (loaded.exists) {
        state.lastSessionState = loaded.state;
        state.conversationId = loaded.conversationId ?? state.conversationId;
        state.phoneNumberId = loaded.phoneNumberId ?? state.phoneNumberId;
        state.updatedAt = nowIso();
      }
    }

    while (sessionQueue.length > 0) {
      const session = sessionQueue.shift();
      if (!session) continue;

      applySessionSignal(state, session);

      if (shouldPrepareMedia(state, session)) {
        const media = await prepareMediaActivity({
          workspaceId: state.workspaceId,
          sourceId: state.sourceId,
          callSessionId: state.callSessionId,
          callId: state.callId,
          sessionSdp: session.sessionSdp,
        });
        state.mediaPrepared = media.mediaReady;
        state.connectorAccepted = Boolean(
          media.providerAccepted || state.connectorAccepted,
        );
        state.connectorSessionId = media.connectorSessionId || null;
        state.sdpAnswer = media.sdpAnswer || state.sdpAnswer;
        state.updatedAt = nowIso();
      }

      if (shouldAutoPreAccept(state)) {
        const command = await createCommandActivity({
          workspaceId: state.workspaceId,
          sourceId: state.sourceId,
          callSessionId: state.callSessionId,
          callId: state.callId,
          action: "pre_accept",
          requestedBy: "system",
          correlationId: buildAutoPreAcceptCorrelationId(state),
          request: {
            automatic: true,
            hasSdp: true,
            reason: "incoming_call_media_ready",
          },
        });
        state.autoPreAcceptCommandId = command.commandId;
        state.autoPreAcceptStatus = command.status;

        if (!processedCommandIds.has(command.commandId)) {
          const result = await sendCommandActivity({
            contractVersion: WHATSAPP_CALL_WORKFLOW_CONTRACT_VERSION,
            commandId: command.commandId,
            workspaceId: state.workspaceId,
            callSessionId: state.callSessionId,
            callId: state.callId,
            action: "pre_accept",
            sdp: state.sdpAnswer,
            requestedAt: nowIso(),
          });
          await markCommandActivity(result);
          processedCommandIds.add(command.commandId);
          state.autoPreAcceptStatus = result.status;
          state.processedCommandIds =
            latestProcessedCommandIds(processedCommandIds);
          await emitCallUpdated(state, {
            reason: "command",
            dedupeKeySuffix: command.commandId,
          });
        }

        processedCount += 1;
        processedThisRun += 1;
        state.updatedAt = nowIso();
      }

      if (
        patched("whatsapp-call-recording-egress-start-v1") &&
        shouldStartRecording(state)
      ) {
        const recording = await startRecordingActivity({
          workspaceId: state.workspaceId,
          callSessionId: state.callSessionId,
          callId: state.callId,
          startedAt: nowIso(),
        });
        state.recordingStartAttempted = true;
        state.recordingStarted = Boolean(
          recording.egressStarted || state.recordingStarted,
        );
        state.recordingEgressId = recording.egressId || state.recordingEgressId;
        state.updatedAt = nowIso();
      }

      await emitCallUpdated(state);

      processedCount += 1;
      processedThisRun += 1;
      state.pendingSessionSignals = sessionQueue.length;
    }

    while (commandQueue.length > 0) {
      let command = commandQueue.shift();
      if (!command) continue;
      if (
        !command.sdp &&
        state.sdpAnswer &&
        (command.action === "pre_accept" || command.action === "accept")
      ) {
        command = { ...command, sdp: state.sdpAnswer };
      }

      const result = await sendCommandActivity(command);
      await markCommandActivity(result);
      await emitCallUpdated(state, {
        reason: "command",
        dedupeKeySuffix: command.commandId,
      });
      processedCommandIds.add(command.commandId);
      processedCount += 1;
      processedThisRun += 1;
      state.pendingCommands = commandQueue.length;
      state.processedCommandIds =
        latestProcessedCommandIds(processedCommandIds);
      state.updatedAt = nowIso();
    }

    if (processedThisRun >= MAX_SIGNALS_PER_RUN) {
      await continueAsNew<typeof whatsappCallWorkflow>({
        contractVersion: WHATSAPP_CALL_WORKFLOW_CONTRACT_VERSION,
        workflowId: state.workflowId,
        workspaceId: state.workspaceId,
        sourceId: state.sourceId,
        callSessionId: state.callSessionId,
        callId: state.callId,
        conversationId: state.conversationId,
        phoneNumberId: state.phoneNumberId,
        startedAt: input.startedAt || nowIso(),
        initialSession: null,
        carryover: buildCarryover({
          state,
          sessionQueue,
          commandQueue,
          processedCommandIds,
          processedCount,
        }),
      });
    }

    if (
      isTerminalCallState(state.lastSessionState) &&
      sessionQueue.length === 0 &&
      commandQueue.length === 0
    ) {
      if (
        patched("whatsapp-call-recording-analytics-v1") &&
        !state.recordingFinalized
      ) {
        const finalized = await finalizeRecordingActivity({
          workspaceId: state.workspaceId,
          callSessionId: state.callSessionId,
          callId: state.callId,
          finalizedAt: nowIso(),
        });
        state.recordingFinalized = true;
        state.transcriptionRequestId =
          finalized.transcriptionRequestId || state.transcriptionRequestId;
        state.transcriptionStatus =
          finalized.transcriptStatus || state.transcriptionStatus;
        state.updatedAt = nowIso();
      }
      state.ended = true;
      state.updatedAt = nowIso();
      return state;
    }

    const hasMore = await condition(
      () =>
        sessionQueue.length > 0 ||
        commandQueue.length > 0 ||
        isTerminalCallState(state.lastSessionState),
      IDLE_CLOSE_TIMEOUT,
    );
    if (!hasMore) {
      return state;
    }
  }
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  whatsappCallWorkflow,
);

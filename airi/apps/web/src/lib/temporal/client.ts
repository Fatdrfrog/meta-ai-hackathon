import "server-only";

import {
  assertTemporalTlsApiKey,
  hasTemporalConnectionEnv,
  resolveTemporalConnectionEnv,
} from "@icecore/shared/lib/temporal-connection-env";
import { coerceNonEmptyString as normalizeOptionalString } from "@icecore/shared/lib/value-utils";

import type { AiriAutoReplyParams } from "@icecore/airi-runtime/auto-reply";
import {
  buildAiriConversationTurnSignalFromContext,
  createAiriConversationTurnContext,
} from "@/lib/temporal/airi-turn-context";
import {
  AIRI_CONVERSATION_WORKFLOW_CONTRACT_VERSION,
  AIRI_CONVERSATION_INGEST_EXTERNAL_EVENT_SIGNAL,
  AIRI_CONVERSATION_INGEST_TURN_SIGNAL,
  AIRI_CONVERSATION_WORKFLOW,
  buildAiriConversationWorkflowId,
  type AiriConversationExternalEvent,
  type AiriConversationTurnSignal,
  type AiriConversationWorkflowInput,
  resolveAiriConversationRouting,
} from "@icecore/temporal";
import { loadTemporalClientSdk, type TemporalClientSdk } from "./sdk";
import type {
  TemporalWebClient,
  TemporalWorkflowHandleWithSignaledRunId,
} from "./sdk-types";

export type TemporalWebClientConfig = {
  address: string;
  namespace: string;
  apiKey: string | null;
  tls: boolean;
  target: "local" | "cloud";
  taskQueue: string;
};

type TemporalClientCache = {
  client: TemporalWebClient | null;
  sdk: TemporalClientSdk | null;
};

const globalForTemporalClient = globalThis as typeof globalThis & {
  __temporalWebClientCache?: TemporalClientCache;
};

const temporalClientCache: TemporalClientCache =
  globalForTemporalClient.__temporalWebClientCache ?? {
    client: null,
    sdk: null,
  };

globalForTemporalClient.__temporalWebClientCache = temporalClientCache;

function getTemporalClientSdk(): TemporalClientSdk {
  if (temporalClientCache.sdk) {
    return temporalClientCache.sdk;
  }

  temporalClientCache.sdk = loadTemporalClientSdk();
  return temporalClientCache.sdk;
}

export function isTemporalConfigured(): boolean {
  return hasTemporalConnectionEnv();
}

export function getTemporalWebClientConfig(): TemporalWebClientConfig {
  const connection = resolveTemporalConnectionEnv();
  const taskQueue =
    normalizeOptionalString(process.env.TEMPORAL_TASK_QUEUE) ||
    resolveAiriConversationRouting().taskQueue;

  assertTemporalTlsApiKey(connection);

  return {
    ...connection,
    target: connection.tls ? "cloud" : "local",
    taskQueue,
  };
}

function makeClient(): TemporalWebClient {
  const config = getTemporalWebClientConfig();
  const { Client, Connection } = getTemporalClientSdk();
  const connection = Connection.lazy({
    address: config.address,
    apiKey: config.apiKey || undefined,
    tls: config.tls ? {} : undefined,
  });

  return new Client({
    connection,
    namespace: config.namespace,
  });
}

export function getTemporalClient(): TemporalWebClient {
  if (temporalClientCache.client) {
    return temporalClientCache.client;
  }

  temporalClientCache.client = makeClient();
  return temporalClientCache.client;
}

export function buildAiriConversationTurnSignal(
  params: AiriAutoReplyParams,
  options?: {
    turnContextId?: string | null;
  }
): AiriConversationTurnSignal {
  return buildAiriConversationTurnSignalFromContext({
    autoReplyParams: params,
    turnContextId: normalizeOptionalString(options?.turnContextId),
  });
}

export function buildAiriConversationExternalEventWorkflowInput(
  event: AiriConversationExternalEvent
): AiriConversationWorkflowInput {
  const controlEvent = event.kind === "generative_ai_result" ? null : event;
  return {
    contractVersion: AIRI_CONVERSATION_WORKFLOW_CONTRACT_VERSION,
    workspaceId: event.workspaceId,
    conversationId: event.conversationId,
    sourceId: normalizeOptionalString(controlEvent?.sourceId),
    startedAt:
      normalizeOptionalString(controlEvent?.enqueuedAt) ||
      normalizeOptionalString(controlEvent?.messageDate) ||
      new Date().toISOString(),
    timerWaitMode: "condition_timeout",
  };
}

export type AiriConversationSignalWithStartResult = {
  workflowHandle: TemporalWorkflowHandleWithSignaledRunId | null;
  workflowId: string;
  turnContextId: string;
  taskQueue: string;
  alreadySignaled: boolean;
};

export function resolveAiriConversationWorkflowInactiveReason(
  error: unknown
): "not_found" | "completed" | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/workflow not found/i.test(message)) return "not_found";
  if (/workflow execution already completed/i.test(message)) {
    return "completed";
  }
  return null;
}

export async function signalWithStartAiriConversation(
  params: AiriAutoReplyParams,
  options?: { ingressKey?: string | null }
): Promise<AiriConversationSignalWithStartResult> {
  const ingressKey = normalizeOptionalString(options?.ingressKey);
  const turnContext = await createAiriConversationTurnContext(params, {
    ingressKey,
  });
  if (ingressKey) {
    const { dispatchPersistedAiriConversationIngress } = await import(
      "./airi-conversation-ingress"
    );
    return dispatchPersistedAiriConversationIngress(turnContext);
  }
  const signal = buildAiriConversationTurnSignal(params, {
    turnContextId: turnContext.turnContextId,
  });
  return signalAiriConversationTurn(signal);
}

/** Sends a persisted signal without rebuilding its identity or enqueue timestamp. */
export async function signalAiriConversationTurn(
  signal: AiriConversationTurnSignal
): Promise<AiriConversationSignalWithStartResult> {
  const client = getTemporalClient();
  const routing = resolveAiriConversationRouting(signal);
  const workflowId = buildAiriConversationWorkflowId(signal.conversationId);
  const workflowHandle = await client.connection.withDeadline(
    Date.now() + 10_000,
    () =>
      client.workflow.signalWithStart(AIRI_CONVERSATION_WORKFLOW, {
        workflowId,
        taskQueue: routing.taskQueue,
        args: [
          {
            contractVersion: AIRI_CONVERSATION_WORKFLOW_CONTRACT_VERSION,
            workspaceId: signal.workspaceId,
            conversationId: signal.conversationId,
            sourceId: signal.sourceId,
            startedAt: signal.enqueuedAt,
            timerWaitMode: "condition_timeout",
            initialTurn: signal,
          } satisfies AiriConversationWorkflowInput,
        ],
        signal: AIRI_CONVERSATION_INGEST_TURN_SIGNAL,
        signalArgs: [signal],
      })
  );
  return {
    workflowHandle,
    workflowId: workflowHandle.workflowId,
    turnContextId: signal.turnContextId || "",
    taskQueue: routing.taskQueue,
    alreadySignaled: false,
  };
}

export async function signalWithStartAiriConversationExternalEvent(
  event: AiriConversationExternalEvent
) {
  const client = getTemporalClient();
  const controlEvent = event.kind === "generative_ai_result" ? null : event;
  const routing = resolveAiriConversationRouting({
    workspaceId: event.workspaceId,
    conversationId: event.conversationId,
    sourceId: normalizeOptionalString(controlEvent?.sourceId),
    channel: normalizeOptionalString(controlEvent?.channel),
  });

  return client.workflow.signalWithStart(AIRI_CONVERSATION_WORKFLOW, {
    workflowId: buildAiriConversationWorkflowId(event.conversationId),
    taskQueue: routing.taskQueue,
    args: [buildAiriConversationExternalEventWorkflowInput(event)],
    signal: AIRI_CONVERSATION_INGEST_EXTERNAL_EVENT_SIGNAL,
    signalArgs: [event],
  });
}

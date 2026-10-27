import { createRequire } from "node:module";

import { createLogger } from "@icecore/shared/lib/logger";
import {
  assertTemporalTlsApiKey,
  resolveTemporalConnectionEnv,
  type TemporalConnectionEnv,
} from "@icecore/shared/lib/temporal-connection-env";
import { isWorkflowAlreadyStartedError } from "@icecore/shared/lib/temporal-errors";
import { coerceNonEmptyString as normalizeOptionalString } from "@icecore/shared/lib/value-utils";
import {
  AIRI_CONVERSATION_TASK_QUEUE,
  WHATSAPP_OTP_DELIVERY_WORKFLOW,
  WHATSAPP_OTP_DELIVERY_WORKFLOW_CONTRACT_VERSION,
  WHATSAPP_OTP_DELIVERY_WORKFLOW_EXECUTION_TIMEOUT_MS,
  buildWhatsAppOtpDeliveryWorkflowId,
  type WhatsAppOtpDeliveryWorkflowInput,
} from "@icecore/temporal";

import { redactOtpLikeValues } from "./otp-code";
import type {
  WhatsAppOtpDeliveryMessage,
  WhatsAppOtpEnqueueResult,
} from "./runtime";

const logger = createLogger("otp-runtime");

export type WhatsAppOtpWorkflowStartOptions = {
  workflowId: string;
  taskQueue: string;
  workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY";
  workflowExecutionTimeout: number;
  args: [WhatsAppOtpDeliveryWorkflowInput];
};

export type WhatsAppOtpTemporalStartWorkflow = (
  workflowName: string,
  options: WhatsAppOtpWorkflowStartOptions
) => Promise<unknown>;

/**
 * The part of @temporalio/client this starter calls. The SDK is required at
 * runtime because its declarations pull in the generated @temporalio/proto
 * namespaces, which every program compiling this package (the web app
 * included) would otherwise have to parse. `TConnection` is what
 * `Connection.lazy` returns and `Client` takes; the worker's SDK type-test
 * checks the real SDK against it.
 */
export type OtpTemporalClientSdk<TConnection = unknown> = {
  Client: new (options: { connection: TConnection; namespace: string }) => {
    workflow: { start: WhatsAppOtpTemporalStartWorkflow };
  };
  Connection: {
    lazy(options: {
      address: string;
      apiKey?: string;
      tls?: Record<string, never>;
    }): TConnection;
  };
};

type OtpTemporalClientCache = {
  key: string;
  start: WhatsAppOtpTemporalStartWorkflow;
};

const globalForOtpTemporal = globalThis as typeof globalThis & {
  __otpTemporalClientCache?: OtpTemporalClientCache | null;
};

function getOtpTemporalClientCacheKey({
  address,
  namespace,
  apiKey,
  tls,
}: TemporalConnectionEnv): string {
  return [address, namespace, tls ? "tls" : "plain", apiKey || ""].join("|");
}

export { isWorkflowAlreadyStartedError as isWhatsAppOtpWorkflowAlreadyStartedError };

export function buildWhatsAppOtpDeliveryWorkflowStartOptions(
  message: WhatsAppOtpDeliveryMessage
): WhatsAppOtpWorkflowStartOptions {
  const taskQueue =
    normalizeOptionalString(process.env.TEMPORAL_TASK_QUEUE) ||
    AIRI_CONVERSATION_TASK_QUEUE;
  const input: WhatsAppOtpDeliveryWorkflowInput = {
    contractVersion: WHATSAPP_OTP_DELIVERY_WORKFLOW_CONTRACT_VERSION,
    workspaceId: message.workspaceId,
    challengeId: message.challengeId,
    correlationId: message.correlationId,
  };

  return {
    workflowId: buildWhatsAppOtpDeliveryWorkflowId(message.challengeId),
    taskQueue,
    workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY",
    workflowExecutionTimeout: WHATSAPP_OTP_DELIVERY_WORKFLOW_EXECUTION_TIMEOUT_MS,
    args: [input],
  };
}

async function startWithTemporalClient(
  workflowName: string,
  options: WhatsAppOtpWorkflowStartOptions
): Promise<unknown> {
  const temporalEnv = resolveTemporalConnectionEnv();
  assertTemporalTlsApiKey(temporalEnv);
  const { address, namespace, apiKey, tls } = temporalEnv;

  const cacheKey = getOtpTemporalClientCacheKey(temporalEnv);
  const cached = globalForOtpTemporal.__otpTemporalClientCache;
  if (cached?.key === cacheKey) {
    return cached.start(workflowName, options);
  }

  const { Client, Connection } = createRequire(import.meta.url)(
    "@temporalio/client"
  ) as OtpTemporalClientSdk;
  const connection = Connection.lazy({
    address,
    apiKey: apiKey || undefined,
    tls: tls ? {} : undefined,
  });
  const client = new Client({ connection, namespace });
  const start: WhatsAppOtpTemporalStartWorkflow = (name, startOptions) =>
    client.workflow.start(name, startOptions);
  globalForOtpTemporal.__otpTemporalClientCache = {
    key: cacheKey,
    start,
  };
  return start(workflowName, options);
}

export async function startWhatsAppOtpDeliveryWorkflow(
  message: WhatsAppOtpDeliveryMessage,
  deps?: { startWorkflow?: WhatsAppOtpTemporalStartWorkflow }
): Promise<WhatsAppOtpEnqueueResult> {
  const options = buildWhatsAppOtpDeliveryWorkflowStartOptions(message);
  const startWorkflow = deps?.startWorkflow || startWithTemporalClient;

  try {
    try {
      await startWorkflow(WHATSAPP_OTP_DELIVERY_WORKFLOW, options);
      logger.info("whatsapp.otp.temporal.start", {
        note: "started",
        workspaceId: message.workspaceId,
        challengeId: message.challengeId,
        correlationId: message.correlationId,
        workflowId: options.workflowId,
        taskQueue: options.taskQueue,
      });
    } catch (error) {
      if (!isWorkflowAlreadyStartedError(error)) throw error;
      logger.info("whatsapp.otp.temporal.start", {
        note: "already_started",
        workspaceId: message.workspaceId,
        challengeId: message.challengeId,
        correlationId: message.correlationId,
        workflowId: options.workflowId,
        taskQueue: options.taskQueue,
      });
    }

    return { ok: true, messageId: options.workflowId };
  } catch (error) {
    const errorMessage = redactOtpLikeValues(
      error instanceof Error ? error.message : String(error)
    );
    logger.error("whatsapp.otp.temporal.start", error, {
      note: "start_failed",
      workspaceId: message.workspaceId,
      challengeId: message.challengeId,
      correlationId: message.correlationId,
      workflowId: options.workflowId,
    });
    return {
      ok: false,
      errorMessage,
    };
  }
}

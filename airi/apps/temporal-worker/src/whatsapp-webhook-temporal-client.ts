import {
  WHATSAPP_WEBHOOK_PROCESS_EVENT_SIGNAL,
  WHATSAPP_WEBHOOK_PROCESSOR_WORKFLOW,
  WHATSAPP_WEBHOOK_PROCESSOR_WORKFLOW_CONTRACT_VERSION,
  buildWhatsAppWebhookProcessorWorkflowId,
  type WhatsAppWebhookEventSignal,
} from "@icecore/temporal";
import type { Client, Connection } from "@temporalio/client";
import type { TemporalWorkerConfig } from "./config.js";
import { getTemporalClient } from "./temporal-client.js";

type WebhookTemporalClient = {
  connection: Pick<Connection, "withDeadline">;
  workflow: {
    signalWithStart: (
      ...args: Parameters<Client["workflow"]["signalWithStart"]>
    ) => Promise<unknown>;
  };
};

export async function signalWithStartWhatsAppWebhookProcessor(
  params: {
    config: TemporalWorkerConfig;
    timeoutMs: number;
    event: Omit<WhatsAppWebhookEventSignal, "contractVersion">;
  },
  getClient: (
    config: TemporalWorkerConfig,
  ) => Promise<WebhookTemporalClient> = getTemporalClient,
): Promise<{ workflowId: string }> {
  const deadline = Date.now() + params.timeoutMs;
  const routingKey = params.event.orderingKey || "whatsapp-unknown";
  const workflowId = buildWhatsAppWebhookProcessorWorkflowId(routingKey);
  const client = await getClient(params.config);
  const event: WhatsAppWebhookEventSignal = {
    contractVersion: WHATSAPP_WEBHOOK_PROCESSOR_WORKFLOW_CONTRACT_VERSION,
    ...params.event,
  };

  await client.connection.withDeadline(deadline, () =>
    client.workflow.signalWithStart(WHATSAPP_WEBHOOK_PROCESSOR_WORKFLOW, {
      workflowId,
      taskQueue: params.config.taskQueue,
      args: [
        {
          contractVersion: WHATSAPP_WEBHOOK_PROCESSOR_WORKFLOW_CONTRACT_VERSION,
          routingKey,
          initialEvent: event,
        },
      ],
      signal: WHATSAPP_WEBHOOK_PROCESS_EVENT_SIGNAL,
      signalArgs: [event],
    }),
  );

  return { workflowId };
}

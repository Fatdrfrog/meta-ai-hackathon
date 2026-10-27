import {
  assertContractVersion,
  WHATSAPP_WEBHOOK_PROCESS_EVENT_ACTIVITY,
  WHATSAPP_WEBHOOK_PROCESS_EVENT_SIGNAL,
  WHATSAPP_WEBHOOK_PROCESSOR_WORKFLOW_CONTRACT_VERSION,
  type WhatsAppWebhookEventSignal,
  type WhatsAppWebhookProcessEventActivityInput,
  type WhatsAppWebhookProcessEventActivityResult,
  type WhatsAppWebhookProcessorWorkflowInput,
  type WhatsAppWebhookProcessorWorkflowResult,
} from "@icecore/temporal";
import {
  condition,
  continueAsNew,
  defineSignal,
  log,
  proxyActivities,
  setHandler,
  setWorkflowOptions,
} from "@temporalio/workflow";

const MAX_EVENTS_PER_RUN = 500;
const IDLE_CLOSE_TIMEOUT = "10 minutes";

const processEventSignal = defineSignal<[WhatsAppWebhookEventSignal]>(
  WHATSAPP_WEBHOOK_PROCESS_EVENT_SIGNAL,
);

const activities = proxyActivities<{
  [WHATSAPP_WEBHOOK_PROCESS_EVENT_ACTIVITY]: (
    input: WhatsAppWebhookProcessEventActivityInput,
  ) => Promise<WhatsAppWebhookProcessEventActivityResult>;
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

const processEventActivity = activities[
  WHATSAPP_WEBHOOK_PROCESS_EVENT_ACTIVITY
] as (
  input: WhatsAppWebhookProcessEventActivityInput,
) => Promise<WhatsAppWebhookProcessEventActivityResult>;

function enqueueUnique(
  queue: WhatsAppWebhookEventSignal[],
  seen: Set<string>,
  event: WhatsAppWebhookEventSignal,
) {
  if (!event.eventId || seen.has(event.eventId)) return;
  seen.add(event.eventId);
  queue.push(event);
}

export async function whatsappWebhookProcessorWorkflow(
  input: WhatsAppWebhookProcessorWorkflowInput,
): Promise<WhatsAppWebhookProcessorWorkflowResult> {
  assertContractVersion(
    input.contractVersion,
    { exact: WHATSAPP_WEBHOOK_PROCESSOR_WORKFLOW_CONTRACT_VERSION },
    "WhatsApp webhook workflow",
  );

  const queue: WhatsAppWebhookEventSignal[] = [];
  const seen = new Set<string>();
  let processedCount = input.processedCount || 0;
  let processedThisRun = 0;

  if (input.initialEvent) {
    enqueueUnique(queue, seen, input.initialEvent);
  }

  setHandler(processEventSignal, (event) => {
    enqueueUnique(queue, seen, event);
  });

  while (true) {
    while (queue.length > 0) {
      const event = queue.shift();
      if (!event) continue;
      try {
        await processEventActivity(event);
      } catch (error) {
        seen.delete(event.eventId);
        log.warn("WhatsApp webhook event activity failed after retries", {
          eventId: event.eventId,
          field: event.field,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      processedCount += 1;
      processedThisRun += 1;
    }

    if (processedThisRun >= MAX_EVENTS_PER_RUN) {
      await continueAsNew<typeof whatsappWebhookProcessorWorkflow>({
        contractVersion: WHATSAPP_WEBHOOK_PROCESSOR_WORKFLOW_CONTRACT_VERSION,
        routingKey: input.routingKey,
        initialEvent: null,
        processedCount,
      });
    }

    const hasMore = await condition(() => queue.length > 0, IDLE_CLOSE_TIMEOUT);
    if (!hasMore) {
      return {
        routingKey: input.routingKey,
        processedCount,
      };
    }
  }
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  whatsappWebhookProcessorWorkflow,
);

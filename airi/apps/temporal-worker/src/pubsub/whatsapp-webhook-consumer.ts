import type { Message } from "@google-cloud/pubsub";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  parseWhatsAppWebhookPubSubMessage,
  WHATSAPP_CALL_WEBHOOK_PUBSUB_DEFAULT_SUBSCRIPTION,
  WHATSAPP_FAST_LANE_PUBSUB_DEFAULT_SUBSCRIPTION,
  WHATSAPP_FAST_WEBHOOK_PUBSUB_DEFAULT_SUBSCRIPTION,
  WHATSAPP_WEBHOOK_PROCESSOR_WORKFLOW_CONTRACT_VERSION,
  WHATSAPP_WEBHOOK_PUBSUB_DEFAULT_SUBSCRIPTION,
  type WhatsAppWebhookPubSubMessage,
} from "@icecore/temporal";

import {
  isDurableWhatsAppWebhookEventFailure,
  processStoredWhatsAppWebhookEvent,
  readWhatsAppWebhookEventOrderingState,
} from "../activities/whatsapp-webhook-processor.js";
import {
  createUpstashUsage,
  runInUpstashUsageScope,
  upstashUsageLogFields,
} from "../upstash-usage.js";
import {
  compactEnv,
  createPubSubSubscription,
  getPubSubDeliveryTiming,
  parseEnabledFlag,
} from "./pubsub-consumer-runtime.js";

type WhatsAppWebhookConsumerOptions = {
  enabledEnvName: string;
  projectIdEnvName: string;
  subscriptionEnvName: string;
  maxMessagesEnvName: string;
  defaultSubscription: string;
  defaultMaxMessages: number;
  logName: string;
  createSubscription?: typeof createPubSubSubscription;
  createHandler?: () => (message: Message) => Promise<void>;
};

const FAST_LANE_ENABLED_ENV = "WHATSAPP_FAST_LANE_PUBSUB_ENABLED";
// A burst from one chat arrives a few seconds apart; waiting this long lets
// the fast lane take the next message once the previous one completes.
const FAST_LANE_HEAD_WAIT_MS = 8_000;
// The ordered subscription holds a message while the fast lane processes it,
// so the chat's next message is not released early.
const FOREIGN_CLAIM_WAIT_MS = 20_000;
const ORDERING_POLL_MS = 250;

type OrderingWait = {
  readOrderingState?: typeof readWhatsAppWebhookEventOrderingState;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
};

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFastLaneEnabled(): boolean {
  return parseEnabledFlag(process.env[FAST_LANE_ENABLED_ENV]);
}

export function shouldAckWhatsAppWebhookPubSubError(error: unknown): boolean {
  return isDurableWhatsAppWebhookEventFailure(error);
}

export function getWhatsAppWebhookQueueDelayMs(
  receivedAt: string | null | undefined,
  subscriberStartedAt: number,
): number | null {
  const receivedAtMs = Date.parse(String(receivedAt || ""));
  if (!Number.isFinite(receivedAtMs)) return null;
  return Math.max(0, subscriberStartedAt - receivedAtMs);
}

function getSubscriptionName(options: WhatsAppWebhookConsumerOptions): string {
  return compactEnv(options.subscriptionEnvName) || options.defaultSubscription;
}

function isConsumerEnabled(options: WhatsAppWebhookConsumerOptions): boolean {
  return parseEnabledFlag(process.env[options.enabledEnvName]);
}

function parseMessage(message: Message): WhatsAppWebhookPubSubMessage {
  const raw = message.data.toString("utf8");
  return parseWhatsAppWebhookPubSubMessage(JSON.parse(raw));
}

async function waitWhileClaimed(
  eventId: string,
  maxWaitMs: number,
  wait: OrderingWait,
): Promise<{ waitedMs: number; released: boolean }> {
  const readOrderingState =
    wait.readOrderingState ?? readWhatsAppWebhookEventOrderingState;
  const sleep = wait.sleep ?? sleepFor;
  const now = wait.now ?? Date.now;
  const startedAt = now();
  for (;;) {
    const ordering = await readOrderingState(eventId);
    if (ordering.state !== "claimed") {
      return { waitedMs: now() - startedAt, released: true };
    }
    if (now() - startedAt >= maxWaitMs) {
      return { waitedMs: now() - startedAt, released: false };
    }
    await sleep(wait.pollMs ?? ORDERING_POLL_MS);
  }
}

export function createWhatsAppWebhookPubSubHandler(options: {
  logName: string;
  processEvent?: typeof processStoredWhatsAppWebhookEvent;
  logger?: Pick<typeof airiWorkerLogger, "info" | "warn" | "error">;
  /** Hold the message while another path processes the event. */
  waitForForeignClaim?: OrderingWait & { maxWaitMs: number };
}): (message: Message) => Promise<void> {
  const processEvent =
    options.processEvent || processStoredWhatsAppWebhookEvent;
  const logger = options.logger || airiWorkerLogger;
  return async (message: Message) => {
    let payload: WhatsAppWebhookPubSubMessage | null = null;
    const startedAt = Date.now();
    const deliveryTiming = getPubSubDeliveryTiming(message, startedAt);
    const upstash = createUpstashUsage();
    try {
      const parsed = parseMessage(message);
      payload = parsed;
      const result = await runInUpstashUsageScope(upstash, () =>
        processEvent({
          contractVersion: WHATSAPP_WEBHOOK_PROCESSOR_WORKFLOW_CONTRACT_VERSION,
          eventId: parsed.eventId,
          dedupeKey: parsed.dedupeKey,
          field: parsed.field,
          orderingKey: parsed.orderingKey || "whatsapp-unknown",
          receivedAt: parsed.receivedAt || new Date().toISOString(),
        }),
      );
      const claimWait =
        options.waitForForeignClaim &&
        result.status === "skipped" &&
        result.runtimeCode === "event_already_claimed"
          ? await waitWhileClaimed(
              payload.eventId,
              options.waitForForeignClaim.maxWaitMs,
              options.waitForForeignClaim,
            )
          : null;

      message.ack();
      logger.info(options.logName, {
        note: "processed_direct",
        ...deliveryTiming,
        eventId: payload.eventId,
        field: payload.field,
        runtimeCode: result.runtimeCode || null,
        status: result.status,
        claimWaitMs: claimWait?.waitedMs ?? null,
        claimReleased: claimWait?.released ?? null,
        queueDelayMs: getWhatsAppWebhookQueueDelayMs(
          payload.receivedAt,
          startedAt,
        ),
        durationMs: Date.now() - startedAt,
        ...upstashUsageLogFields(upstash),
      });
    } catch (error) {
      if (shouldAckWhatsAppWebhookPubSubError(error)) {
        message.ack();
        logger.warn(options.logName, {
          note: "durable_failure_acked",
          ...deliveryTiming,
          eventId: payload?.eventId || null,
          field: payload?.field || null,
          queueDelayMs: getWhatsAppWebhookQueueDelayMs(
            payload?.receivedAt,
            startedAt,
          ),
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
          ...upstashUsageLogFields(upstash),
        });
        return;
      }

      logger.error(options.logName, error, {
        note: "message_failed",
        ...deliveryTiming,
        eventId: payload?.eventId || null,
        field: payload?.field || null,
        queueDelayMs: getWhatsAppWebhookQueueDelayMs(
          payload?.receivedAt,
          startedAt,
        ),
        durationMs: Date.now() - startedAt,
        ...upstashUsageLogFields(upstash),
      });
      message.nack();
    }
  };
}

/**
 * Runs a chat's head event straight from the unordered copy of the fast
 * topic. Anything else is left to the ordered subscription, which still
 * delivers every event, so this lane always acks.
 */
export function createWhatsAppFastLaneHandler(
  options: {
    logName: string;
    processEvent?: typeof processStoredWhatsAppWebhookEvent;
    logger?: Pick<typeof airiWorkerLogger, "info" | "warn" | "error">;
    maxHeadWaitMs?: number;
  } & OrderingWait,
): (message: Message) => Promise<void> {
  const processEvent =
    options.processEvent || processStoredWhatsAppWebhookEvent;
  const readOrderingState =
    options.readOrderingState ?? readWhatsAppWebhookEventOrderingState;
  const logger = options.logger || airiWorkerLogger;
  const sleep = options.sleep ?? sleepFor;
  const now = options.now ?? Date.now;
  const maxHeadWaitMs = options.maxHeadWaitMs ?? FAST_LANE_HEAD_WAIT_MS;
  return async (message: Message) => {
    let payload: WhatsAppWebhookPubSubMessage | null = null;
    const startedAt = now();
    const deliveryTiming = getPubSubDeliveryTiming(message, Date.now());
    const upstash = createUpstashUsage();
    let orderingState: string | null = null;
    try {
      const parsed = parseMessage(message);
      payload = parsed;
      for (;;) {
        const ordering = await readOrderingState(parsed.eventId);
        orderingState = ordering.state;
        if (ordering.state === "head") {
          const headWaitMs = now() - startedAt;
          const result = await runInUpstashUsageScope(upstash, () =>
            processEvent({
              contractVersion:
                WHATSAPP_WEBHOOK_PROCESSOR_WORKFLOW_CONTRACT_VERSION,
              eventId: parsed.eventId,
              dedupeKey: parsed.dedupeKey,
              field: parsed.field,
              orderingKey: parsed.orderingKey || "whatsapp-unknown",
              receivedAt: parsed.receivedAt || new Date().toISOString(),
            }),
          );
          logger.info(options.logName, {
            note: "fast_lane_processed",
            ...deliveryTiming,
            eventId: parsed.eventId,
            field: parsed.field,
            runtimeCode: result.runtimeCode || null,
            status: result.status,
            headWaitMs,
            durationMs: now() - startedAt,
            ...upstashUsageLogFields(upstash),
          });
          return;
        }
        if (
          ordering.state !== "waiting" ||
          now() - startedAt >= maxHeadWaitMs
        ) {
          logger.info(options.logName, {
            note: "fast_lane_left_to_ordered",
            ...deliveryTiming,
            eventId: payload.eventId,
            field: payload.field,
            orderingState,
            headWaitMs: now() - startedAt,
          });
          return;
        }
        await sleep(options.pollMs ?? ORDERING_POLL_MS);
      }
    } catch (error) {
      logger.warn(options.logName, {
        note: "fast_lane_failed",
        ...deliveryTiming,
        eventId: payload?.eventId || null,
        field: payload?.field || null,
        orderingState,
        durable: isDurableWhatsAppWebhookEventFailure(error),
        error: error instanceof Error ? error.message : String(error),
        durationMs: now() - startedAt,
        ...upstashUsageLogFields(upstash),
      });
    } finally {
      message.ack();
    }
  };
}

export async function startWhatsAppWebhookPubSubConsumerWithOptions(
  options: WhatsAppWebhookConsumerOptions,
): Promise<() => Promise<void>> {
  if (!isConsumerEnabled(options)) {
    airiWorkerLogger.info(options.logName, { note: "disabled" });
    return async () => undefined;
  }

  const subscriptionName = getSubscriptionName(options);
  const { projectId, subscription } = (
    options.createSubscription ?? createPubSubSubscription
  )({
    projectIdEnvName: options.projectIdEnvName,
    subscriptionName,
    maxMessagesEnvName: options.maxMessagesEnvName,
    defaultMaxMessages: options.defaultMaxMessages,
  });
  const onMessage = options.createHandler
    ? options.createHandler()
    : createWhatsAppWebhookPubSubHandler(options);

  const onError = (error: Error) => {
    airiWorkerLogger.error(options.logName, error, {
      note: "subscription_error",
      subscription: subscriptionName,
    });
  };

  subscription.on("message", onMessage);
  subscription.on("error", onError);

  airiWorkerLogger.info(options.logName, {
    note: "started",
    projectId: projectId || null,
    subscription: subscriptionName,
  });

  return async () => {
    // Close before detaching: the subscription stops pulling, in-flight
    // handlers ack, and nothing is dispatched to a missing listener.
    try {
      await subscription.close();
    } finally {
      subscription.removeListener("message", onMessage);
      subscription.removeListener("error", onError);
    }
  };
}

export async function startWhatsAppWebhookPubSubConsumer(): Promise<
  () => Promise<void>
> {
  return startWhatsAppWebhookPubSubConsumerWithOptions({
    enabledEnvName: "WHATSAPP_WEBHOOK_PUBSUB_ENABLED",
    projectIdEnvName: "WHATSAPP_WEBHOOK_PUBSUB_PROJECT_ID",
    subscriptionEnvName: "WHATSAPP_WEBHOOK_PUBSUB_SUBSCRIPTION",
    maxMessagesEnvName: "WHATSAPP_WEBHOOK_PUBSUB_MAX_MESSAGES",
    defaultSubscription: WHATSAPP_WEBHOOK_PUBSUB_DEFAULT_SUBSCRIPTION,
    defaultMaxMessages: 10,
    logName: "whatsapp.webhook.pubsub.consumer",
  });
}

/**
 * Consumes only customer-originated WhatsApp messages. This lane is isolated
 * from Business App echoes, status updates, and history imports because those
 * workloads are not allowed to delay the manager inbox.
 */
export async function startWhatsAppFastWebhookPubSubConsumer(): Promise<
  () => Promise<void>
> {
  return startWhatsAppWebhookPubSubConsumerWithOptions({
    enabledEnvName: "WHATSAPP_FAST_WEBHOOK_PUBSUB_ENABLED",
    projectIdEnvName: "WHATSAPP_WEBHOOK_PUBSUB_PROJECT_ID",
    subscriptionEnvName: "WHATSAPP_FAST_WEBHOOK_PUBSUB_SUBSCRIPTION",
    maxMessagesEnvName: "WHATSAPP_FAST_WEBHOOK_PUBSUB_MAX_MESSAGES",
    defaultSubscription: WHATSAPP_FAST_WEBHOOK_PUBSUB_DEFAULT_SUBSCRIPTION,
    defaultMaxMessages: 10,
    logName: "whatsapp.fast_webhook.pubsub.consumer",
    createHandler: isFastLaneEnabled()
      ? () =>
          createWhatsAppWebhookPubSubHandler({
            logName: "whatsapp.fast_webhook.pubsub.consumer",
            waitForForeignClaim: { maxWaitMs: FOREIGN_CLAIM_WAIT_MS },
          })
      : undefined,
  });
}

/**
 * Unordered copy of the fast topic, behind WHATSAPP_FAST_LANE_PUBSUB_ENABLED.
 * Takes a chat's head message without waiting for Pub/Sub to rebuild the
 * ordering key of a quiet chat.
 */
export async function startWhatsAppFastLanePubSubConsumer(): Promise<
  () => Promise<void>
> {
  return startWhatsAppWebhookPubSubConsumerWithOptions({
    enabledEnvName: FAST_LANE_ENABLED_ENV,
    projectIdEnvName: "WHATSAPP_WEBHOOK_PUBSUB_PROJECT_ID",
    subscriptionEnvName: "WHATSAPP_FAST_LANE_PUBSUB_SUBSCRIPTION",
    maxMessagesEnvName: "WHATSAPP_FAST_LANE_PUBSUB_MAX_MESSAGES",
    defaultSubscription: WHATSAPP_FAST_LANE_PUBSUB_DEFAULT_SUBSCRIPTION,
    defaultMaxMessages: 20,
    logName: "whatsapp.fast_lane.pubsub.consumer",
    createHandler: () =>
      createWhatsAppFastLaneHandler({
        logName: "whatsapp.fast_lane.pubsub.consumer",
      }),
  });
}

export async function startWhatsAppCallWebhookPubSubConsumer(): Promise<
  () => Promise<void>
> {
  return startWhatsAppWebhookPubSubConsumerWithOptions({
    enabledEnvName: "WHATSAPP_CALL_PUBSUB_ENABLED",
    projectIdEnvName: "WHATSAPP_CALL_PUBSUB_PROJECT_ID",
    subscriptionEnvName: "WHATSAPP_CALL_PUBSUB_SUBSCRIPTION",
    maxMessagesEnvName: "WHATSAPP_CALL_PUBSUB_MAX_MESSAGES",
    defaultSubscription: WHATSAPP_CALL_WEBHOOK_PUBSUB_DEFAULT_SUBSCRIPTION,
    defaultMaxMessages: 50,
    logName: "whatsapp.call.pubsub.consumer",
  });
}

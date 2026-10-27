import { warmWhatsAppWebhookProcessorRuntime } from "../activities/whatsapp-webhook-processor.js";
import {
  startWhatsAppCallWebhookPubSubConsumer,
  startWhatsAppFastLanePubSubConsumer,
  startWhatsAppFastWebhookPubSubConsumer,
  startWhatsAppWebhookPubSubConsumer,
} from "./whatsapp-webhook-consumer.js";
import { startConversationClassificationPubSubConsumer } from "./conversation-classification-consumer.js";
import { startWhatsAppOtpDeliveryConsumer } from "./whatsapp-otp-delivery-consumer.js";
import { startWorkspaceUsagePubSubConsumer } from "./workspace-usage-consumer.js";
import { parseEnabledFlag } from "../runtime-env.js";

type StopConsumer = () => Promise<void>;
type StartConsumer = () => Promise<StopConsumer>;

export type WorkerEventConsumerDependencies = {
  warmWhatsAppWebhookProcessorRuntime: () => Promise<void>;
  startWhatsAppFastWebhookPubSubConsumer: StartConsumer;
  startWhatsAppFastLanePubSubConsumer: StartConsumer;
  startWhatsAppWebhookPubSubConsumer: StartConsumer;
  startWhatsAppCallWebhookPubSubConsumer: StartConsumer;
  startWhatsAppOtpDeliveryConsumer: StartConsumer;
  startWorkspaceUsagePubSubConsumer: StartConsumer;
  startConversationClassificationPubSubConsumer: StartConsumer;
  startRealtimeDispatcher?: (input: {
    signal?: AbortSignal;
    onFatal?(error: Error): void;
  }) => Promise<StopConsumer>;
};

const defaultDependencies: WorkerEventConsumerDependencies = {
  warmWhatsAppWebhookProcessorRuntime,
  startWhatsAppFastWebhookPubSubConsumer,
  startWhatsAppFastLanePubSubConsumer,
  startWhatsAppWebhookPubSubConsumer,
  startWhatsAppCallWebhookPubSubConsumer,
  startWhatsAppOtpDeliveryConsumer,
  startWorkspaceUsagePubSubConsumer,
  startConversationClassificationPubSubConsumer,
  startRealtimeDispatcher: async (input) =>
    (await import("../realtime-dispatcher.js")).startRealtimeDispatcher(input),
};

export async function startWorkerEventConsumers(
  dependencies: WorkerEventConsumerDependencies = defaultDependencies,
  options: {
    signal?: AbortSignal;
    realtimeDispatcherEnabled?: boolean;
    onFatal?(error: Error): void;
  } = {},
): Promise<StopConsumer> {
  await dependencies.warmWhatsAppWebhookProcessorRuntime();

  const stops: StopConsumer[] = [];
  try {
    for (const start of [
      dependencies.startWhatsAppFastWebhookPubSubConsumer,
      dependencies.startWhatsAppFastLanePubSubConsumer,
      dependencies.startWhatsAppWebhookPubSubConsumer,
      dependencies.startWhatsAppCallWebhookPubSubConsumer,
      dependencies.startWhatsAppOtpDeliveryConsumer,
      dependencies.startWorkspaceUsagePubSubConsumer,
      dependencies.startConversationClassificationPubSubConsumer,
    ]) {
      stops.push(await start());
    }
    if (
      options.realtimeDispatcherEnabled ??
      parseEnabledFlag(process.env.REALTIME_DISPATCHER_ENABLED)
    ) {
      if (!dependencies.startRealtimeDispatcher)
        throw new Error("Embedded realtime dispatcher starter is unavailable");
      stops.push(
        await dependencies.startRealtimeDispatcher({
          signal: options.signal,
          onFatal: options.onFatal,
        }),
      );
    }
  } catch (error) {
    await Promise.allSettled([...stops].reverse().map((stop) => stop()));
    throw error;
  }

  let stopping: Promise<void> | null = null;
  const stopAll = (): Promise<void> => {
    stopping ??= Promise.all([...stops].reverse().map((stop) => stop())).then(
      () => undefined,
    );
    return stopping;
  };
  // Stop pulling the moment shutdown starts rather than after every other
  // auxiliary stops, so in-flight messages ack and the rest are nacked
  // before Cloud Run's SIGKILL instead of waiting out their lease.
  const stopOnShutdown = () => {
    void stopAll().catch(() => undefined);
  };
  if (options.signal?.aborted) stopOnShutdown();
  else
    options.signal?.addEventListener("abort", stopOnShutdown, { once: true });

  return stopAll;
}

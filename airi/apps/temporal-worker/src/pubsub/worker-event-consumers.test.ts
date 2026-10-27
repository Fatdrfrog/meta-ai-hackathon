import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  startWorkerEventConsumers,
  type WorkerEventConsumerDependencies,
} from "./worker-event-consumers";

function lifecycleDependencies(
  lifecycle: string[],
): WorkerEventConsumerDependencies {
  const starter = (name: string) => async () => {
    lifecycle.push(`start:${name}`);
    return async () => {
      lifecycle.push(`stop:${name}`);
    };
  };

  return {
    warmWhatsAppWebhookProcessorRuntime: async () => {
      lifecycle.push("warm:whatsapp");
    },
    startWhatsAppFastWebhookPubSubConsumer: starter("whatsapp-fast"),
    startWhatsAppFastLanePubSubConsumer: starter("whatsapp-fast-lane"),
    startWhatsAppWebhookPubSubConsumer: starter("whatsapp-generic"),
    startWhatsAppCallWebhookPubSubConsumer: starter("whatsapp-call"),
    startWhatsAppOtpDeliveryConsumer: starter("whatsapp-otp"),
    startWorkspaceUsagePubSubConsumer: starter("workspace-usage"),
    startConversationClassificationPubSubConsumer: starter("classification"),
  };
}

test("starts classification last and stops it first without changing existing order", async () => {
  const lifecycle: string[] = [];

  const stop = await startWorkerEventConsumers(
    lifecycleDependencies(lifecycle),
  );

  assert.deepEqual(lifecycle, [
    "warm:whatsapp",
    "start:whatsapp-fast",
    "start:whatsapp-fast-lane",
    "start:whatsapp-generic",
    "start:whatsapp-call",
    "start:whatsapp-otp",
    "start:workspace-usage",
    "start:classification",
  ]);

  await stop();

  assert.deepEqual(lifecycle.slice(-7), [
    "stop:classification",
    "stop:workspace-usage",
    "stop:whatsapp-otp",
    "stop:whatsapp-call",
    "stop:whatsapp-generic",
    "stop:whatsapp-fast-lane",
    "stop:whatsapp-fast",
  ]);
});

test("repeated stop calls share one reverse-order shutdown", async () => {
  const lifecycle: string[] = [];
  const stop = await startWorkerEventConsumers(
    lifecycleDependencies(lifecycle),
  );
  lifecycle.length = 0;

  const first = stop();
  const second = stop();
  assert.equal(first, second);
  await Promise.all([first, second]);

  assert.deepEqual(lifecycle, [
    "stop:classification",
    "stop:workspace-usage",
    "stop:whatsapp-otp",
    "stop:whatsapp-call",
    "stop:whatsapp-generic",
    "stop:whatsapp-fast-lane",
    "stop:whatsapp-fast",
  ]);
});

test("starts stopping every consumer as soon as shutdown is signalled", async () => {
  const lifecycle: string[] = [];
  const controller = new AbortController();
  const stop = await startWorkerEventConsumers(
    lifecycleDependencies(lifecycle),
    { signal: controller.signal },
  );
  lifecycle.length = 0;

  controller.abort("worker_shutdown");
  await Promise.resolve();

  assert.deepEqual(lifecycle, [
    "stop:classification",
    "stop:workspace-usage",
    "stop:whatsapp-otp",
    "stop:whatsapp-call",
    "stop:whatsapp-generic",
    "stop:whatsapp-fast-lane",
    "stop:whatsapp-fast",
  ]);

  await stop();
  assert.equal(lifecycle.length, 7);
});

test("stops at once when shutdown began during startup", async () => {
  const lifecycle: string[] = [];
  const controller = new AbortController();
  controller.abort("worker_shutdown");

  await startWorkerEventConsumers(lifecycleDependencies(lifecycle), {
    signal: controller.signal,
  });

  assert.equal(
    lifecycle.filter((entry) => entry.startsWith("stop:")).length,
    7,
  );
});

test("surfaces a consumer stop failure to the later lifecycle stop", async () => {
  const controller = new AbortController();
  const dependencies = lifecycleDependencies([]);
  dependencies.startWorkspaceUsagePubSubConsumer = async () => async () => {
    throw new Error("close failed");
  };
  const stop = await startWorkerEventConsumers(dependencies, {
    signal: controller.signal,
  });

  controller.abort("worker_shutdown");

  await assert.rejects(stop(), /close failed/);
});

test("rolls back every prior consumer when classification startup fails", async () => {
  const lifecycle: string[] = [];
  const dependencies = lifecycleDependencies(lifecycle);
  dependencies.startConversationClassificationPubSubConsumer = async () => {
    lifecycle.push("start:classification");
    throw new Error("classification subscriber failed");
  };

  await assert.rejects(
    startWorkerEventConsumers(dependencies),
    /classification subscriber failed/,
  );

  assert.deepEqual(lifecycle, [
    "warm:whatsapp",
    "start:whatsapp-fast",
    "start:whatsapp-fast-lane",
    "start:whatsapp-generic",
    "start:whatsapp-call",
    "start:whatsapp-otp",
    "start:workspace-usage",
    "start:classification",
    "stop:workspace-usage",
    "stop:whatsapp-otp",
    "stop:whatsapp-call",
    "stop:whatsapp-generic",
    "stop:whatsapp-fast-lane",
    "stop:whatsapp-fast",
  ]);
});

test("rolls back prior consumers when OTP startup fails", async () => {
  const lifecycle: string[] = [];
  const dependencies = lifecycleDependencies(lifecycle);
  dependencies.startWhatsAppOtpDeliveryConsumer = async () => {
    lifecycle.push("start:whatsapp-otp");
    throw new Error("OTP subscriber failed");
  };

  await assert.rejects(
    startWorkerEventConsumers(dependencies),
    /OTP subscriber failed/,
  );

  assert.deepEqual(lifecycle, [
    "warm:whatsapp",
    "start:whatsapp-fast",
    "start:whatsapp-fast-lane",
    "start:whatsapp-generic",
    "start:whatsapp-call",
    "start:whatsapp-otp",
    "stop:whatsapp-call",
    "stop:whatsapp-generic",
    "stop:whatsapp-fast-lane",
    "stop:whatsapp-fast",
  ]);
});

test("preserves the startup error and cleans up all consumers when OTP cleanup fails", async () => {
  const lifecycle: string[] = [];
  const dependencies = lifecycleDependencies(lifecycle);
  dependencies.startWhatsAppOtpDeliveryConsumer = async () => {
    lifecycle.push("start:whatsapp-otp");
    return async () => {
      lifecycle.push("stop:whatsapp-otp");
      throw new Error("OTP subscriber close failed");
    };
  };
  const startupError = new Error("classification subscriber failed");
  dependencies.startConversationClassificationPubSubConsumer = async () => {
    lifecycle.push("start:classification");
    throw startupError;
  };

  await assert.rejects(
    startWorkerEventConsumers(dependencies),
    (error) => error === startupError,
  );

  assert.deepEqual(lifecycle, [
    "warm:whatsapp",
    "start:whatsapp-fast",
    "start:whatsapp-fast-lane",
    "start:whatsapp-generic",
    "start:whatsapp-call",
    "start:whatsapp-otp",
    "start:workspace-usage",
    "start:classification",
    "stop:workspace-usage",
    "stop:whatsapp-otp",
    "stop:whatsapp-call",
    "stop:whatsapp-generic",
    "stop:whatsapp-fast-lane",
    "stop:whatsapp-fast",
  ]);
});

test("rolls back only started consumers and never invokes later starters", async () => {
  const lifecycle: string[] = [];
  const dependencies = lifecycleDependencies(lifecycle);
  dependencies.startWhatsAppWebhookPubSubConsumer = async () => {
    lifecycle.push("start:whatsapp-generic");
    throw new Error("generic subscriber failed");
  };

  await assert.rejects(
    startWorkerEventConsumers(dependencies),
    /generic subscriber failed/,
  );

  assert.deepEqual(lifecycle, [
    "warm:whatsapp",
    "start:whatsapp-fast",
    "start:whatsapp-fast-lane",
    "start:whatsapp-generic",
    "stop:whatsapp-fast-lane",
    "stop:whatsapp-fast",
  ]);
});

test("embedded dispatcher is explicit and participates in startup rollback", async () => {
  const events: string[] = [];
  const dependencies = lifecycleDependencies(events);
  dependencies.startRealtimeDispatcher = async () => {
    events.push("start:dispatcher");
    throw new Error("dispatcher failed");
  };
  const stop = await startWorkerEventConsumers(dependencies, {
    realtimeDispatcherEnabled: false,
  });
  assert.ok(!events.includes("start:dispatcher"));
  await stop();
  events.length = 0;
  await assert.rejects(
    startWorkerEventConsumers(dependencies, {
      realtimeDispatcherEnabled: true,
    }),
    /dispatcher failed/,
  );
  assert.equal(events[8], "start:dispatcher");
  assert.deepEqual(events.slice(-7), [
    "stop:classification",
    "stop:workspace-usage",
    "stop:whatsapp-otp",
    "stop:whatsapp-call",
    "stop:whatsapp-generic",
    "stop:whatsapp-fast-lane",
    "stop:whatsapp-fast",
  ]);
});

test("embedded dispatcher receives the existing worker abort signal and fatal owner", async () => {
  const dependencies = lifecycleDependencies([]);
  const controller = new AbortController();
  const onFatal = () => undefined;
  let received: unknown;
  dependencies.startRealtimeDispatcher = async (input) => {
    received = input;
    return async () => undefined;
  };
  const stop = await startWorkerEventConsumers(dependencies, {
    realtimeDispatcherEnabled: true,
    signal: controller.signal,
    onFatal,
  });
  assert.deepEqual(received, { signal: controller.signal, onFatal });
  await stop();
});

test("worker boot starts Pub/Sub consumers before the Temporal schedule round trips", () => {
  const source = readFileSync(new URL("../worker.ts", import.meta.url), "utf8");
  const start = source.indexOf("const auxiliaryStarters");
  const end = source.indexOf("];", start);
  assert.ok(start !== -1 && end !== -1);
  const starters = source.slice(start, end);

  const optionalWork = starters.indexOf("startWhatsAppOptionalWork(signal)");
  const consumers = starters.indexOf('"worker_event_consumers"');
  assert.ok(optionalWork !== -1 && consumers !== -1);
  // Processing hands AI-reply dispatch to the optional-work executor.
  assert.ok(optionalWork < consumers);
  assert.doesNotMatch(
    starters.slice(optionalWork, consumers),
    /oneShotStarter\(/,
  );

  const schedules = [...starters.matchAll(/oneShotStarter\("([a-z_]+)"/g)];
  assert.deepEqual(
    schedules.map((match) => match[1]),
    [
      "whatsapp_webhook_drain_schedule",
      "cross_store_outbox_drain_schedule",
      "whatsapp_call_transcription_drain_schedule",
      "workspace_usage_repair_schedule",
      "video_generation_reconcile_schedule",
    ],
  );
  for (const schedule of schedules) {
    assert.ok(consumers < schedule.index!, schedule[1]);
  }
});

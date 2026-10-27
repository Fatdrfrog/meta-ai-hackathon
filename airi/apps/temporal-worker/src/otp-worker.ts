import { fileURLToPath } from "node:url";

import { airiWorkerLogger } from "@icecore/airi-runtime/logging";

import { loadTemporalWorkerEnv } from "./load-env.js";
import { startWhatsAppOtpDeliveryConsumer } from "./pubsub/whatsapp-otp-delivery-consumer.js";

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export async function runWhatsAppOtpWorker(): Promise<void> {
  const loadedEnvFiles = loadTemporalWorkerEnv();

  airiWorkerLogger.info("whatsapp.otp.worker.lifecycle", {
    note: "bootstrapping",
    loadedEnvFiles,
  });

  const stopConsumer = await startWhatsAppOtpDeliveryConsumer();

  airiWorkerLogger.info("whatsapp.otp.worker.lifecycle", {
    note: "started",
  });

  try {
    await waitForShutdown();
  } finally {
    await stopConsumer();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runWhatsAppOtpWorker().catch((error) => {
    airiWorkerLogger.error("whatsapp.otp.worker.lifecycle", error, {
      note: "start_failed",
    });
    process.exit(1);
  });
}

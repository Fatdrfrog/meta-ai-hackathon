import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import { configureCacheRuntimePolicy } from "@icecore/shared/lib/cache-runtime-policy";
import { GCP_RUNTIME_CACHE_POLICY } from "./cache-runtime-policy.js";
import { startEventLoopDelayMonitor } from "./event-loop-delay-monitor.js";
import { loadTemporalWorkerEnv } from "./load-env.js";
import { installUpstashUsageTracking } from "./upstash-usage.js";

loadTemporalWorkerEnv();
configureCacheRuntimePolicy(GCP_RUNTIME_CACHE_POLICY);
installUpstashUsageTracking(process.env.UPSTASH_REDIS_REST_URL);

function getRuntimeMode():
  | "worker"
  | "media-worker"
  | "ai-gateway"
  | "otp-worker"
  | "otp-api"
  | "media-api"
  | "realtime-gateway"
  | "realtime-dispatcher" {
  const rawMode = String(process.env.AIRI_RUNTIME_MODE || "worker")
    .trim()
    .toLowerCase();
  if (rawMode === "realtime-gateway") return "realtime-gateway";
  if (rawMode === "realtime-dispatcher") return "realtime-dispatcher";
  if (rawMode === "otp-api") return "otp-api";
  if (rawMode === "otp-worker") return "otp-worker";
  if (rawMode === "media-api") return "media-api";
  if (rawMode === "media-worker") return "media-worker";
  return rawMode === "ai-gateway" ? "ai-gateway" : "worker";
}

const runtimeMode = getRuntimeMode();
startEventLoopDelayMonitor({ runtimeMode });

/**
 * Dynamic imports keep `worker.js` (and activities that pull `@/lib/mongoose`) off the
 * ai-gateway path. Otherwise `MONGODB_URI` is required at import time and gateway crashes
 * before listen() when that secret is not set on the gateway service.
 */
async function run(): Promise<void> {
  if (runtimeMode === "ai-gateway") {
    const { runAIGatewayServer } = await import("./gateway.js");
    await runAIGatewayServer();
    return;
  }
  if (runtimeMode === "otp-worker") {
    const { runWhatsAppOtpWorker } = await import("./otp-worker.js");
    await runWhatsAppOtpWorker();
    return;
  }
  if (runtimeMode === "otp-api") {
    const { runOtpApiServer } = await import("./otp-api.js");
    await runOtpApiServer();
    return;
  }
  if (runtimeMode === "media-api") {
    const { runMediaApiServer } = await import("./media-api.js");
    await runMediaApiServer();
    return;
  }
  if (runtimeMode === "realtime-gateway") {
    const { runRealtimeGatewayServer } = await import("./realtime-gateway.js");
    await runRealtimeGatewayServer();
    return;
  }
  if (runtimeMode === "realtime-dispatcher") {
    const { runRealtimeDispatcher } = await import("./realtime-dispatcher.js");
    await runRealtimeDispatcher();
    return;
  }

  const { runTemporalWorker } = await import("./worker.js");
  await runTemporalWorker();
}

run().catch((error) => {
  airiWorkerLogger.error("airi.worker.lifecycle", error, {
    note:
      runtimeMode === "ai-gateway"
        ? "ai_gateway_start_failed"
        : runtimeMode === "otp-worker"
          ? "otp_worker_start_failed"
          : runtimeMode === "otp-api"
            ? "otp_api_start_failed"
            : runtimeMode === "media-api"
              ? "media_api_start_failed"
              : runtimeMode === "realtime-gateway"
                ? "realtime_gateway_start_failed"
                : runtimeMode === "realtime-dispatcher"
                  ? "realtime_dispatcher_start_failed"
                  : "start_failed",
    runtimeMode,
    deploymentName: process.env.TEMPORAL_WORKER_DEPLOYMENT_NAME?.trim() || null,
    buildId: process.env.TEMPORAL_WORKER_BUILD_ID?.trim() || null,
  });
  process.exit(1);
});

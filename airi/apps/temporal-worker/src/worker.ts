import { startWhatsAppOptionalWork } from "./whatsapp-optional-work.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  AIRI_CONVERSATION_BUILD_TIMER_TURN_ACTIVITY,
  AIRI_CONVERSATION_DELIVER_OUTBOUND_ACTIVITY,
  AIRI_CONVERSATION_FINALIZE_OUTBOUND_ACTIVITY,
  AIRI_CONVERSATION_HANDLE_EXTERNAL_EVENT_ACTIVITY,
  AIRI_CONVERSATION_TERMINALIZE_GENERATIVE_ACK_ACTIVITY,
  AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY,
  AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY,
  AIRI_CONVERSATION_RECORD_TURN_DISPOSITION_ACTIVITY,
  AIRI_CONVERSATION_READ_PROJECTION_ACTIVITY,
  AIRI_COACH_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_ACCEPT_VIDEO_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_ACCEPT_IMAGE_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_BEGIN_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_IMPORT_SOURCE_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_REPORT_RESULT_ACTIVITY,
  AIRI_SCENARIO_GENERATIVE_AI_START_VIDEO_ACTIVITY,
  BILLING_SUBSCRIPTION_CHARGE_ACTIVITY,
  BULK_CAMPAIGN_DISPATCH_BEGIN_ACTIVITY,
  BULK_CAMPAIGN_DISPATCH_FINALIZE_ACTIVITY,
  BULK_CAMPAIGN_DISPATCH_LIFECYCLE_FINALIZE_ACTIVITY,
  BULK_CAMPAIGN_DISPATCH_PROGRESS_ACTIVITY,
  BULK_CAMPAIGN_DISPATCH_SEND_BATCH_ACTIVITY,
  CAMPAIGN_SCHEDULE_RECONCILE_ACTIVITY,
  CAMPAIGN_SCHEDULE_ACTION_CLAIM_ACTIVITY,
  CAMPAIGN_SCHEDULE_ACTION_COMPLETE_ACTIVITY,
  CAMPAIGN_DELIVERY_DRAIN_ACTIVITY,
  CAMPAIGN_EXECUTION_FINALIZE_ACTIVITY,
  CAMPAIGN_NODE_RUN_ACTIVITY,
  CONVERSATION_MEDIA_ANALYSIS_ACTIVITY,
  CONVERSATION_MEDIA_ANALYSIS_COMPLETE_ACTIVITY,
  CONVERSATION_MEDIA_ANALYSIS_FAIL_ACTIVITY,
  CONVERSATION_MEDIA_ANALYSIS_TRIGGER_AIRI_ACTIVITY,
  CROSS_STORE_OUTBOX_DRAIN_ACTIVITY,
  CREATIVE_IMAGE_GENERATION_ACTIVITY,
  CREATIVE_ASSET_FAIL_EDIT_ACTIVITY,
  CREATIVE_ASSET_PROCESS_EDIT_ACTIVITY,
  WAN_AVATAR_FAIL_ACTIVITY,
  WAN_AVATAR_PROCESS_ACTIVITY,
  WAN_MORPH_FAIL_ACTIVITY,
  WAN_MORPH_PROCESS_ACTIVITY,
  HAPPYHORSE_VIDEO_FAIL_ACTIVITY,
  HAPPYHORSE_VIDEO_PROCESS_ACTIVITY,
  CRAWL_WEBSITE_ACTIVITY,
  ELEVENLABS_CREATIVE_TRANSCRIPTION_COMPLETE_ACTIVITY,
  ELEVENLABS_CREATIVE_TRANSCRIPTION_FAIL_ACTIVITY,
  ELEVENLABS_CREATIVE_TRANSCRIPTION_SUBMIT_ACTIVITY,
  HIGGSFIELD_POLL_STATUS_ACTIVITY,
  HIGGSFIELD_PROCESS_WEBHOOK_ACTIVITY,
  HIGGSFIELD_SUBMIT_GENERATION_ACTIVITY,
  KNOWLEDGE_CANONICAL_SYNC_ACTIVITY,
  WIDGET_CSAT_REQUEST_ACTIVITY,
  WIDGET_CSAT_TIMEOUT_ACTIVITY,
  WHATSAPP_CATALOG_IMPORT_BATCH_ACTIVITY,
  WHATSAPP_CALL_CREATE_COMMAND_ACTIVITY,
  WHATSAPP_CALL_EMIT_REALTIME_ACTIVITY,
  WHATSAPP_CALL_FINALIZE_RECORDING_ACTIVITY,
  WHATSAPP_CALL_LOAD_SESSION_ACTIVITY,
  WHATSAPP_CALL_MARK_COMMAND_ACTIVITY,
  WHATSAPP_CALL_POLL_TRANSCRIPTION_ACTIVITY,
  WHATSAPP_CALL_PREPARE_MEDIA_ACTIVITY,
  WHATSAPP_CALL_SEND_COMMAND_ACTIVITY,
  WHATSAPP_CALL_START_RECORDING_ACTIVITY,
  WHATSAPP_CALL_TRANSCRIPTION_DRAIN_ACTIVITY,
  WHATSAPP_WEBHOOK_DRAIN_ACTIVITY,
  WHATSAPP_WEBHOOK_PROCESS_EVENT_ACTIVITY,
  VIDEO_GENERATION_FAIL_ACTIVITY,
  VIDEO_GENERATION_FINALIZE_ACTIVITY,
  VIDEO_GENERATION_POLL_ACTIVITY,
  VIDEO_GENERATION_RECONCILE_ACTIVITY,
  VIDEO_GENERATION_SUBMIT_ACTIVITY,
  WORKSPACE_USAGE_REPAIR_ACTIVITY,
  WHATSAPP_OTP_DELIVER_CHALLENGE_ACTIVITY,
  WHATSAPP_OTP_DELIVERY_WORKFLOW,
} from "@icecore/temporal";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  getWhatsAppOtpDeliveryMode,
  getWhatsAppOtpTemporalWorkspaceAllowlist,
} from "@icecore/otp-runtime";
import { readEnvFlag as parseBooleanEnv } from "@icecore/shared/lib/env";
import { coerceNonEmptyString as normalizeOptionalString } from "@icecore/shared/lib/value-utils";
import { NativeConnection, Runtime, Worker } from "@temporalio/worker";

import "./creative-asset-read-url-gcs-adapter.js";
import {
  buildAiriConversationTimerTurnActivity,
  deliverAiriConversationOutboundActivity,
  finalizeAiriConversationOutboundActivity,
  handleAiriConversationExternalEventActivity,
  planAiriConversationTimerActivity,
  prepareAiriConversationTurn,
  recordAiriConversationTurnDispositionActivity,
  readAiriConversationProjectionActivity,
  terminalizeGenerativeAcknowledgmentActivity,
} from "./activities/airi-auto-reply.js";
import {
  airiCoachActivity,
  widgetCsatRequestActivity,
  widgetCsatTimeoutActivity,
} from "./activities/background-jobs.js";
import { billingSubscriptionChargeActivity } from "./activities/billing-subscription.js";
import {
  beginBulkCampaignDispatchActivity,
  dispatchBulkCampaignBatchActivity,
  finalizeBulkCampaignDispatchActivity,
  finalizeBulkCampaignDispatchLifecycleActivity,
  updateBulkCampaignDispatchProgressActivity,
} from "./activities/bulk-campaign.js";
import { campaignScheduleReconcileActivity } from "./activities/campaign-schedule-reconcile.js";
import { crossStoreOutboxDrainActivity } from "./activities/cross-store-outbox-drain.js";
import {
  campaignScheduleActionClaimActivity,
  campaignScheduleActionCompleteActivity,
} from "./activities/campaign-schedule-action.js";
import {
  campaignDeliveryDrainActivity,
  campaignExecutionFinalizeActivity,
  campaignNodeRunActivity,
} from "./activities/campaign-node-run.js";
import {
  creativeAssetFailEditActivity,
  creativeAssetProcessEditActivity,
} from "./activities/creative-asset-edits.js";
import { creativeImageGenerationActivity } from "./activities/creative-image-generation.js";
import {
  acceptScenarioGenerativeAIVideoActivity,
  acceptScenarioGenerativeAIImageActivity,
  beginScenarioGenerativeAIActivity,
  importScenarioGenerativeAISourceActivity,
  reportScenarioGenerativeAIResultActivity,
  startScenarioGenerativeAIVideoActivity,
} from "./activities/scenario-generative-ai.js";
import {
  conversationMediaAnalysisCompleteActivity,
  conversationMediaAnalysisFailActivity,
  conversationMediaAnalysisProcessActivity,
  conversationMediaAnalysisTriggerAiriActivity,
} from "./activities/conversation-media-analysis.js";
import {
  wanAvatarFailActivity,
  wanAvatarProcessActivity,
} from "./activities/wan-avatar.js";
import {
  wanMorphFailActivity,
  wanMorphProcessActivity,
} from "./activities/wan-morph.js";
import {
  happyHorseVideoFailActivity,
  happyHorseVideoProcessActivity,
} from "./activities/happyhorse-video.js";
import {
  elevenLabsCreativeTranscriptionCompleteActivity,
  elevenLabsCreativeTranscriptionFailActivity,
  elevenLabsCreativeTranscriptionSubmitActivity,
} from "./activities/elevenlabs-creative-transcription.js";
import {
  higgsfieldPollStatusActivity,
  higgsfieldProcessWebhookActivity,
  higgsfieldSubmitGenerationActivity,
} from "./activities/higgsfield-assets.js";
import { crawlWebsiteActivityHandlers } from "./activities/crawl-website.js";
import { knowledgeCanonicalSyncActivityHandlers } from "./activities/knowledge-canonical-sync.js";
import {
  whatsappCallActivityHandlers,
  whatsappCallRecordingActivityHandlers,
} from "./activities/whatsapp-calls/index.js";
import { whatsappCatalogImportBatchActivity } from "./activities/whatsapp-catalog-import.js";
import { whatsappWebhookDrainActivity } from "./activities/whatsapp-webhook-drain.js";
import { whatsappWebhookProcessEventActivity } from "./activities/whatsapp-webhook-processor.js";
import { workspaceUsageRepairActivity } from "./activities/workspace-usage-repair.js";
import { whatsappOtpDeliveryActivityHandlers } from "./activities/whatsapp-otp-delivery.js";
import { videoGenerationReconcileActivity } from "./activities/video-generation-reconcile.js";
import {
  videoGenerationFailActivity,
  videoGenerationFinalizeActivity,
  videoGenerationPollActivity,
  videoGenerationSubmitActivity,
} from "./activities/video-generation/index.js";
import {
  getTemporalWorkerConfig,
  resolveTemporalMediaTaskQueue,
} from "./config.js";
import { loadTemporalWorkerEnv } from "./load-env.js";
import { startAnalyticsProjectionRuntime } from "./analytics-projection-runtime.js";
import { createLlmObservabilityActivityInterceptors } from "./llm-observability-activity-interceptor.js";
import { createUpstashUsageActivityInterceptors } from "./upstash-usage-activity-interceptor.js";
import { ensureCrossStoreOutboxDrainSchedule } from "./cross-store-outbox-drain-schedule.js";
import { startWorkerEventConsumers } from "./pubsub/worker-event-consumers.js";
import {
  readWorkerStartupProbePort,
  startWorkerStartupProbeListener,
} from "./startup-probe.js";
import {
  loadTemporalWorkerWebRuntime,
  startRequestsProjectionRuntime,
} from "./realtime-outbox-replayer.js";
import { ensureWhatsAppCallTranscriptionDrainSchedule } from "./whatsapp-call-transcription-drain-schedule.js";
import { ensureWhatsAppWebhookDrainSchedule } from "./whatsapp-webhook-drain-schedule.js";
import {
  runTemporalWorkerLifecycle,
  type TemporalWorkerAuxiliaryStarter,
} from "./worker-lifecycle.js";
import { ensureWorkspaceUsageRepairSchedule } from "./workspace-usage-repair-schedule.js";
import { ensureVideoGenerationReconcileSchedule } from "./video-generation-reconcile-schedule.js";

function resolveWorkflowBundlePath(configPath: string | null): string | null {
  const explicitPath = configPath
    ? fileURLToPath(new URL(configPath, import.meta.url))
    : null;
  if (explicitPath && existsSync(explicitPath)) {
    return explicitPath;
  }

  const defaultBundlePath = fileURLToPath(
    new URL("../dist/workflow-bundle.js", import.meta.url),
  );
  if (existsSync(defaultBundlePath)) {
    return defaultBundlePath;
  }

  return null;
}

function parsePositiveIntegerEnv(key: string, fallback: number): number {
  const value = normalizeOptionalString(process.env[key]);
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// LLM analytics writes started by activities that finished during shutdown.
const LLM_ANALYTICS_SHUTDOWN_DRAIN_MS = 5_000;
const MEDIA_WORKER_MAX_HEARTBEAT_THROTTLE_INTERVAL = "30s";
const MEDIA_WORKER_DEFAULT_HEARTBEAT_THROTTLE_INTERVAL = "10s";

async function runAuxiliaryStartupStep<T>(params: {
  step: string;
  deploymentName: string;
  buildId: string;
  run: () => Promise<T>;
  safeFailureCode?: string;
}): Promise<T> {
  const startedAt = Date.now();
  const logContext = {
    note: "auxiliary_step_started",
    step: params.step,
    deploymentName: params.deploymentName,
    buildId: params.buildId,
  };
  airiWorkerLogger.info("airi.worker.lifecycle", logContext);

  try {
    const result = await params.run();
    airiWorkerLogger.info("airi.worker.lifecycle", {
      ...logContext,
      note: "auxiliary_step_completed",
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    const failureContext = {
      ...logContext,
      note: "auxiliary_step_failed",
      durationMs: Date.now() - startedAt,
    };
    if (params.safeFailureCode) {
      airiWorkerLogger.info("airi.worker.lifecycle", {
        ...failureContext,
        errorCode: params.safeFailureCode,
      });
    } else {
      airiWorkerLogger.error("airi.worker.lifecycle", error, failureContext);
    }
    throw error;
  }
}

export async function runTemporalWorker(): Promise<void> {
  const loadedEnvFiles = loadTemporalWorkerEnv();
  const config = getTemporalWorkerConfig();
  const startupProbePort = readWorkerStartupProbePort();
  const workflowsPath = fileURLToPath(
    new URL("./workflows/index.ts", import.meta.url),
  );
  const workflowBundlePath = resolveWorkflowBundlePath(
    config.workflowBundlePath,
  );

  airiWorkerLogger.info("airi.worker.lifecycle", {
    note: "bootstrapping",
    target: config.target,
    address: config.address,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    tls: config.tls,
    deploymentName: config.deploymentName,
    buildId: config.buildId,
    versioningBehavior: config.versioningBehavior,
    identity: config.identity,
    activityQueueClass: config.activityQueueClass,
    workflowCodeSource: workflowBundlePath ? "bundle" : "path",
    workflowBundlePath,
    loadedEnvFiles,
  });

  Runtime.install({ shutdownSignals: [] });
  const connection = await NativeConnection.connect({
    address: config.address,
    tls: config.tls ? {} : undefined,
    apiKey: config.apiKey || undefined,
  });
  const mediaOnly =
    String(process.env.AIRI_RUNTIME_MODE || "")
      .trim()
      .toLowerCase() === "media-worker";
  const worker = mediaOnly
    ? null
    : await Worker.create({
    connection,
    namespace: config.namespace,
    identity: config.identity,
    taskQueue: config.taskQueue,
    workerDeploymentOptions: {
      version: {
        deploymentName: config.deploymentName,
        buildId: config.buildId,
      },
      useWorkerVersioning: true,
      defaultVersioningBehavior: config.versioningBehavior,
    },
    reuseV8Context: config.reuseV8Context,
    maxConcurrentWorkflowTaskExecutions:
      config.maxConcurrentWorkflowTaskExecutions,
    maxConcurrentWorkflowTaskPolls: config.maxConcurrentWorkflowTaskPolls,
    maxConcurrentActivityTaskExecutions:
      config.maxConcurrentActivityTaskExecutions,
    maxConcurrentActivityTaskPolls: config.maxConcurrentActivityTaskPolls,
    maxCachedWorkflows: config.maxCachedWorkflows,
    shutdownGraceTime: config.shutdownGraceTime as never,
    shutdownForceTime: config.shutdownForceTime as never,
    interceptors: {
      activity: [
        createLlmObservabilityActivityInterceptors,
        createUpstashUsageActivityInterceptors,
      ],
    },
    ...(workflowBundlePath
      ? { workflowBundle: { codePath: workflowBundlePath } }
      : { workflowsPath }),
    activities: {
      [KNOWLEDGE_CANONICAL_SYNC_ACTIVITY]:
        knowledgeCanonicalSyncActivityHandlers[
          KNOWLEDGE_CANONICAL_SYNC_ACTIVITY
        ],
      [CRAWL_WEBSITE_ACTIVITY]:
        crawlWebsiteActivityHandlers[CRAWL_WEBSITE_ACTIVITY],
      [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: prepareAiriConversationTurn,
      [AIRI_CONVERSATION_RECORD_TURN_DISPOSITION_ACTIVITY]:
        recordAiriConversationTurnDispositionActivity,
      [AIRI_CONVERSATION_READ_PROJECTION_ACTIVITY]:
        readAiriConversationProjectionActivity,
      [AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY]:
        planAiriConversationTimerActivity,
      [AIRI_CONVERSATION_DELIVER_OUTBOUND_ACTIVITY]:
        deliverAiriConversationOutboundActivity,
      [AIRI_CONVERSATION_FINALIZE_OUTBOUND_ACTIVITY]:
        finalizeAiriConversationOutboundActivity,
      [AIRI_CONVERSATION_BUILD_TIMER_TURN_ACTIVITY]:
        buildAiriConversationTimerTurnActivity,
      [AIRI_CONVERSATION_HANDLE_EXTERNAL_EVENT_ACTIVITY]:
        handleAiriConversationExternalEventActivity,
      [AIRI_CONVERSATION_TERMINALIZE_GENERATIVE_ACK_ACTIVITY]:
        terminalizeGenerativeAcknowledgmentActivity,
      [AIRI_SCENARIO_GENERATIVE_AI_BEGIN_ACTIVITY]:
        beginScenarioGenerativeAIActivity,
      [AIRI_SCENARIO_GENERATIVE_AI_IMPORT_SOURCE_ACTIVITY]:
        importScenarioGenerativeAISourceActivity,
      [AIRI_SCENARIO_GENERATIVE_AI_ACCEPT_VIDEO_ACTIVITY]:
        acceptScenarioGenerativeAIVideoActivity,
      [AIRI_SCENARIO_GENERATIVE_AI_ACCEPT_IMAGE_ACTIVITY]:
        acceptScenarioGenerativeAIImageActivity,
      [AIRI_SCENARIO_GENERATIVE_AI_START_VIDEO_ACTIVITY]:
        startScenarioGenerativeAIVideoActivity,
      [AIRI_SCENARIO_GENERATIVE_AI_REPORT_RESULT_ACTIVITY]:
        reportScenarioGenerativeAIResultActivity,
      [AIRI_COACH_ACTIVITY]: airiCoachActivity,
      [BILLING_SUBSCRIPTION_CHARGE_ACTIVITY]: billingSubscriptionChargeActivity,
      [WIDGET_CSAT_REQUEST_ACTIVITY]: widgetCsatRequestActivity,
      [WIDGET_CSAT_TIMEOUT_ACTIVITY]: widgetCsatTimeoutActivity,
      [BULK_CAMPAIGN_DISPATCH_SEND_BATCH_ACTIVITY]:
        dispatchBulkCampaignBatchActivity,
      [BULK_CAMPAIGN_DISPATCH_FINALIZE_ACTIVITY]:
        finalizeBulkCampaignDispatchActivity,
      [BULK_CAMPAIGN_DISPATCH_BEGIN_ACTIVITY]:
        beginBulkCampaignDispatchActivity,
      [BULK_CAMPAIGN_DISPATCH_PROGRESS_ACTIVITY]:
        updateBulkCampaignDispatchProgressActivity,
      [BULK_CAMPAIGN_DISPATCH_LIFECYCLE_FINALIZE_ACTIVITY]:
        finalizeBulkCampaignDispatchLifecycleActivity,
      [CAMPAIGN_SCHEDULE_RECONCILE_ACTIVITY]: campaignScheduleReconcileActivity,
      [CAMPAIGN_SCHEDULE_ACTION_CLAIM_ACTIVITY]:
        campaignScheduleActionClaimActivity,
      [CAMPAIGN_SCHEDULE_ACTION_COMPLETE_ACTIVITY]:
        campaignScheduleActionCompleteActivity,
      [CAMPAIGN_NODE_RUN_ACTIVITY]: campaignNodeRunActivity,
      [CAMPAIGN_DELIVERY_DRAIN_ACTIVITY]: campaignDeliveryDrainActivity,
      [CAMPAIGN_EXECUTION_FINALIZE_ACTIVITY]: campaignExecutionFinalizeActivity,
      [CROSS_STORE_OUTBOX_DRAIN_ACTIVITY]: crossStoreOutboxDrainActivity,
      [CREATIVE_ASSET_PROCESS_EDIT_ACTIVITY]: creativeAssetProcessEditActivity,
      [CREATIVE_ASSET_FAIL_EDIT_ACTIVITY]: creativeAssetFailEditActivity,
      [WAN_AVATAR_PROCESS_ACTIVITY]: wanAvatarProcessActivity,
      [WAN_AVATAR_FAIL_ACTIVITY]: wanAvatarFailActivity,
      [WAN_MORPH_PROCESS_ACTIVITY]: wanMorphProcessActivity,
      [WAN_MORPH_FAIL_ACTIVITY]: wanMorphFailActivity,
      [HAPPYHORSE_VIDEO_PROCESS_ACTIVITY]: happyHorseVideoProcessActivity,
      [HAPPYHORSE_VIDEO_FAIL_ACTIVITY]: happyHorseVideoFailActivity,
      [CREATIVE_IMAGE_GENERATION_ACTIVITY]: creativeImageGenerationActivity,
      [CONVERSATION_MEDIA_ANALYSIS_ACTIVITY]:
        conversationMediaAnalysisProcessActivity,
      [CONVERSATION_MEDIA_ANALYSIS_COMPLETE_ACTIVITY]:
        conversationMediaAnalysisCompleteActivity,
      [CONVERSATION_MEDIA_ANALYSIS_FAIL_ACTIVITY]:
        conversationMediaAnalysisFailActivity,
      [CONVERSATION_MEDIA_ANALYSIS_TRIGGER_AIRI_ACTIVITY]:
        conversationMediaAnalysisTriggerAiriActivity,
      [ELEVENLABS_CREATIVE_TRANSCRIPTION_SUBMIT_ACTIVITY]:
        elevenLabsCreativeTranscriptionSubmitActivity,
      [ELEVENLABS_CREATIVE_TRANSCRIPTION_COMPLETE_ACTIVITY]:
        elevenLabsCreativeTranscriptionCompleteActivity,
      [ELEVENLABS_CREATIVE_TRANSCRIPTION_FAIL_ACTIVITY]:
        elevenLabsCreativeTranscriptionFailActivity,
      [HIGGSFIELD_SUBMIT_GENERATION_ACTIVITY]:
        higgsfieldSubmitGenerationActivity,
      [HIGGSFIELD_POLL_STATUS_ACTIVITY]: higgsfieldPollStatusActivity,
      [HIGGSFIELD_PROCESS_WEBHOOK_ACTIVITY]: higgsfieldProcessWebhookActivity,
      [VIDEO_GENERATION_SUBMIT_ACTIVITY]: videoGenerationSubmitActivity,
      [VIDEO_GENERATION_POLL_ACTIVITY]: videoGenerationPollActivity,
      [VIDEO_GENERATION_FAIL_ACTIVITY]: videoGenerationFailActivity,
      [VIDEO_GENERATION_FINALIZE_ACTIVITY]: videoGenerationFinalizeActivity,
      [VIDEO_GENERATION_RECONCILE_ACTIVITY]: videoGenerationReconcileActivity,
      [WHATSAPP_CATALOG_IMPORT_BATCH_ACTIVITY]:
        whatsappCatalogImportBatchActivity,
      [WHATSAPP_CALL_LOAD_SESSION_ACTIVITY]:
        whatsappCallActivityHandlers[WHATSAPP_CALL_LOAD_SESSION_ACTIVITY],
      [WHATSAPP_CALL_PREPARE_MEDIA_ACTIVITY]:
        whatsappCallActivityHandlers[WHATSAPP_CALL_PREPARE_MEDIA_ACTIVITY],
      [WHATSAPP_CALL_CREATE_COMMAND_ACTIVITY]:
        whatsappCallActivityHandlers[WHATSAPP_CALL_CREATE_COMMAND_ACTIVITY],
      [WHATSAPP_CALL_SEND_COMMAND_ACTIVITY]:
        whatsappCallActivityHandlers[WHATSAPP_CALL_SEND_COMMAND_ACTIVITY],
      [WHATSAPP_CALL_MARK_COMMAND_ACTIVITY]:
        whatsappCallActivityHandlers[WHATSAPP_CALL_MARK_COMMAND_ACTIVITY],
      [WHATSAPP_CALL_EMIT_REALTIME_ACTIVITY]:
        whatsappCallActivityHandlers[WHATSAPP_CALL_EMIT_REALTIME_ACTIVITY],
      [WHATSAPP_CALL_START_RECORDING_ACTIVITY]:
        whatsappCallRecordingActivityHandlers[
          WHATSAPP_CALL_START_RECORDING_ACTIVITY
        ],
      [WHATSAPP_CALL_FINALIZE_RECORDING_ACTIVITY]:
        whatsappCallRecordingActivityHandlers[
          WHATSAPP_CALL_FINALIZE_RECORDING_ACTIVITY
        ],
      [WHATSAPP_CALL_POLL_TRANSCRIPTION_ACTIVITY]:
        whatsappCallRecordingActivityHandlers[
          WHATSAPP_CALL_POLL_TRANSCRIPTION_ACTIVITY
        ],
      [WHATSAPP_CALL_TRANSCRIPTION_DRAIN_ACTIVITY]:
        whatsappCallRecordingActivityHandlers[
          WHATSAPP_CALL_TRANSCRIPTION_DRAIN_ACTIVITY
        ],
      [WHATSAPP_WEBHOOK_DRAIN_ACTIVITY]: whatsappWebhookDrainActivity,
      [WHATSAPP_WEBHOOK_PROCESS_EVENT_ACTIVITY]:
        whatsappWebhookProcessEventActivity,
      [WORKSPACE_USAGE_REPAIR_ACTIVITY]: workspaceUsageRepairActivity,
      [WHATSAPP_OTP_DELIVER_CHALLENGE_ACTIVITY]:
        whatsappOtpDeliveryActivityHandlers[
          WHATSAPP_OTP_DELIVER_CHALLENGE_ACTIVITY
        ],
    },
  });
  const mediaTaskQueue = resolveTemporalMediaTaskQueue();
  const shouldStartMediaWorker =
    mediaOnly ||
    (mediaTaskQueue !== config.taskQueue &&
      parseBooleanEnv("AIRI_MEDIA_WORKER_ENABLED", true));
  const mediaWorker = shouldStartMediaWorker
    ? await Worker.create({
        connection,
        namespace: config.namespace,
        identity: `${config.identity}:media`,
        taskQueue: mediaTaskQueue,
        workerDeploymentOptions: {
          version: {
            deploymentName: config.deploymentName,
            buildId: config.buildId,
          },
          useWorkerVersioning: true,
          defaultVersioningBehavior: config.versioningBehavior,
        },
        reuseV8Context: config.reuseV8Context,
        maxConcurrentWorkflowTaskExecutions: parsePositiveIntegerEnv(
          "AIRI_MEDIA_WORKER_MAX_CONCURRENT_WORKFLOW_TASK_EXECUTIONS",
          4,
        ),
        maxConcurrentWorkflowTaskPolls: parsePositiveIntegerEnv(
          "AIRI_MEDIA_WORKER_MAX_CONCURRENT_WORKFLOW_TASK_POLLS",
          1,
        ),
        maxConcurrentActivityTaskExecutions: parsePositiveIntegerEnv(
          "AIRI_MEDIA_WORKER_MAX_CONCURRENT_ACTIVITY_TASK_EXECUTIONS",
          1,
        ),
        maxConcurrentActivityTaskPolls: parsePositiveIntegerEnv(
          "AIRI_MEDIA_WORKER_MAX_CONCURRENT_ACTIVITY_TASK_POLLS",
          1,
        ),
        maxHeartbeatThrottleInterval:
          MEDIA_WORKER_MAX_HEARTBEAT_THROTTLE_INTERVAL,
        defaultHeartbeatThrottleInterval:
          MEDIA_WORKER_DEFAULT_HEARTBEAT_THROTTLE_INTERVAL,
        maxCachedWorkflows: Math.min(config.maxCachedWorkflows, 16),
        shutdownGraceTime: config.shutdownGraceTime as never,
        shutdownForceTime: config.shutdownForceTime as never,
        interceptors: {
          activity: [
            createLlmObservabilityActivityInterceptors,
            createUpstashUsageActivityInterceptors,
          ],
        },
        ...(workflowBundlePath
          ? { workflowBundle: { codePath: workflowBundlePath } }
          : { workflowsPath }),
        activities: {
          [AIRI_SCENARIO_GENERATIVE_AI_IMPORT_SOURCE_ACTIVITY]:
            importScenarioGenerativeAISourceActivity,
          [CREATIVE_ASSET_PROCESS_EDIT_ACTIVITY]:
            creativeAssetProcessEditActivity,
          [CREATIVE_ASSET_FAIL_EDIT_ACTIVITY]: creativeAssetFailEditActivity,
          [WAN_AVATAR_PROCESS_ACTIVITY]: wanAvatarProcessActivity,
          [WAN_AVATAR_FAIL_ACTIVITY]: wanAvatarFailActivity,
          [WAN_MORPH_PROCESS_ACTIVITY]: wanMorphProcessActivity,
          [WAN_MORPH_FAIL_ACTIVITY]: wanMorphFailActivity,
          [HAPPYHORSE_VIDEO_PROCESS_ACTIVITY]: happyHorseVideoProcessActivity,
          [HAPPYHORSE_VIDEO_FAIL_ACTIVITY]: happyHorseVideoFailActivity,
          [CREATIVE_IMAGE_GENERATION_ACTIVITY]: creativeImageGenerationActivity,
          [CONVERSATION_MEDIA_ANALYSIS_ACTIVITY]:
            conversationMediaAnalysisProcessActivity,
          [CONVERSATION_MEDIA_ANALYSIS_COMPLETE_ACTIVITY]:
            conversationMediaAnalysisCompleteActivity,
          [CONVERSATION_MEDIA_ANALYSIS_FAIL_ACTIVITY]:
            conversationMediaAnalysisFailActivity,
          [CONVERSATION_MEDIA_ANALYSIS_TRIGGER_AIRI_ACTIVITY]:
            conversationMediaAnalysisTriggerAiriActivity,
          [ELEVENLABS_CREATIVE_TRANSCRIPTION_SUBMIT_ACTIVITY]:
            elevenLabsCreativeTranscriptionSubmitActivity,
          [ELEVENLABS_CREATIVE_TRANSCRIPTION_COMPLETE_ACTIVITY]:
            elevenLabsCreativeTranscriptionCompleteActivity,
          [ELEVENLABS_CREATIVE_TRANSCRIPTION_FAIL_ACTIVITY]:
            elevenLabsCreativeTranscriptionFailActivity,
          [VIDEO_GENERATION_FINALIZE_ACTIVITY]: videoGenerationFinalizeActivity,
        },
      })
    : null;

  const runStartupStep = <T>(
    step: string,
    run: () => Promise<T>,
    options: { safeFailureCode?: string } = {},
  ) =>
    runAuxiliaryStartupStep({
      step,
      deploymentName: config.deploymentName,
      buildId: config.buildId,
      run,
      safeFailureCode: options.safeFailureCode,
    });
  const oneShotStarter =
    (
      step: string,
      run: (signal: AbortSignal) => Promise<unknown>,
    ): TemporalWorkerAuxiliaryStarter =>
    async (signal) => {
      await runStartupStep(step, () => run(signal));
      return async () => undefined;
    };
  const auxiliaryStarters: TemporalWorkerAuxiliaryStarter[] = mediaOnly
    ? []
    : [
    (signal) => startWhatsAppOptionalWork(signal),
    // Cloud Run stops the old instances as soon as this one starts, so the
    // Pub/Sub consumers come before the Temporal schedule round trips
    // (~1.6 s each); until they start, no instance takes inbound messages.
    async (signal, reportFatal) =>
      runStartupStep("worker_event_consumers", () =>
        startWorkerEventConsumers(undefined, { signal, onFatal: reportFatal }),
      ),
    oneShotStarter("whatsapp_webhook_drain_schedule", (signal) =>
      ensureWhatsAppWebhookDrainSchedule({ config, signal }),
    ),
    oneShotStarter("cross_store_outbox_drain_schedule", (signal) =>
      ensureCrossStoreOutboxDrainSchedule({ config, signal }),
    ),
    oneShotStarter("whatsapp_call_transcription_drain_schedule", (signal) =>
      ensureWhatsAppCallTranscriptionDrainSchedule({ config, signal }),
    ),
    oneShotStarter("workspace_usage_repair_schedule", (signal) =>
      ensureWorkspaceUsageRepairSchedule({ config, signal }),
    ),
    oneShotStarter("video_generation_reconcile_schedule", (signal) =>
      ensureVideoGenerationReconcileSchedule({ config, signal }),
    ),
  ];
  if (!mediaOnly) {
    auxiliaryStarters.push(async (signal) =>
      runStartupStep(
        "analytics_projection_runtime",
        () => startAnalyticsProjectionRuntime({
          enabled: parseBooleanEnv("ANALYTICS_PROJECTION_ENABLED", false),
          signal,
          logger: airiWorkerLogger,
        }),
        { safeFailureCode: "analytics_projection_start_failed" },
      ),
    );
  }
  if (!mediaOnly && config.requestsProjectionWriterEnabled) {
    auxiliaryStarters.push(async (signal, reportFatal) =>
      runStartupStep(
        "requests_projection_runtime",
        () =>
          startRequestsProjectionRuntime({
            signal,
            ownerToken: config.identity,
            realtimeEnabled: config.requestsProjectionRealtimeEnabled,
            onFatal: reportFatal,
          }),
        { safeFailureCode: "requests_projection_start_failed" },
      ),
    );
  }

  const workers = [worker, mediaWorker].filter(
    (item): item is Worker => Boolean(item),
  );
  if (workers.length === 0) {
    throw new Error("Temporal worker created no pollers");
  }

  await runTemporalWorkerLifecycle({
    workers,
    auxiliaryStarters,
    afterWorkersStopped: async () => {
      const runtime = await loadTemporalWorkerWebRuntime();
      const drained = await runtime.drainPendingLlmAnalyticsEvents(
        LLM_ANALYTICS_SHUTDOWN_DRAIN_MS,
      );
      if (!drained) {
        airiWorkerLogger.warn("airi.worker.lifecycle", {
          note: "llm_analytics_drain_timeout",
          timeoutMs: LLM_ANALYTICS_SHUTDOWN_DRAIN_MS,
        });
      }
    },
    onReady: () => {
      airiWorkerLogger.info("airi.worker.lifecycle", {
        note: "started",
        namespace: config.namespace,
        taskQueue: config.taskQueue,
        deploymentName: config.deploymentName,
        buildId: config.buildId,
        mediaTaskQueue,
        mediaWorkerEnabled: Boolean(mediaWorker),
        mediaOnly,
        otpDeliveryMode: getWhatsAppOtpDeliveryMode(),
        otpTemporalAllowlistSize:
          getWhatsAppOtpTemporalWorkspaceAllowlist().length,
        otpDeliveryWorkflow: WHATSAPP_OTP_DELIVERY_WORKFLOW,
        workflowBundlePath,
        workflowsPath: workflowBundlePath ? null : workflowsPath,
        reuseV8Context: config.reuseV8Context,
        maxConcurrentWorkflowTaskExecutions:
          config.maxConcurrentWorkflowTaskExecutions,
        maxConcurrentActivityTaskExecutions:
          config.maxConcurrentActivityTaskExecutions,
        maxCachedWorkflows: config.maxCachedWorkflows,
      });
    },
    startReadinessProbe: startupProbePort
      ? async () => {
          const probe = await startWorkerStartupProbeListener({
            port: startupProbePort,
          });
          airiWorkerLogger.info("airi.worker.lifecycle", {
            note: "startup_probe_listening",
            port: probe.port,
            buildId: config.buildId,
          });
          return probe.stop;
        }
      : undefined,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runTemporalWorker().catch((error) => {
    airiWorkerLogger.error("airi.worker.lifecycle", error, {
      note: "start_failed",
    });
    process.exit(1);
  });
}

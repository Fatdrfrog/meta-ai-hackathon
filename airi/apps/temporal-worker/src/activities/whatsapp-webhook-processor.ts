import { randomUUID } from "node:crypto";

import {
  assertContractVersion,
  WHATSAPP_WEBHOOK_PROCESSOR_WORKFLOW_CONTRACT_VERSION,
  type WhatsAppWebhookRuntimeResult,
  type WhatsAppWebhookProcessEventActivityInput,
  type WhatsAppWebhookProcessEventActivityResult,
} from "@icecore/temporal";
import type { WhatsAppWebhookBody } from "@icecore/shared/lib/whatsapp/webhook-payload";
import { heartbeat as temporalHeartbeat } from "@temporalio/activity";
import {
  expandWhatsAppHistoryChunk,
  WhatsAppHistoryCapacityPausedError,
} from "@icecore/airi-runtime/whatsapp-history-import-store";
import { isCompanyRuntimeCapacityDeferredError } from "@icecore/shared/lib/company-runtime-capacity";
import { readDefaultExport } from "@icecore/airi-runtime/module-interop";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  readWhatsAppIntakePlanSkipReason,
  WHATSAPP_INTAKE_TRIAL_EXPIRED_REASON,
  type WhatsAppIntakePlanCheck,
} from "@icecore/airi-runtime/whatsapp-intake-plan-gate";
import type { WhatsAppHistoryImportReceipt } from "@icecore/airi-runtime/whatsapp-history-import";
import type { WhatsAppWebhookEventEnvelope } from "@icecore/airi-runtime/whatsapp-webhook-event-envelopes";
import { publishWhatsAppHistoryChildren } from "../whatsapp-history-import-dispatch.js";
import {
  DEFAULT_WEBHOOK_EVENT_MAX_ATTEMPTS,
  buildWhatsAppWebhookMaxAttemptsExpression,
} from "../whatsapp-webhook-retry-policy.js";

const WEBHOOK_EVENT_PROCESSING_LEASE_MS = 15 * 60 * 1000;

export function buildWhatsAppWebhookProcessingClaimFilter(params: {
  eventId: string;
  now?: Date;
}) {
  const now = params.now || new Date();
  return {
    _id: params.eventId,
    $and: [
      {
        $or: [
          {
            status: {
              $in: ["received", "published", "queued", "failed"],
            },
          },
          {
            status: "processing",
            processingStartedAt: {
              $lte: new Date(now.getTime() - WEBHOOK_EVENT_PROCESSING_LEASE_MS),
            },
          },
        ],
      },
      {
        $expr: {
          $lt: [
            { $ifNull: ["$attempts", 0] },
            buildWhatsAppWebhookMaxAttemptsExpression(),
          ],
        },
      },
      {
        $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: now } }],
      },
      {
        $or: [
          { "historyImport.capacityDeferredUntil": null },
          { "historyImport.capacityDeferredUntil": { $lte: now } },
        ],
      },
    ],
  };
}

function getPayloadRawBody(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const rawBody = (payload as { rawBody?: unknown }).rawBody;
    if (typeof rawBody === "string" && rawBody.trim()) {
      return rawBody;
    }
    const body = (payload as { body?: unknown }).body;
    if (body) return JSON.stringify(body);
  }
  throw new Error("WhatsApp webhook event payload is missing rawBody/body.");
}

function getPayloadBody(payload: unknown): unknown {
  if (payload && typeof payload === "object") {
    const body = (payload as { body?: unknown }).body;
    if (body) return body;
    const rawBody = (payload as { rawBody?: unknown }).rawBody;
    if (typeof rawBody === "string" && rawBody.trim()) {
      return JSON.parse(rawBody);
    }
  }
  throw new Error("WhatsApp webhook event payload is missing body/rawBody.");
}

function formatRuntimeProcessorException(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `WhatsApp webhook runtime processor threw: ${message}`.slice(0, 1_000);
}

export function isSourceDependentRuntimeProcessorSkip(params: {
  runtimeResult: WhatsAppWebhookRuntimeResult;
  phoneNumberId?: string | null;
  wabaId?: string | null;
}): boolean {
  if (!params.phoneNumberId && !params.wabaId) return false;
  const lowerResponseText = JSON.stringify({
    code: params.runtimeResult.code,
    message: params.runtimeResult.message,
    details: params.runtimeResult.details,
  }).toLowerCase();
  return (
    lowerResponseText.includes("source not found") ||
    lowerResponseText.includes("history skipped") ||
    lowerResponseText.includes("state_sync skipped")
  );
}

export function isWhatsAppWebhookRetryExhausted(
  event: { attempts?: number | null; maxAttempts?: number | null } | null,
): boolean {
  const attempts = Number(event?.attempts ?? 0);
  const maxAttempts = Number(
    event?.maxAttempts ?? DEFAULT_WEBHOOK_EVENT_MAX_ATTEMPTS,
  );
  if (!Number.isFinite(attempts)) return false;
  const boundedMaxAttempts =
    Number.isFinite(maxAttempts) && maxAttempts > 0
      ? Math.trunc(maxAttempts)
      : DEFAULT_WEBHOOK_EVENT_MAX_ATTEMPTS;
  return attempts >= boundedMaxAttempts;
}

function buildFailureUpdate(params: {
  errorMessage: string;
  exhausted: boolean;
}) {
  return {
    $set: {
      status: params.exhausted ? "dead" : "failed",
      lastError: params.errorMessage,
      nextRetryAt: params.exhausted ? null : new Date(Date.now() + 60_000),
      processingLeaseId: null,
    },
  };
}

type WebhookProcessorHeartbeat = (details: Record<string, unknown>) => void;

function noopHeartbeat(): void {
  // Used by the direct Pub/Sub consumer path, which is not inside a Temporal activity.
}

export class DurableWhatsAppWebhookEventFailure extends Error {
  readonly eventId: string;
  readonly durableStatus: "failed" | "dead";
  readonly runtimeCode?: string | null;

  constructor(params: {
    eventId: string;
    durableStatus: "failed" | "dead";
    message: string;
    runtimeCode?: string | null;
  }) {
    super(params.message);
    this.name = "DurableWhatsAppWebhookEventFailure";
    this.eventId = params.eventId;
    this.durableStatus = params.durableStatus;
    this.runtimeCode = params.runtimeCode ?? null;
  }
}

export function isDurableWhatsAppWebhookEventFailure(
  error: unknown,
): error is DurableWhatsAppWebhookEventFailure {
  return error instanceof DurableWhatsAppWebhookEventFailure;
}

function logProcessorTiming(params: {
  enabled: boolean;
  eventId: string;
  stage: string;
  startedAt: number;
  lastAt: number;
}) {
  if (!params.enabled) return params.lastAt;
  const now = Date.now();
  console.info("[WhatsApp Webhook Processor] timing", {
    eventId: params.eventId,
    stage: params.stage,
    stageMs: now - params.lastAt,
    totalMs: now - params.startedAt,
  });
  return now;
}

type StoredWhatsAppWebhookProcessorOptions = {
  withHistoryCapacity?: (
    workspaceId: string,
    run: (companyId: string) => Promise<WhatsAppWebhookRuntimeResult>,
  ) => Promise<WhatsAppWebhookRuntimeResult>;
  /** Defaults to the runtime dependencies' intake plan gate. */
  getIntakePlanSkip?: WhatsAppIntakePlanCheck;
  expandHistoryChunk?: typeof expandWhatsAppHistoryChunk;
  publishHistoryChildren?: typeof publishWhatsAppHistoryChildren;
  heartbeat?: WebhookProcessorHeartbeat;
  suppressAiriIngress?: boolean;
  suppressRealtime?: boolean;
  runtime?: Awaited<ReturnType<typeof importWhatsAppWebhookProcessorRuntime>>;
};

async function importWhatsAppWebhookProcessorRuntime() {
  const [mongooseModule, eventModelModule, runtimeModule, dependenciesModule] =
    await Promise.all([
      import("@icecore/airi-runtime/mongoose"),
      import("@icecore/airi-runtime/whatsapp-webhook-event-model"),
      import("@icecore/airi-runtime/whatsapp-webhook-runtime"),
      import("../whatsapp-webhook-runtime-dependencies.js"),
    ]);

  return {
    connectDB: mongooseModule.default,
    WhatsAppWebhookEvent: eventModelModule.default,
    processWhatsAppWebhookPayload: runtimeModule.processWhatsAppWebhookPayload,
    whatsappWebhookRuntimeDependencies:
      dependenciesModule.whatsappWebhookRuntimeDependencies,
  };
}

let whatsappWebhookProcessorRuntimePromise: ReturnType<
  typeof importWhatsAppWebhookProcessorRuntime
> | null = null;

function loadWhatsAppWebhookProcessorRuntime() {
  whatsappWebhookProcessorRuntimePromise ??=
    importWhatsAppWebhookProcessorRuntime().catch((error) => {
      whatsappWebhookProcessorRuntimePromise = null;
      throw error;
    });
  return whatsappWebhookProcessorRuntimePromise;
}

/** Loads the processor graph and opens Mongo before the priority subscriber starts. */
export async function warmWhatsAppWebhookProcessorRuntime(): Promise<void> {
  const runtime = await loadWhatsAppWebhookProcessorRuntime();
  await runtime.connectDB();
}

/**
 * Where an event stands for a lane that runs without Pub/Sub ordering. Only a
 * chat's head event (no earlier event on its ordering key still flowing) may
 * run there, so per-chat order matches the ordered subscription.
 */
export type WhatsAppWebhookEventOrderingState =
  | { state: "missing" }
  | { state: "claimed" }
  | { state: "settled"; status: string }
  | { state: "waiting"; predecessorEventId: string }
  | { state: "head" };

export async function readWhatsAppWebhookEventOrderingState(
  eventId: string,
  options: {
    runtime?: Awaited<ReturnType<typeof importWhatsAppWebhookProcessorRuntime>>;
    now?: () => Date;
  } = {},
): Promise<WhatsAppWebhookEventOrderingState> {
  const runtime =
    options.runtime || (await loadWhatsAppWebhookProcessorRuntime());
  await runtime.connectDB();
  const { WhatsAppWebhookEvent } = runtime;
  const event = await WhatsAppWebhookEvent.findById(eventId)
    .select("_id status orderingKey createdAt")
    .lean<{
      _id: unknown;
      status?: string;
      orderingKey?: string;
      createdAt?: Date;
    } | null>();
  if (!event) return { state: "missing" };
  if (event.status === "processing") return { state: "claimed" };
  if (event.status !== "received" && event.status !== "published") {
    return { state: "settled", status: String(event.status) };
  }

  const now = options.now ? options.now() : new Date();
  // A "received" event whose publish failed waits for the drain and is not
  // in the ordered flow, so it does not hold back the next message.
  const predecessor = await WhatsAppWebhookEvent.findOne({
    orderingKey: event.orderingKey,
    $and: [
      {
        $or: [
          { createdAt: { $lt: event.createdAt } },
          { createdAt: event.createdAt, _id: { $lt: event._id } },
        ],
      },
      {
        $or: [
          { status: { $in: ["published", "processing"] } },
          { status: "received", nextRetryAt: { $lte: now } },
        ],
      },
    ],
  })
    .select("_id")
    .lean<{ _id: unknown } | null>();
  return predecessor
    ? { state: "waiting", predecessorEventId: String(predecessor._id) }
    : { state: "head" };
}

export async function processStoredWhatsAppWebhookEvent(
  input: WhatsAppWebhookProcessEventActivityInput,
  options: StoredWhatsAppWebhookProcessorOptions = {},
): Promise<WhatsAppWebhookProcessEventActivityResult> {
  const heartbeat = options.heartbeat || noopHeartbeat;
  const timingEnabled = process.env.WHATSAPP_WEBHOOK_PROCESSOR_TIMINGS === "1";
  const timingStartedAt = Date.now();
  let timingLastAt = timingStartedAt;
  const markTiming = (stage: string) => {
    timingLastAt = logProcessorTiming({
      enabled: timingEnabled,
      eventId: input.eventId,
      stage,
      startedAt: timingStartedAt,
      lastAt: timingLastAt,
    });
  };

  assertContractVersion(
    input.contractVersion,
    { exact: WHATSAPP_WEBHOOK_PROCESSOR_WORKFLOW_CONTRACT_VERSION },
    "WhatsApp webhook event",
  );

  heartbeat({ eventId: input.eventId, phase: "load" });

  const runtime =
    options.runtime || (await loadWhatsAppWebhookProcessorRuntime());
  await runtime.connectDB();
  markTiming("connect_db");
  const { WhatsAppWebhookEvent } = runtime;
  const processingLeaseId = randomUUID();
  const processingClaimFilter = buildWhatsAppWebhookProcessingClaimFilter({
    eventId: input.eventId,
  });
  const processingEvent = await WhatsAppWebhookEvent.findOneAndUpdate(
    processingClaimFilter,
    {
      $set: {
        status: "processing",
        processingStartedAt: new Date(),
        processingLeaseId,
        lastError: null,
      },
      $inc: { attempts: 1 },
    },
    { new: true },
  )
    .select(
      "_id status field phoneNumberId wabaId payload providerSignatureVerified attempts maxAttempts historyImport historyMetadata dedupeKey orderingKey object firstReceivedAt",
    )
    .lean<{
      _id: unknown;
      status?: string;
      field?: string | null;
      phoneNumberId?: string | null;
      wabaId?: string | null;
      payload?: unknown;
      providerSignatureVerified?: boolean;
      attempts?: number | null;
      maxAttempts?: number | null;
    } | null>();
  markTiming("claim_event");

  if (!processingEvent) {
    const eventState = await WhatsAppWebhookEvent.findById(input.eventId)
      .select("status attempts maxAttempts")
      .lean<{
        status?: string;
        attempts?: number | null;
        maxAttempts?: number | null;
      } | null>();
    markTiming("load_unclaimed_event_state");

    if (!eventState) {
      return {
        eventId: input.eventId,
        status: "skipped",
        runtimeCode: "event_not_found",
      };
    }

    if (eventState.status === "completed" || eventState.status === "dead") {
      return {
        eventId: input.eventId,
        status: "skipped",
        runtimeCode: `event_${eventState.status}`,
      };
    }

    if (isWhatsAppWebhookRetryExhausted(eventState)) {
      const exhausted = await WhatsAppWebhookEvent.updateOne(
        {
          _id: input.eventId,
          $and: [
            // Reuse the claim's stale-lease cutoff: a duplicate signal must not
            // terminalize another processor's active final attempt.
            processingClaimFilter.$and[0],
            {
              attempts: eventState.attempts ?? null,
              maxAttempts: eventState.maxAttempts ?? null,
            },
          ],
        },
        {
          $set: {
            status: "dead",
            nextRetryAt: null,
          },
        },
      );
      return {
        eventId: input.eventId,
        status: "skipped",
        runtimeCode:
          exhausted.modifiedCount === 1
            ? "retry_exhausted"
            : "event_already_claimed",
      };
    }

    return {
      eventId: input.eventId,
      status: "skipped",
      runtimeCode: "event_already_claimed",
    };
  }

  const event = processingEvent as {
    _id: unknown;
    status?: string;
    field?: string | null;
    phoneNumberId?: string | null;
    wabaId?: string | null;
    payload?: unknown;
    providerSignatureVerified?: boolean;
    attempts?: number | null;
    maxAttempts?: number | null;
    historyImport?: WhatsAppHistoryImportReceipt;
    historyMetadata?: WhatsAppWebhookEventEnvelope["historyMetadata"];
    dedupeKey?: string;
    orderingKey?: string;
    object?: string;
    firstReceivedAt?: Date;
  };

  const rawBody = getPayloadRawBody(event.payload);
  const body = getPayloadBody(event.payload);
  const getDurableFailureStatus = () =>
    isWhatsAppWebhookRetryExhausted(processingEvent) ? "dead" : "failed";

  heartbeat({ eventId: input.eventId, phase: "process" });
  let heartbeatError: unknown;
  const heartbeatTimer = options.heartbeat
    ? setInterval(() => {
        try {
          heartbeat({ eventId: input.eventId, phase: "process" });
        } catch (error) {
          heartbeatError = error;
        }
      }, 10_000)
    : null;
  let runtimeResult: WhatsAppWebhookRuntimeResult;
  try {
    if (event.historyImport && event.providerSignatureVerified !== true)
      throw new Error(
        "History import receipt has no verified provider signature",
      );
    const processEvent = async (
      companyId?: string,
    ): Promise<WhatsAppWebhookRuntimeResult> => {
      if (event.historyImport?.role === "chunk") {
        const parent = {
          dedupeKey: event.dedupeKey || input.dedupeKey,
          field: "history",
          itemKind: "history",
          object: event.object || "whatsapp_business_account",
          orderingKey: event.orderingKey || input.orderingKey,
          workspaceId: event.historyImport.workspaceId,
          sourceId: event.historyImport.sourceId,
          phoneNumberId: event.phoneNumberId || null,
          wabaId: event.wabaId || null,
          csId: null,
          messagingAccountId: null,
          waacId: null,
          payload: event.payload as WhatsAppWebhookEventEnvelope["payload"],
          historyImport: event.historyImport,
          historyMetadata: event.historyMetadata || null,
          receivedAt: event.firstReceivedAt || new Date(input.receivedAt),
        } satisfies WhatsAppWebhookEventEnvelope;
        // A trial-expired company pauses instead of expanding: the chunk keeps
        // its payload and the hourly capacity retry imports it after an upgrade.
        const getIntakePlanSkip =
          options.getIntakePlanSkip ||
          runtime.whatsappWebhookRuntimeDependencies.getWhatsAppIntakePlanSkip;
        const planSkip = await getIntakePlanSkip({
          workspaceId: event.historyImport.workspaceId,
          sourceId: event.historyImport.sourceId,
          itemKind: "history_chunk",
        });
        if (planSkip) {
          airiWorkerLogger.info("whatsapp.history_chunk.plan_paused", {
            eventId: input.eventId,
            workspaceId: event.historyImport.workspaceId,
            sourceId: event.historyImport.sourceId,
            companyId: companyId ?? null,
            itemKind: "history_chunk",
            reason: planSkip.reason,
          });
          throw new WhatsAppHistoryCapacityPausedError(
            companyId ?? "",
            WHATSAPP_INTAKE_TRIAL_EXPIRED_REASON,
          );
        }
        const children = await (
          options.expandHistoryChunk || expandWhatsAppHistoryChunk
        )({
          parent,
          eventId: input.eventId,
          processingLeaseId,
          providerSignatureVerified: true,
          companyId,
          heartbeat: () =>
            heartbeat({ eventId: input.eventId, phase: "expand" }),
        });
        try {
          await (
            options.publishHistoryChildren || publishWhatsAppHistoryChildren
          )(children);
        } catch (error) {
          // Every child is already durable; the normal drain recovers failed publication.
          console.error("WhatsApp history child publication failed", {
            eventId: input.eventId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return { ok: true, code: "history_expanded" };
      } else {
        return runtime.processWhatsAppWebhookPayload(
          runtime.whatsappWebhookRuntimeDependencies,
          {
            body: body as WhatsAppWebhookBody,
            rawBody,
            providerSignatureVerified: event.providerSignatureVerified === true,
            eventId: input.eventId,
            dedupeKey: input.dedupeKey,
            suppressAiriIngress: options.suppressAiriIngress,
            suppressRealtime: options.suppressRealtime,
            historyImport: event.historyImport,
          },
        );
      }
    };
    if (event.historyImport) {
      const withCapacity =
        options.withHistoryCapacity ||
        (async (workspaceId, run) => {
          const module = readDefaultExport<
            typeof import("../whatsapp-webhook-runtime-dependencies.js")
          >(await import("../whatsapp-webhook-runtime-dependencies.js"));
          return module.withWorkspaceRuntimeCapacity(
            workspaceId,
            "history",
            run,
          );
        });
      runtimeResult = await withCapacity(
        event.historyImport.workspaceId,
        processEvent,
      );
    } else runtimeResult = await processEvent();
    if (
      event.historyImport?.role === "message" &&
      runtimeResult.ok &&
      !["synchronized", "skipped", "superseded"].includes(
        String(runtimeResult.details?.historyOutcome),
      )
    ) {
      throw new Error(
        "History message processing did not record a durable outcome",
      );
    }
    if (heartbeatError) throw heartbeatError;
    markTiming("runtime_process");
  } catch (error) {
    if (
      isCompanyRuntimeCapacityDeferredError(error) ||
      error instanceof WhatsAppHistoryCapacityPausedError
    ) {
      const paused = error instanceof WhatsAppHistoryCapacityPausedError;
      const retryAt = new Date(paused ? Date.now() + 3600_000 : error.retryAt);
      await WhatsAppWebhookEvent.updateOne(
        { _id: input.eventId, processingLeaseId },
        {
          $set: {
            status: "received",
            processingLeaseId: null,
            nextRetryAt: retryAt,
            lastError: error.message,
            ...(event.historyImport
              ? {
                  "historyImport.capacityDeferredUntil": retryAt,
                  "historyImport.capacityPaused": paused,
                  ...(paused
                    ? {
                        "historyImport.capacityCompanyId": error.companyId,
                        "historyImport.capacityPauseReason": error.reason,
                      }
                    : {}),
                }
              : {}),
          },
          $inc: { attempts: -1 },
        },
      );
      return {
        eventId: input.eventId,
        status: "skipped",
        runtimeCode: paused
          ? error.reason === WHATSAPP_INTAKE_TRIAL_EXPIRED_REASON
            ? "history_plan_paused"
            : "history_capacity_paused"
          : "company_capacity_deferred",
      };
    }
    const errorMessage = formatRuntimeProcessorException(error);
    const durableStatus = getDurableFailureStatus();
    await WhatsAppWebhookEvent.updateOne(
      { _id: input.eventId, processingLeaseId },
      buildFailureUpdate({
        errorMessage,
        exhausted: durableStatus === "dead",
      }),
    );
    throw new DurableWhatsAppWebhookEventFailure({
      eventId: input.eventId,
      durableStatus,
      message: errorMessage,
    });
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }

  if (!runtimeResult.ok) {
    const errorMessage = `WhatsApp webhook runtime processor failed ${
      runtimeResult.code
    } ${String(runtimeResult.message || "").slice(0, 500)}`;
    const durableStatus = getDurableFailureStatus();
    await WhatsAppWebhookEvent.updateOne(
      { _id: input.eventId, processingLeaseId },
      buildFailureUpdate({
        errorMessage,
        exhausted: durableStatus === "dead",
      }),
    );
    throw new DurableWhatsAppWebhookEventFailure({
      eventId: input.eventId,
      durableStatus,
      message: errorMessage,
      runtimeCode: runtimeResult.code,
    });
  }

  const looksLikeSourceDependentSkip = isSourceDependentRuntimeProcessorSkip({
    runtimeResult,
    phoneNumberId: event.phoneNumberId,
    wabaId: event.wabaId,
  });
  if (looksLikeSourceDependentSkip) {
    const errorMessage = `WhatsApp webhook runtime processor skipped ${event.field || input.field} while source may still be onboarding.`;
    const durableStatus = getDurableFailureStatus();
    await WhatsAppWebhookEvent.updateOne(
      { _id: input.eventId, processingLeaseId },
      buildFailureUpdate({
        errorMessage,
        exhausted: durableStatus === "dead",
      }),
    );
    throw new DurableWhatsAppWebhookEventFailure({
      eventId: input.eventId,
      durableStatus,
      message: errorMessage,
      runtimeCode: runtimeResult.code,
    });
  }

  // A plan skip keeps its reason on the receipt so the replay tool can select
  // it after an upgrade; a later successful replay clears the marker.
  const planSkipReason = readWhatsAppIntakePlanSkipReason(
    runtimeResult.details,
  );
  const completion = await WhatsAppWebhookEvent.updateOne(
    { _id: input.eventId, processingLeaseId },
    {
      $set: {
        status: "completed",
        completedAt: new Date(),
        processingLeaseId: null,
        lastError: null,
        ...(event.historyImport?.role === "message"
          ? { "historyImport.outcome": runtimeResult.details?.historyOutcome }
          : {}),
        ...(planSkipReason ? { planSkipReason } : {}),
      },
      ...(planSkipReason ? {} : { $unset: { planSkipReason: "" } }),
    },
  );
  markTiming("mark_completed");

  if (completion.modifiedCount !== 1) {
    return {
      eventId: input.eventId,
      status: "skipped",
      runtimeCode: "event_claim_lost",
    };
  }

  heartbeat({ eventId: input.eventId, phase: "complete" });
  return {
    eventId: input.eventId,
    status: "completed",
    runtimeCode: runtimeResult.code,
  };
}

export async function whatsappWebhookProcessEventActivity(
  input: WhatsAppWebhookProcessEventActivityInput,
): Promise<WhatsAppWebhookProcessEventActivityResult> {
  return processStoredWhatsAppWebhookEvent(input, {
    heartbeat: temporalHeartbeat,
  });
}

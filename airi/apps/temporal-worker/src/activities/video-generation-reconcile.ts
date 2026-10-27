import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  isRecord,
  readTrimmedString as cleanString,
} from "@icecore/shared/lib/value-utils";
import {
  VIDEO_GENERATION_RECONCILE_LIMIT,
  VIDEO_GENERATION_RECONCILE_RUNNING_STALE_MS,
  VIDEO_GENERATION_RECONCILE_STALE_MS,
  VIDEO_GENERATION_RECONCILE_WORKFLOW_CONTRACT_VERSION,
  VIDEO_GENERATION_WORKFLOW,
  buildVideoGenerationWorkflowId,
  type CompiledVideoPrompt,
  MAX_VIDEO_GENERATION_SAFETY_ANCESTOR_ID_LENGTH,
  MAX_VIDEO_GENERATION_SAFETY_ANCESTORS,
  MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_ID_LENGTH,
  MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_IDS,
  normalizeVideoGenerationCompletionTarget,
  type VideoGenerationReconcileActivityResult,
  type VideoGenerationReconcileWorkflowInput,
  type VideoGenerationCompletionTarget,
  type VideoGenerationSafetyAncestor,
  type VideoGenerationSpec,
  type VideoGenerationWorkflowInput,
} from "@icecore/temporal";
import {
  WorkflowExecutionAlreadyStartedError,
  type WorkflowExecutionStatusName,
} from "@temporalio/client";
import { createHash } from "node:crypto";

import type { VideoGenerationNsfwVerdictIdentity } from "@/lib/creative-assets/video-generation-nsfw-verdict-store";

import {
  getTemporalWorkerConfig,
  resolveTemporalMediaTaskQueue,
} from "../config.js";
import { getTemporalClient } from "../temporal-client.js";
import {
  deleteGcsCreativeAssetObject,
  statGcsCreativeAssetObject,
} from "../gcs-creative-assets.js";

export type VideoGenerationReconcileCandidate = {
  id: string;
  workspaceId: string;
  status: "queued" | "in_progress";
  orchestrationState: "pending" | "unknown" | "started";
  providerSourceId: string | null;
  attemptToken: string;
  spec: VideoGenerationSpec;
  prompt: CompiledVideoPrompt;
  completionTarget: VideoGenerationCompletionTarget | null;
  safetyProviderRequestIds: string[];
  safetyAncestors: VideoGenerationSafetyAncestor[];
  providerResultResume: {
    providerRequestId: string;
    providerRequestLocator: string;
    pollCount: 0;
    elapsedMs: 0;
  } | null;
};

type CandidateQuery = {
  query: Record<string, unknown>;
  projection: Record<string, 1>;
  sort: Record<string, 1>;
  limit: 100;
};

type NsfwCleanupCandidate = {
  assetId: string;
  workspaceId: string;
  attemptToken: string;
  bucket: string;
  path: string;
};

type NsfwCleanupMutation = NsfwCleanupCandidate & {
  now: Date;
};

type NsfwStoredObject = {
  exists: boolean;
  customMetadata: Record<string, string>;
  generation: string | null;
  metageneration: string | null;
};

type ReconcileMutation = {
  assetId: string;
  workspaceId: string;
  attemptToken: string;
  workflowId: string;
  now: Date;
};

type ReconcileTerminalFailureMutation = {
  assetId: string;
  workspaceId: string;
  attemptToken: string | null;
  now: Date;
  submissionState: "not_attempted" | "unknown" | "submitted";
  providerRequestId?: string;
  providerRequestLocator?: string;
  failure: {
    phase: "validation" | "submit" | "poll";
    code: string;
    providerCode: string | null;
    message: string;
    retryable: boolean;
    submissionUncertain: boolean;
    failedAt: Date;
  };
};

type VideoGenerationWorkflowStartObservation = {
  outcome: "started" | "already_started";
  status: WorkflowExecutionStatusName;
};

type ParsedCandidate =
  | { kind: "valid"; candidate: VideoGenerationReconcileCandidate }
  | {
      kind: "invalid";
      assetId: string;
      workspaceId: string;
      attemptToken: string | null;
    }
  | { kind: "unscoped"; assetId: string | null };

export type VideoGenerationReconcileDependencies = {
  now: () => Date;
  queues: { mainTaskQueue: string; mediaTaskQueue: string };
  loadCandidates: (input: CandidateQuery) => Promise<Record<string, unknown>[]>;
  startWorkflow: (input: {
    workflowId: string;
    taskQueue: string;
    input: VideoGenerationWorkflowInput;
  }) => Promise<VideoGenerationWorkflowStartObservation>;
  markStarted: (input: ReconcileMutation) => Promise<boolean>;
  touchStarted: (input: ReconcileMutation) => Promise<boolean>;
  markUnknown: (input: ReconcileMutation) => Promise<boolean>;
  markTerminalFailure: (
    input: ReconcileTerminalFailureMutation,
  ) => Promise<boolean>;
  loadNsfwCleanupCandidates?: (
    input: CandidateQuery,
  ) => Promise<Record<string, unknown>[]>;
  statNsfwObject?: (input: NsfwCleanupCandidate) => Promise<NsfwStoredObject>;
  deleteNsfwObject?: (
    input: NsfwCleanupCandidate & {
      ifGenerationMatch: string;
      ifMetagenerationMatch: string;
    },
  ) => Promise<void>;
  clearNsfwStorage?: (input: NsfwCleanupMutation) => Promise<boolean>;
  deferNsfwCleanup?: (input: NsfwCleanupMutation) => Promise<boolean>;
  findNsfwSafetyVerdict?: (input: {
    workspaceId: string;
    providerRequestIds: string[];
    ancestors: VideoGenerationSafetyAncestor[];
  }) => Promise<VideoGenerationNsfwVerdictIdentity | null>;
  markNsfwFromVerdict?: (input: {
    assetId: string;
    workspaceId: string;
    attemptToken: string;
    providerRequestId: string;
    now: Date;
  }) => Promise<boolean>;
  replayPendingNsfwVerdictSweeps?: (input: {
    now: Date;
    limit: number;
  }) => Promise<{
    scanned: number;
    completed: number;
    failed: number;
  }>;
};

function identifier(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const rendered = String(value).trim();
  return rendered && rendered !== "[object Object]" ? rendered : "";
}

function isClosedWorkflowStatus(status: WorkflowExecutionStatusName): boolean {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "TERMINATED" ||
    status === "CONTINUED_AS_NEW" ||
    status === "TIMED_OUT"
  );
}

function safetyProviderRequestIdsFromGeneration(
  generation: Record<string, unknown>,
): string[] | null {
  const value = generation.safetyProviderRequestIds;
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.length > MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_IDS
  ) {
    return null;
  }
  const requestIds = value.map(cleanString);
  return requestIds.every(
    (requestId) =>
      requestId.length > 0 &&
      requestId.length <=
        MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_ID_LENGTH,
  ) && new Set(requestIds).size === requestIds.length
    ? requestIds
    : null;
}

function safetyAncestorsFromGeneration(
  generation: Record<string, unknown>,
): VideoGenerationSafetyAncestor[] | null {
  const value = generation.safetyAncestors;
  if (value === undefined || value === null) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.length > MAX_VIDEO_GENERATION_SAFETY_ANCESTORS
  ) {
    return null;
  }
  const ancestors = value.map((entry) => {
    const record = isRecord(entry) ? entry : null;
    return {
      assetId: cleanString(record?.assetId),
      attemptToken: cleanString(record?.attemptToken),
    };
  });
  const keys = ancestors.map(
    (ancestor) => `${ancestor.assetId}\u0000${ancestor.attemptToken}`,
  );
  return ancestors.every(
    (ancestor) =>
      ancestor.assetId.length > 0 &&
      ancestor.assetId.length <=
        MAX_VIDEO_GENERATION_SAFETY_ANCESTOR_ID_LENGTH &&
      ancestor.attemptToken.length > 0 &&
      ancestor.attemptToken.length <=
        MAX_VIDEO_GENERATION_SAFETY_ANCESTOR_ID_LENGTH,
  ) && new Set(keys).size === keys.length
    ? ancestors
    : null;
}

function providerResultResumeFromDocument(
  document: Record<string, unknown>,
  submission: Record<string, unknown> | null,
): VideoGenerationReconcileCandidate["providerResultResume"] {
  const providerRequestId = cleanString(submission?.providerRequestId);
  const topLevelRequestId = cleanString(document.providerRequestId);
  const providerRequestLocator = cleanString(document.providerStatusUrl);
  if (
    cleanString(submission?.state) !== "submitted" ||
    !providerRequestId ||
    providerRequestId.length > 500 ||
    topLevelRequestId !== providerRequestId ||
    !providerRequestLocator ||
    providerRequestLocator.length > 500 ||
    /:\/\/|[?#]/.test(providerRequestLocator)
  ) {
    return null;
  }
  return {
    providerRequestId,
    providerRequestLocator,
    pollCount: 0,
    elapsedMs: 0,
  };
}

function candidateFromDocument(
  document: Record<string, unknown>,
): ParsedCandidate {
  const generation = isRecord(document.generation) ? document.generation : null;
  const submission = isRecord(generation?.submission)
    ? generation.submission
    : null;
  const id = identifier(document._id);
  const workspaceId = cleanString(document.workspaceId);
  const rawAttemptToken = submission?.attemptToken;
  const attemptToken = cleanString(rawAttemptToken);
  const status = cleanString(document.status);
  const orchestration = isRecord(generation?.orchestration)
    ? generation.orchestration
    : null;
  const orchestrationState = cleanString(orchestration?.state);
  if (!id || !workspaceId) {
    return { kind: "unscoped", assetId: id || null };
  }
  let completionTarget: VideoGenerationCompletionTarget | null;
  try {
    completionTarget = normalizeVideoGenerationCompletionTarget(
      orchestration?.completionTarget,
    );
  } catch {
    return {
      kind: "invalid",
      assetId: id,
      workspaceId,
      attemptToken:
        typeof rawAttemptToken === "string" ? rawAttemptToken : null,
    };
  }
  const safetyProviderRequestIds = generation
    ? safetyProviderRequestIdsFromGeneration(generation)
    : null;
  const safetyAncestors = generation
    ? safetyAncestorsFromGeneration(generation)
    : null;
  if (
    !attemptToken ||
    (status !== "queued" && status !== "in_progress") ||
    (orchestrationState !== "pending" &&
      orchestrationState !== "unknown" &&
      orchestrationState !== "started") ||
    !isRecord(generation?.spec) ||
    !isRecord(generation.prompt) ||
    safetyProviderRequestIds === null ||
    safetyAncestors === null
  ) {
    return {
      kind: "invalid",
      assetId: id,
      workspaceId,
      attemptToken:
        typeof rawAttemptToken === "string" ? rawAttemptToken : null,
    };
  }
  return {
    kind: "valid",
    candidate: {
      id,
      workspaceId,
      status,
      orchestrationState,
      providerSourceId: cleanString(document.providerSourceId) || null,
      attemptToken,
      spec: generation.spec as VideoGenerationSpec,
      prompt: generation.prompt as CompiledVideoPrompt,
      completionTarget,
      safetyProviderRequestIds,
      safetyAncestors,
      providerResultResume: providerResultResumeFromDocument(
        document,
        submission,
      ),
    },
  };
}

function nsfwCleanupCandidateFromDocument(
  document: Record<string, unknown>,
): NsfwCleanupCandidate | null {
  const generation = isRecord(document.generation) ? document.generation : null;
  const submission = isRecord(generation?.submission)
    ? generation.submission
    : null;
  const candidate = {
    assetId: identifier(document._id),
    workspaceId: cleanString(document.workspaceId),
    attemptToken: cleanString(submission?.attemptToken),
    bucket: cleanString(document.bucket),
    path: cleanString(document.path),
  };
  return Object.values(candidate).every(Boolean) ? candidate : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function cleanupNsfwVideoStorage(
  dependencies: VideoGenerationReconcileDependencies,
  now: Date,
): Promise<void> {
  const {
    loadNsfwCleanupCandidates,
    statNsfwObject,
    deleteNsfwObject,
    clearNsfwStorage,
  } = dependencies;
  if (
    !loadNsfwCleanupCandidates ||
    !statNsfwObject ||
    !deleteNsfwObject ||
    !clearNsfwStorage
  ) {
    return;
  }

  let documents: Record<string, unknown>[];
  try {
    documents = await loadNsfwCleanupCandidates({
      query: {
        kind: "video",
        status: "nsfw",
        storageProvider: "gcs",
        workspaceId: { $type: "string", $ne: "", $regex: /\S/ },
        bucket: { $type: "string", $ne: "", $regex: /\S/ },
        path: { $type: "string", $ne: "", $regex: /\S/ },
        "generation.contractVersion": 1,
        "generation.submission.attemptToken": {
          $type: "string",
          $ne: "",
          $regex: /\S/,
        },
      },
      projection: {
        _id: 1,
        workspaceId: 1,
        bucket: 1,
        path: 1,
        "generation.submission.attemptToken": 1,
      },
      sort: { updatedAt: 1, _id: 1 },
      limit: VIDEO_GENERATION_RECONCILE_LIMIT,
    });
  } catch (error) {
    airiWorkerLogger.warn("video.generation.reconcile.nsfw_cleanup", {
      note: "load_failed",
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return;
  }

  const counters = {
    scanned: documents.length,
    deleted: 0,
    cleared: 0,
    quarantined: 0,
    deferred: 0,
    invalid: 0,
    identityMismatches: 0,
    casMisses: 0,
    failures: 0,
  };
  const deferCandidate = async (candidate: NsfwCleanupCandidate) => {
    if (!dependencies.deferNsfwCleanup) return;
    try {
      const deferred = await dependencies.deferNsfwCleanup({
        ...candidate,
        now,
      });
      if (deferred) counters.deferred += 1;
      else counters.casMisses += 1;
    } catch {
      // The next schedule can retry; keep this failure bounded to counters/logs.
    }
  };
  const cleanup = async (document: Record<string, unknown>) => {
    const candidate = nsfwCleanupCandidateFromDocument(document);
    if (!candidate) {
      counters.invalid += 1;
      return;
    }
    try {
      const stored = await statNsfwObject(candidate);
      if (stored.exists) {
        const identityMatches =
          stored.customMetadata.workspaceId === candidate.workspaceId &&
          stored.customMetadata.assetId === candidate.assetId &&
          stored.customMetadata.attemptTokenHash ===
            sha256(candidate.attemptToken);
        if (!identityMatches) {
          counters.identityMismatches += 1;
          const quarantined = await clearNsfwStorage({ ...candidate, now });
          if (quarantined) {
            counters.cleared += 1;
            counters.quarantined += 1;
          } else {
            counters.casMisses += 1;
          }
          return;
        }
        if (!stored.generation || !stored.metageneration) {
          await deferCandidate(candidate);
          return;
        }
        await deleteNsfwObject({
          ...candidate,
          ifGenerationMatch: stored.generation,
          ifMetagenerationMatch: stored.metageneration,
        });
        counters.deleted += 1;
      }
      const cleared = await clearNsfwStorage({ ...candidate, now });
      if (cleared) counters.cleared += 1;
      else counters.casMisses += 1;
    } catch (error) {
      counters.failures += 1;
      await deferCandidate(candidate);
      airiWorkerLogger.warn("video.generation.reconcile.nsfw_cleanup", {
        note: "candidate_failed",
        assetId: candidate.assetId,
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  };

  const concurrency = 10;
  for (let offset = 0; offset < documents.length; offset += concurrency) {
    await Promise.all(
      documents.slice(offset, offset + concurrency).map(cleanup),
    );
  }
  airiWorkerLogger.info("video.generation.reconcile.nsfw_cleanup", {
    note: "completed",
    ...counters,
  });
}

function createDefaultDependencies(): VideoGenerationReconcileDependencies {
  const config = getTemporalWorkerConfig();
  const queues = {
    mainTaskQueue: config.taskQueue,
    mediaTaskQueue: resolveTemporalMediaTaskQueue(),
  };
  const loadAssetModel = async () => {
    const [mongooseModule, modelModule] = await Promise.all([
      import("@/lib/mongoose"),
      import("@/models/creative-asset"),
    ]);
    await mongooseModule.default();
    return modelModule.CreativeAsset;
  };
  let assetModelPromise: ReturnType<typeof loadAssetModel> | null = null;
  const getAssetModel = () => {
    if (!assetModelPromise) assetModelPromise = loadAssetModel();
    return assetModelPromise;
  };
  const loadNsfwSafetyHelpers = async () => {
    const [store, updates] = await Promise.all([
      import("@/lib/creative-assets/video-generation-nsfw-verdict-store"),
      import("@/lib/creative-assets/video-generation-nsfw"),
    ]);
    return {
      findVerdict: store.findVideoGenerationNsfwVerdict,
      buildUpdate: updates.buildVideoGenerationNsfwUpdatePipeline,
      replayPendingSweeps: store.replayPendingVideoGenerationNsfwVerdictSweeps,
    };
  };
  let nsfwSafetyHelpersPromise: ReturnType<
    typeof loadNsfwSafetyHelpers
  > | null = null;
  const getNsfwSafetyHelpers = () => {
    if (!nsfwSafetyHelpersPromise) {
      nsfwSafetyHelpersPromise = loadNsfwSafetyHelpers();
    }
    return nsfwSafetyHelpersPromise;
  };
  return {
    now: () => new Date(),
    queues,
    async loadCandidates(input) {
      const CreativeAsset = await getAssetModel();
      const documents = await CreativeAsset.find(input.query, input.projection)
        .sort(input.sort)
        .limit(input.limit)
        .lean<Record<string, unknown>[]>();
      return documents;
    },
    async loadNsfwCleanupCandidates(input) {
      const CreativeAsset = await getAssetModel();
      return CreativeAsset.find(input.query, input.projection)
        .sort(input.sort)
        .limit(input.limit)
        .lean<Record<string, unknown>[]>();
    },
    async findNsfwSafetyVerdict(input) {
      await getAssetModel();
      const { findVerdict } = await getNsfwSafetyHelpers();
      return findVerdict(input);
    },
    async markNsfwFromVerdict(input) {
      const [CreativeAsset, { buildUpdate }] = await Promise.all([
        getAssetModel(),
        getNsfwSafetyHelpers(),
      ]);
      const result = await CreativeAsset.updateOne(
        {
          _id: input.assetId,
          workspaceId: input.workspaceId,
          status: { $in: ["queued", "in_progress", "complete", "failed"] },
          "generation.contractVersion": 1,
          "generation.submission.attemptToken": input.attemptToken,
        },
        buildUpdate({
          providerRequestId: input.providerRequestId,
          receivedAt: input.now,
        }),
      );
      return result.matchedCount === 1;
    },
    async replayPendingNsfwVerdictSweeps(input) {
      await getAssetModel();
      const { replayPendingSweeps } = await getNsfwSafetyHelpers();
      return replayPendingSweeps(input);
    },
    async statNsfwObject(input) {
      return statGcsCreativeAssetObject({
        bucket: input.bucket,
        path: input.path,
        workspaceId: input.workspaceId,
      });
    },
    async deleteNsfwObject(input) {
      await deleteGcsCreativeAssetObject({
        bucket: input.bucket,
        path: input.path,
        workspaceId: input.workspaceId,
        ifGenerationMatch: input.ifGenerationMatch,
        ifMetagenerationMatch: input.ifMetagenerationMatch,
      });
    },
    async clearNsfwStorage(input) {
      const CreativeAsset = await getAssetModel();
      const result = await CreativeAsset.updateOne(
        {
          _id: input.assetId,
          workspaceId: input.workspaceId,
          status: "nsfw",
          storageProvider: "gcs",
          bucket: input.bucket,
          path: input.path,
          "generation.contractVersion": 1,
          "generation.submission.attemptToken": input.attemptToken,
        },
        {
          $set: {
            url: null,
            storageProvider: null,
            bucket: null,
            path: null,
            mimeType: null,
            fileName: null,
            fileSize: null,
            "generation.result": null,
            completedAt: null,
            updatedAt: input.now,
          },
        },
      );
      return result.modifiedCount === 1;
    },
    async deferNsfwCleanup(input) {
      const CreativeAsset = await getAssetModel();
      const result = await CreativeAsset.updateOne(
        {
          _id: input.assetId,
          workspaceId: input.workspaceId,
          status: "nsfw",
          storageProvider: "gcs",
          bucket: input.bucket,
          path: input.path,
          "generation.contractVersion": 1,
          "generation.submission.attemptToken": input.attemptToken,
        },
        { $set: { updatedAt: input.now } },
      );
      return result.modifiedCount === 1;
    },
    async startWorkflow(input) {
      const client = await getTemporalClient(config);
      let outcome: VideoGenerationWorkflowStartObservation["outcome"] =
        "started";
      try {
        await client.workflow.start(VIDEO_GENERATION_WORKFLOW, {
          workflowId: input.workflowId,
          taskQueue: input.taskQueue,
          workflowIdReusePolicy: "REJECT_DUPLICATE",
          workflowIdConflictPolicy: "USE_EXISTING",
          args: [input.input],
        });
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError))
          throw error;
        outcome = "already_started";
      }
      const description = await client.workflow
        .getHandle(input.workflowId)
        .describe();
      return { outcome, status: description.status.name };
    },
    async markStarted(input) {
      const CreativeAsset = await getAssetModel();
      const result = await CreativeAsset.updateOne(
        {
          _id: input.assetId,
          workspaceId: input.workspaceId,
          status: { $in: ["queued", "in_progress"] },
          "generation.contractVersion": 1,
          "generation.submission.attemptToken": input.attemptToken,
          "generation.orchestration.state": { $in: ["pending", "unknown"] },
        },
        {
          $set: {
            "generation.orchestration.workflowId": input.workflowId,
            "generation.orchestration.state": "started",
            "generation.orchestration.startedAt": input.now,
            updatedAt: input.now,
          },
        },
      );
      return result.modifiedCount === 1;
    },
    async touchStarted(input) {
      const CreativeAsset = await getAssetModel();
      const result = await CreativeAsset.updateOne(
        {
          _id: input.assetId,
          workspaceId: input.workspaceId,
          status: { $in: ["queued", "in_progress"] },
          "generation.contractVersion": 1,
          "generation.submission.attemptToken": input.attemptToken,
          "generation.orchestration.state": "started",
        },
        {
          $set: {
            "generation.orchestration.workflowId": input.workflowId,
            updatedAt: input.now,
          },
        },
      );
      return result.modifiedCount === 1;
    },
    async markUnknown(input) {
      const CreativeAsset = await getAssetModel();
      const result = await CreativeAsset.updateOne(
        {
          _id: input.assetId,
          workspaceId: input.workspaceId,
          status: { $in: ["queued", "in_progress"] },
          "generation.contractVersion": 1,
          "generation.submission.attemptToken": input.attemptToken,
          "generation.orchestration.state": {
            $in: ["pending", "unknown", "started"],
          },
        },
        {
          $set: {
            "generation.orchestration.workflowId": input.workflowId,
            "generation.orchestration.state": "unknown",
            updatedAt: input.now,
          },
        },
      );
      return result.modifiedCount === 1;
    },
    async markTerminalFailure(input) {
      const CreativeAsset = await getAssetModel();
      const attemptTokenFilter =
        input.attemptToken === null
          ? { $not: { $type: "string" } }
          : input.attemptToken;
      const result = await CreativeAsset.updateOne(
        {
          _id: input.assetId,
          workspaceId: input.workspaceId,
          status: { $in: ["queued", "in_progress"] },
          "generation.contractVersion": 1,
          "generation.submission.attemptToken": attemptTokenFilter,
          "generation.orchestration.state": {
            $in: ["pending", "unknown", "started"],
          },
          ...(input.providerRequestId
            ? {
                providerRequestId: input.providerRequestId,
                "generation.submission.providerRequestId":
                  input.providerRequestId,
              }
            : {}),
          ...(input.providerRequestLocator
            ? { providerStatusUrl: input.providerRequestLocator }
            : {}),
        },
        {
          $set: {
            status: "failed",
            "generation.submission.state": input.submissionState,
            "generation.failure": input.failure,
            error: input.failure.message,
            updatedAt: input.now,
          },
        },
      );
      return result.modifiedCount === 1;
    },
  };
}

export async function reconcileVideoGenerationOrchestration(
  input: VideoGenerationReconcileWorkflowInput,
  providedDependencies?: VideoGenerationReconcileDependencies,
): Promise<VideoGenerationReconcileActivityResult> {
  if (
    input.contractVersion !==
    VIDEO_GENERATION_RECONCILE_WORKFLOW_CONTRACT_VERSION
  ) {
    throw new Error(
      `Unsupported video generation reconcile contract: ${input.contractVersion}`,
    );
  }

  const dependencies = providedDependencies ?? createDefaultDependencies();

  const now = dependencies.now();
  if (dependencies.replayPendingNsfwVerdictSweeps) {
    try {
      const replayed = await dependencies.replayPendingNsfwVerdictSweeps({
        now,
        limit: VIDEO_GENERATION_RECONCILE_LIMIT,
      });
      airiWorkerLogger.info("video.generation.reconcile.nsfw_sweep", {
        note: "completed",
        ...replayed,
      });
    } catch (error) {
      airiWorkerLogger.warn("video.generation.reconcile.nsfw_sweep", {
        note: "unexpected_failure",
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  const nsfwCleanup = cleanupNsfwVideoStorage(dependencies, now).catch(
    (error) => {
      airiWorkerLogger.warn("video.generation.reconcile.nsfw_cleanup", {
        note: "unexpected_failure",
        errorName: error instanceof Error ? error.name : "unknown",
      });
    },
  );
  const documents = await dependencies.loadCandidates({
    query: {
      status: { $in: ["queued", "in_progress"] },
      workspaceId: { $type: "string", $ne: "", $regex: /\S/ },
      "generation.contractVersion": 1,
      $or: [
        {
          "generation.orchestration.state": { $in: ["pending", "unknown"] },
          updatedAt: {
            $lte: new Date(now.getTime() - VIDEO_GENERATION_RECONCILE_STALE_MS),
          },
        },
        {
          "generation.orchestration.state": "started",
          updatedAt: {
            $lte: new Date(
              now.getTime() - VIDEO_GENERATION_RECONCILE_RUNNING_STALE_MS,
            ),
          },
        },
      ],
    },
    projection: {
      _id: 1,
      workspaceId: 1,
      status: 1,
      providerSourceId: 1,
      "generation.spec": 1,
      "generation.prompt": 1,
      providerRequestId: 1,
      providerStatusUrl: 1,
      "generation.submission.attemptToken": 1,
      "generation.submission.state": 1,
      "generation.submission.providerRequestId": 1,
      "generation.safetyProviderRequestIds": 1,
      "generation.safetyAncestors": 1,
      "generation.orchestration.state": 1,
      "generation.orchestration.completionTarget": 1,
    },
    sort: { updatedAt: 1, _id: 1 },
    limit: VIDEO_GENERATION_RECONCILE_LIMIT,
  });

  const result: VideoGenerationReconcileActivityResult = {
    contractVersion: 1,
    scanned: documents.length,
    started: 0,
    alreadyStarted: 0,
    markedStarted: 0,
    unknown: 0,
    invalid: 0,
    unscoped: 0,
    quarantined: 0,
    closed: 0,
    closedFailed: 0,
    casMisses: 0,
  };
  for (const document of documents) {
    const parsed = candidateFromDocument(document);
    if (parsed.kind === "unscoped") {
      result.invalid += 1;
      result.unscoped += 1;
      airiWorkerLogger.warn("video.generation.reconcile.invalid", {
        note: "unscoped_candidate",
        assetId: parsed.assetId,
      });
      continue;
    }
    if (parsed.kind === "invalid") {
      result.invalid += 1;
      const failure = {
        phase: "validation" as const,
        code: "orchestration_record_invalid",
        providerCode: null,
        message: "Queued video generation has incomplete orchestration data",
        retryable: false,
        submissionUncertain: true,
        failedAt: now,
      };
      try {
        const quarantined = await dependencies.markTerminalFailure({
          assetId: parsed.assetId,
          workspaceId: parsed.workspaceId,
          attemptToken: parsed.attemptToken,
          now,
          submissionState: "unknown",
          failure,
        });
        if (quarantined) result.quarantined += 1;
        else result.casMisses += 1;
      } catch (error) {
        airiWorkerLogger.warn("video.generation.reconcile.invalid", {
          note: "quarantine_unknown",
          assetId: parsed.assetId,
          errorName: error instanceof Error ? error.name : "unknown",
        });
      }
      continue;
    }
    const candidate = parsed.candidate;
    const workflowId = buildVideoGenerationWorkflowId({
      assetId: candidate.id,
    });
    const mutation = {
      assetId: candidate.id,
      workspaceId: candidate.workspaceId,
      attemptToken: candidate.attemptToken,
      workflowId,
      now,
    };
    try {
      if (
        candidate.spec.provider === "higgsfield" &&
        dependencies.findNsfwSafetyVerdict &&
        dependencies.markNsfwFromVerdict
      ) {
        const verdict = await dependencies.findNsfwSafetyVerdict({
          workspaceId: candidate.workspaceId,
          providerRequestIds: candidate.safetyProviderRequestIds,
          ancestors: candidate.safetyAncestors,
        });
        if (verdict) {
          const quarantined = await dependencies.markNsfwFromVerdict({
            assetId: candidate.id,
            workspaceId: candidate.workspaceId,
            attemptToken: candidate.attemptToken,
            providerRequestId: verdict.providerRequestId,
            now,
          });
          if (quarantined) result.quarantined += 1;
          else result.casMisses += 1;
          continue;
        }
      }
      const start = await dependencies.startWorkflow({
        workflowId,
        taskQueue: dependencies.queues.mainTaskQueue,
        input: {
          contractVersion: 1,
          workspaceId: candidate.workspaceId,
          assetId: candidate.id,
          attemptToken: candidate.attemptToken,
          spec: candidate.spec,
          prompt: candidate.prompt,
          providerSourceId: candidate.providerSourceId,
          mediaTaskQueue: dependencies.queues.mediaTaskQueue,
          ...(candidate.completionTarget
            ? { completionTarget: candidate.completionTarget }
            : {}),
          ...(candidate.providerResultResume
            ? { resume: candidate.providerResultResume }
            : {}),
        },
      });
      if (start.outcome === "already_started") result.alreadyStarted += 1;
      else result.started += 1;
      if (isClosedWorkflowStatus(start.status)) {
        result.closed += 1;
        const recovery = candidate.providerResultResume;
        const failure = recovery
          ? {
              phase: "poll" as const,
              code: "orchestration_workflow_closed_provider_result",
              providerCode: null,
              message:
                "Temporal video generation closed after provider submission; the provider result can be recovered",
              retryable: true,
              submissionUncertain: false,
              failedAt: now,
            }
          : {
              phase: "submit" as const,
              code: "orchestration_workflow_closed",
              providerCode: null,
              message:
                "Temporal video generation closed before the asset reached a terminal state",
              retryable: true,
              submissionUncertain: true,
              failedAt: now,
            };
        const failed = await dependencies.markTerminalFailure({
          assetId: candidate.id,
          workspaceId: candidate.workspaceId,
          attemptToken: candidate.attemptToken,
          now,
          submissionState: recovery ? "submitted" : "unknown",
          ...(recovery
            ? {
                providerRequestId: recovery.providerRequestId,
                providerRequestLocator: recovery.providerRequestLocator,
              }
            : {}),
          failure,
        });
        if (failed) result.closedFailed += 1;
        else result.casMisses += 1;
        airiWorkerLogger.warn("video.generation.reconcile.start", {
          note: failed ? "closed_terminalized" : "closed_cas_miss",
          assetId: candidate.id,
          workflowStatus: start.status,
        });
        continue;
      }
      if (start.status !== "RUNNING")
        throw new Error("Temporal workflow status could not be classified");
      const marked =
        candidate.orchestrationState === "started"
          ? await dependencies.touchStarted(mutation)
          : await dependencies.markStarted(mutation);
      if (marked) result.markedStarted += 1;
      else result.casMisses += 1;
    } catch (error) {
      result.unknown += 1;
      await dependencies.markUnknown(mutation).catch(() => false);
      airiWorkerLogger.warn("video.generation.reconcile.start", {
        note: "start_unknown",
        assetId: candidate.id,
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  await nsfwCleanup;
  airiWorkerLogger.info("video.generation.reconcile", {
    note: "completed",
    ...result,
  });
  return result;
}

export const videoGenerationReconcileActivity =
  reconcileVideoGenerationOrchestration;

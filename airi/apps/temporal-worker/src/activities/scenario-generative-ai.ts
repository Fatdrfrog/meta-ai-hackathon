import {
  AIRI_SCENARIO_GENERATIVE_AI_VIDEO_COMPLETION_SIGNAL,
  buildVideoGenerationWorkflowId,
  buildCreativeImageGenerationWorkflowId,
  normalizeAiriScenarioGenerativeAIResultEvent,
  normalizeAiriScenarioGenerativeAIWorkflowInput,
  type AiriScenarioGenerativeAIResultEvent,
  type AiriScenarioGenerativeAIWorkflowInput,
  type CreativeImageGenerationWorkflowInput,
} from "@icecore/temporal";
import { ApplicationFailure } from "@temporalio/activity";
import { createHash } from "node:crypto";
import {
  isSameGenerativeAIReferenceImageList,
  MAX_GENERATIVE_AI_IMAGE_PROMPT_CHARACTERS,
  normalizeGenerativeAIImageConfig,
  type GenerativeAIExecution,
  type GenerativeAIImageConfig,
} from "@icecore/airi-runtime/generative-ai-auto-reply";

import type { VideoAssetRecord } from "@/lib/creative-assets/video-generation-queue";

import { resolveTemporalMediaTaskQueue } from "../config.js";
import {
  scenarioGenerativeWhatsAppSourceActivity,
  type ScenarioGenerativeSourceInput,
} from "./scenario-generative-source.js";

export type ScenarioGenerativeAIExecutionOwner = Pick<
  GenerativeAIExecution,
  | "executionId"
  | "phase"
  | "scenarioId"
  | "scenarioRevisionFingerprint"
  | "actionNodeId"
  | "inputMessageId"
  | "mode"
  | "composedPrompt"
  | "scenarioWorkflowId"
  | "sourceMedia"
  | "assetId"
  | "videoWorkflowId"
  | "imageConfig"
>;

export type ScenarioGenerativeAIVideoAsset = VideoAssetRecord;

type ExecutionPhase = ScenarioGenerativeAIExecutionOwner["phase"];
type OwnerScope = {
  workspaceId: string;
  conversationId: string;
  executionId: string;
  scenarioId: string;
  scenarioRevisionFingerprint: string;
  actionNodeId: string;
};
type LoadOwned = (
  input: AiriScenarioGenerativeAIWorkflowInput,
  expectedPhase: ExecutionPhase,
) => Promise<ScenarioGenerativeAIExecutionOwner | null>;
type Advance = (
  input: OwnerScope & {
    expectedPhase: ExecutionPhase;
    nextPhase: ExecutionPhase;
    updates?: {
      assetId?: string;
      videoWorkflowId?: string;
    };
  },
) => Promise<ScenarioGenerativeAIExecutionOwner | null>;

export type ScenarioGenerativeAIBeginResult = {
  contractVersion: 1;
  mode: ScenarioGenerativeAIExecutionOwner["mode"];
  phase: "importing_source" | "preparing_generation";
  mediaTaskQueue: string;
};

export type ScenarioGenerativeAIImportResult = {
  contractVersion: 1;
  sourceAssetId: string;
};

export type ScenarioGenerativeAIAcceptInput =
  AiriScenarioGenerativeAIWorkflowInput & {
    sourceAssetId: string | null;
  };

export type ScenarioGenerativeAIAcceptResult = {
  contractVersion: 1;
  assetId: string;
  attemptToken: string;
  videoWorkflowId: string;
};

export type ScenarioGenerativeAIStartInput =
  AiriScenarioGenerativeAIWorkflowInput & ScenarioGenerativeAIAcceptResult;

export type ScenarioGenerativeAIStartResult = {
  contractVersion: 1;
  assetId: string;
  videoWorkflowId: string;
};

export type ScenarioGenerativeAIImageAsset = {
  _id: string;
  workspaceId: string;
  kind: "image";
  source: GenerativeAIImageConfig["provider"];
  provider: GenerativeAIImageConfig["provider"];
  status: string;
  prompt: string;
  modelId: string;
  providerSourceId: string;
  providerPayload: {
    aspectRatio: string;
    referenceImages: GenerativeAIImageConfig["referenceImages"];
    scenario: {
      executionId: string;
      workflowId: string;
      attemptToken: string;
      imageConfig: GenerativeAIImageConfig;
      completionTarget: {
        workflowId: string;
        signalName: string;
        correlationId: string;
      };
    };
  };
};

export type ScenarioGenerativeAIImageAcceptResult =
  ScenarioGenerativeAIAcceptResult & {
    imageInput: CreativeImageGenerationWorkflowInput;
  };

type AcceptedVideo = {
  asset: ScenarioGenerativeAIVideoAsset;
  workflowInput: {
    contractVersion: 1;
    workspaceId: string;
    assetId: string;
    attemptToken: string;
  };
};

function failClosed(message: string): never {
  throw ApplicationFailure.nonRetryable(
    message,
    "ScenarioGenerativeAIInvalidOwner",
  );
}

function commandOnly(
  input:
    | AiriScenarioGenerativeAIWorkflowInput
    | ScenarioGenerativeAIAcceptInput
    | ScenarioGenerativeAIStartInput,
): AiriScenarioGenerativeAIWorkflowInput {
  return normalizeAiriScenarioGenerativeAIWorkflowInput({
    version: input.version,
    kind: input.kind,
    workflowId: input.workflowId,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    executionId: input.executionId,
    scenarioId: input.scenarioId,
    scenarioRevisionFingerprint: input.scenarioRevisionFingerprint,
    actionNodeId: input.actionNodeId,
  });
}

function ownerScope(input: AiriScenarioGenerativeAIWorkflowInput): OwnerScope {
  return {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    executionId: input.executionId,
    scenarioId: input.scenarioId,
    scenarioRevisionFingerprint: input.scenarioRevisionFingerprint,
    actionNodeId: input.actionNodeId,
  };
}

function exactString(value: unknown, field: string, maxLength = 128): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.length > maxLength
  ) {
    failClosed(`Scenario Generative AI ${field} is invalid`);
  }
  return value;
}

function assertOwnedExecution(
  execution: ScenarioGenerativeAIExecutionOwner,
  input: AiriScenarioGenerativeAIWorkflowInput,
): void {
  if (
    execution.executionId !== input.executionId ||
    execution.scenarioId !== input.scenarioId ||
    execution.scenarioRevisionFingerprint !==
      input.scenarioRevisionFingerprint ||
    execution.actionNodeId !== input.actionNodeId ||
    execution.scenarioWorkflowId !== input.workflowId
  ) {
    failClosed("Scenario Generative AI execution owner does not match");
  }
}

function destinationPhase(
  mode: ScenarioGenerativeAIExecutionOwner["mode"],
): ScenarioGenerativeAIBeginResult["phase"] {
  return mode === "image_to_video"
    ? "importing_source"
    : "preparing_generation";
}

function acceptedImageIdentity(
  input: AiriScenarioGenerativeAIWorkflowInput,
  asset: ScenarioGenerativeAIImageAsset,
): ScenarioGenerativeAIImageAcceptResult {
  const scenario = asset.providerPayload?.scenario;
  const image = normalizeGenerativeAIImageConfig(scenario?.imageConfig);
  const assetId = exactString(String(asset._id || ""), "image asset id");
  const workflowId = buildCreativeImageGenerationWorkflowId({ assetId });
  if (
    asset.workspaceId !== input.workspaceId ||
    asset.kind !== "image" ||
    !image ||
    asset.provider !== image.provider ||
    asset.source !== image.provider ||
    image.sourceId !== asset.providerSourceId ||
    image.modelId !== asset.modelId ||
    scenario?.executionId !== input.executionId ||
    scenario.workflowId !== workflowId ||
    scenario.completionTarget?.workflowId !== input.workflowId ||
    scenario.completionTarget.signalName !==
      AIRI_SCENARIO_GENERATIVE_AI_VIDEO_COMPLETION_SIGNAL ||
    scenario.completionTarget.correlationId !== input.executionId ||
    asset.providerPayload.aspectRatio !== image.aspectRatio ||
    !isSameGenerativeAIReferenceImageList(
      asset.providerPayload.referenceImages,
      image.referenceImages,
    )
  )
    failClosed("Scenario Generative AI image identity does not match");
  return {
    contractVersion: 1,
    assetId,
    attemptToken: exactString(scenario.attemptToken, "image attempt token"),
    // Keep the existing event wire field stable for running video histories.
    videoWorkflowId: workflowId,
    imageInput: {
      contractVersion: 1,
      workspaceId: input.workspaceId,
      assetId,
      provider: image.provider,
      providerSourceId: image.sourceId,
      modelId: image.modelId,
      prompt: exactString(
        asset.prompt,
        "image prompt",
        MAX_GENERATIVE_AI_IMAGE_PROMPT_CHARACTERS,
      ),
      aspectRatio: image.aspectRatio,
      referenceImages: image.referenceImages,
    },
  };
}

export async function acceptScenarioGenerativeAIImageActivityWithDependencies(
  value: AiriScenarioGenerativeAIWorkflowInput,
  dependencies: {
    loadOwned: LoadOwned;
    advance: Advance;
    findAcceptedImage: (input: {
      workspaceId: string;
      executionId: string;
      assetId: string;
    }) => Promise<ScenarioGenerativeAIImageAsset | null>;
    assertSource: (input: {
      workspaceId: string;
      provider: GenerativeAIImageConfig["provider"];
      providerSourceId: string;
    }) => Promise<void>;
    createImage: (
      asset: ScenarioGenerativeAIImageAsset,
    ) => Promise<ScenarioGenerativeAIImageAsset>;
  },
): Promise<ScenarioGenerativeAIImageAcceptResult> {
  const input = commandOnly(value);
  const digest = createHash("sha256")
    .update("airi.scenario-image.v1\0")
    .update(input.workspaceId)
    .update("\0")
    .update(input.executionId)
    .digest("hex");
  const assetId = digest.slice(0, 24);
  const persisted = await dependencies.findAcceptedImage({ ...input, assetId });
  if (persisted) {
    const identity = acceptedImageIdentity(input, persisted);
    await synchronizeGeneratingOwner(input, identity, dependencies);
    return identity;
  }
  const owner = await dependencies.loadOwned(input, "preparing_generation");
  if (!owner || owner.mode !== "text_to_image")
    failClosed("Scenario Generative AI image owner is unavailable");
  assertOwnedExecution(owner, input);
  const image = normalizeGenerativeAIImageConfig(owner.imageConfig);
  if (!image) failClosed("Scenario Generative AI image settings are invalid");
  await dependencies.assertSource({
    workspaceId: input.workspaceId,
    provider: image.provider,
    providerSourceId: image.sourceId,
  });
  const asset = await dependencies.createImage({
    _id: assetId,
    workspaceId: input.workspaceId,
    kind: "image",
    source: image.provider,
    provider: image.provider,
    status: "queued",
    prompt: exactString(
      owner.composedPrompt,
      "image prompt",
      MAX_GENERATIVE_AI_IMAGE_PROMPT_CHARACTERS,
    ),
    modelId: image.modelId,
    providerSourceId: image.sourceId,
    providerPayload: {
      aspectRatio: image.aspectRatio,
      referenceImages: image.referenceImages,
      scenario: {
        executionId: input.executionId,
        workflowId: buildCreativeImageGenerationWorkflowId({ assetId }),
        attemptToken: digest,
        imageConfig: image,
        completionTarget: {
          workflowId: input.workflowId,
          signalName: AIRI_SCENARIO_GENERATIVE_AI_VIDEO_COMPLETION_SIGNAL,
          correlationId: input.executionId,
        },
      },
    },
  });
  const identity = acceptedImageIdentity(input, asset);
  await synchronizeGeneratingOwner(input, identity, dependencies);
  return identity;
}

export async function beginScenarioGenerativeAIActivityWithDependencies(
  value: AiriScenarioGenerativeAIWorkflowInput,
  dependencies: {
    mediaTaskQueue: () => string;
    loadOwned: LoadOwned;
    advance: Advance;
  },
): Promise<ScenarioGenerativeAIBeginResult> {
  const input = commandOnly(value);
  let owner = await dependencies.loadOwned(input, "accepted");
  if (owner) {
    assertOwnedExecution(owner, input);
    const nextPhase = destinationPhase(owner.mode);
    owner =
      (await dependencies.advance({
        ...ownerScope(input),
        expectedPhase: "accepted",
        nextPhase,
      })) ?? (await dependencies.loadOwned(input, nextPhase));
  } else {
    owner =
      (await dependencies.loadOwned(input, "importing_source")) ??
      (await dependencies.loadOwned(input, "preparing_generation"));
  }
  if (!owner) {
    failClosed("Scenario Generative AI execution is unavailable");
  }
  assertOwnedExecution(owner, input);
  const phase = destinationPhase(owner.mode);
  if (owner.phase !== phase) {
    failClosed("Scenario Generative AI execution phase is invalid");
  }
  return {
    contractVersion: 1,
    mode: owner.mode,
    phase,
    mediaTaskQueue: exactString(
      dependencies.mediaTaskQueue(),
      "media task queue",
      256,
    ),
  };
}

export async function importScenarioGenerativeAISourceActivityWithDependencies(
  value: AiriScenarioGenerativeAIWorkflowInput,
  dependencies: {
    loadOwned: LoadOwned;
    importSource: (
      input: ScenarioGenerativeSourceInput,
    ) => Promise<{ assetId: string; mimeType: string; fileSize: number }>;
  },
): Promise<ScenarioGenerativeAIImportResult> {
  const input = commandOnly(value);
  const owner = await dependencies.loadOwned(input, "importing_source");
  if (!owner) {
    failClosed("Scenario Generative AI image execution is unavailable");
  }
  assertOwnedExecution(owner, input);
  if (owner.mode !== "image_to_video" || !owner.sourceMedia) {
    failClosed("Scenario Generative AI image source is unavailable");
  }
  const imported = await dependencies.importSource({
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    inputMessageId: owner.inputMessageId,
    whatsappMediaId: owner.sourceMedia.whatsappMediaId,
    declaredMimeType: owner.sourceMedia.declaredMimeType,
    fileName: owner.sourceMedia.fileName,
  });
  return {
    contractVersion: 1,
    sourceAssetId: exactString(imported.assetId, "source asset id"),
  };
}

function validateAcceptedVideoAsset(
  input: AiriScenarioGenerativeAIWorkflowInput,
  asset: ScenarioGenerativeAIVideoAsset,
): ScenarioGenerativeAIAcceptResult {
  const assetId = exactString(String(asset._id || ""), "asset id");
  if (
    asset.workspaceId !== input.workspaceId ||
    asset.generation?.contractVersion !== 1
  ) {
    failClosed("Scenario Generative AI video identity does not match");
  }
  const completionTarget = asset.generation.orchestration.completionTarget;
  if (
    completionTarget?.workflowId !== input.workflowId ||
    completionTarget.signalName !==
      AIRI_SCENARIO_GENERATIVE_AI_VIDEO_COMPLETION_SIGNAL ||
    completionTarget.correlationId !== input.executionId
  ) {
    failClosed("Scenario Generative AI video completion target does not match");
  }
  return {
    contractVersion: 1,
    assetId,
    attemptToken: exactString(
      asset.generation.submission.attemptToken,
      "attempt token",
    ),
    videoWorkflowId: buildVideoGenerationWorkflowId({ assetId }),
  };
}

function ownerMatchesCommand(
  owner: ScenarioGenerativeAIExecutionOwner,
  input: AiriScenarioGenerativeAIWorkflowInput,
): boolean {
  return (
    owner.executionId === input.executionId &&
    owner.scenarioId === input.scenarioId &&
    owner.scenarioRevisionFingerprint === input.scenarioRevisionFingerprint &&
    owner.actionNodeId === input.actionNodeId &&
    owner.scenarioWorkflowId === input.workflowId
  );
}

async function synchronizeGeneratingOwner(
  input: AiriScenarioGenerativeAIWorkflowInput,
  identity: ScenarioGenerativeAIAcceptResult,
  dependencies: {
    loadOwned: LoadOwned;
    advance: Advance;
  },
): Promise<void> {
  const generatingOwner = await dependencies.loadOwned(input, "generating");
  if (generatingOwner) return;
  const preparingOwner = await dependencies.loadOwned(
    input,
    "preparing_generation",
  );
  if (!preparingOwner) return;
  if (!ownerMatchesCommand(preparingOwner, input)) return;
  await dependencies.advance({
    ...ownerScope(input),
    expectedPhase: "preparing_generation",
    nextPhase: "generating",
    updates: {
      assetId: identity.assetId,
      videoWorkflowId: identity.videoWorkflowId,
    },
  });
}

export async function acceptScenarioGenerativeAIVideoActivityWithDependencies(
  value: ScenarioGenerativeAIAcceptInput,
  dependencies: {
    loadOwned: LoadOwned;
    advance: Advance;
    acceptVideo: (input: {
      workspaceId: string;
      createdBy: null;
      idempotencyKey: string;
      providerPolicy: { provider: "happyhorse" };
      request:
        | {
            mode: "text_to_video";
            skill: "video";
            prompt: string;
            durationSeconds: 5;
            resolution: "720P";
            aspectRatio: "9:16";
          }
        | {
            mode: "image_to_video";
            skill: "video";
            prompt: string;
            durationSeconds: 5;
            resolution: "720P";
            sourceAssetId: string;
          };
      completionTarget: {
        workflowId: string;
        signalName: string;
        correlationId: string;
      };
    }) => Promise<AcceptedVideo>;
    findAcceptedVideo: (input: {
      workspaceId: string;
      executionId: string;
      workflowId: string;
    }) => Promise<ScenarioGenerativeAIVideoAsset | null>;
  },
): Promise<ScenarioGenerativeAIAcceptResult> {
  const input = commandOnly(value);
  const persistedAsset = await dependencies.findAcceptedVideo({
    workspaceId: input.workspaceId,
    executionId: input.executionId,
    workflowId: input.workflowId,
  });
  if (persistedAsset) {
    const identity = validateAcceptedVideoAsset(input, persistedAsset);
    await synchronizeGeneratingOwner(input, identity, dependencies);
    return identity;
  }

  let preparingOwner = await dependencies.loadOwned(
    input,
    "preparing_generation",
  );
  if (!preparingOwner) {
    const importingOwner = await dependencies.loadOwned(
      input,
      "importing_source",
    );
    if (!importingOwner || importingOwner.mode !== "image_to_video") {
      failClosed("Scenario Generative AI preparation owner is unavailable");
    }
    assertOwnedExecution(importingOwner, input);
    preparingOwner =
      (await dependencies.advance({
        ...ownerScope(input),
        expectedPhase: "importing_source",
        nextPhase: "preparing_generation",
      })) ?? (await dependencies.loadOwned(input, "preparing_generation"));
  }
  if (!preparingOwner) {
    failClosed("Scenario Generative AI preparation phase is unavailable");
  }
  assertOwnedExecution(preparingOwner, input);

  const common = {
    workspaceId: input.workspaceId,
    createdBy: null,
    idempotencyKey: input.executionId,
    providerPolicy: { provider: "happyhorse" as const },
    completionTarget: {
      workflowId: input.workflowId,
      signalName: AIRI_SCENARIO_GENERATIVE_AI_VIDEO_COMPLETION_SIGNAL,
      correlationId: input.executionId,
    },
  };
  const accepted = await dependencies.acceptVideo({
    ...common,
    request:
      preparingOwner.mode === "text_to_video"
        ? {
            mode: "text_to_video" as const,
            skill: "video" as const,
            prompt: preparingOwner.composedPrompt,
            durationSeconds: 5 as const,
            resolution: "720P" as const,
            aspectRatio: "9:16" as const,
          }
        : {
            mode: "image_to_video" as const,
            skill: "video" as const,
            prompt: preparingOwner.composedPrompt,
            durationSeconds: 5 as const,
            resolution: "720P" as const,
            sourceAssetId: exactString(value.sourceAssetId, "source asset id"),
          },
  });
  const assetId = exactString(
    String(accepted.asset._id || accepted.workflowInput.assetId || ""),
    "asset id",
  );
  const videoWorkflowId = buildVideoGenerationWorkflowId({ assetId });
  const identity = validateAcceptedVideoAsset(input, accepted.asset);
  if (
    identity.attemptToken !== accepted.workflowInput.attemptToken ||
    identity.assetId !== accepted.workflowInput.assetId ||
    identity.videoWorkflowId !== videoWorkflowId
  ) {
    failClosed("Scenario Generative AI accepted video identity changed");
  }
  await synchronizeGeneratingOwner(input, identity, dependencies);
  return identity;
}

export async function startScenarioGenerativeAIVideoActivityWithDependencies(
  value: ScenarioGenerativeAIStartInput,
  dependencies: {
    loadVideoAsset: (input: {
      workspaceId: string;
      assetId: string;
    }) => Promise<ScenarioGenerativeAIVideoAsset | null>;
    ensureStarted: (
      asset: ScenarioGenerativeAIVideoAsset,
    ) => Promise<ScenarioGenerativeAIVideoAsset>;
  },
): Promise<ScenarioGenerativeAIStartResult> {
  const input = commandOnly(value);
  const asset = await dependencies.loadVideoAsset({
    workspaceId: input.workspaceId,
    assetId: value.assetId,
  });
  if (!asset) {
    failClosed("Scenario Generative AI video asset is unavailable");
  }
  const identity = validateAcceptedVideoAsset(input, asset);
  if (
    identity.assetId !== value.assetId ||
    identity.attemptToken !== value.attemptToken ||
    identity.videoWorkflowId !== value.videoWorkflowId
  ) {
    failClosed("Scenario Generative AI start identity does not match");
  }
  await dependencies.ensureStarted(asset);
  return {
    contractVersion: 1,
    assetId: identity.assetId,
    videoWorkflowId: identity.videoWorkflowId,
  };
}

export async function reportScenarioGenerativeAIResultActivityWithDependencies(
  value: AiriScenarioGenerativeAIResultEvent,
  dependencies: {
    report: (event: AiriScenarioGenerativeAIResultEvent) => Promise<unknown>;
  },
): Promise<void> {
  const event = normalizeAiriScenarioGenerativeAIResultEvent(value);
  await dependencies.report(event);
}

async function loadExecutionStoreDependencies(): Promise<{
  loadOwned: LoadOwned;
  advance: Advance;
}> {
  const store = await import(
    "@/lib/airi/reply/runtime/generative-ai-execution-store"
  );
  return {
    loadOwned: (input, expectedPhase) =>
      store.loadGenerativeExecutionIfOwned({
        ...ownerScope(input),
        expectedPhase,
      }),
    advance: (input) => store.advanceGenerativeExecutionPhase(input),
  };
}

async function loadCreativeAssetModel() {
  const [{ default: connectDB }, { CreativeAsset }] = await Promise.all([
    import("@/lib/mongoose"),
    import("@/models/creative-asset"),
  ]);
  await connectDB();
  return CreativeAsset;
}

async function loadVideoAsset(input: {
  workspaceId: string;
  assetId: string;
}): Promise<ScenarioGenerativeAIVideoAsset | null> {
  const CreativeAsset = await loadCreativeAssetModel();
  return CreativeAsset.findOne({
    _id: input.assetId,
    workspaceId: input.workspaceId,
  }).lean<ScenarioGenerativeAIVideoAsset | null>();
}

async function findAcceptedVideoAsset(input: {
  workspaceId: string;
  executionId: string;
  workflowId: string;
}): Promise<ScenarioGenerativeAIVideoAsset | null> {
  const CreativeAsset = await loadCreativeAssetModel();
  return CreativeAsset.findOne({
    workspaceId: input.workspaceId,
    "generation.contractVersion": 1,
    "generation.requestIdempotencyKey": input.executionId,
    "generation.orchestration.completionTarget.workflowId": input.workflowId,
    "generation.orchestration.completionTarget.signalName":
      AIRI_SCENARIO_GENERATIVE_AI_VIDEO_COMPLETION_SIGNAL,
    "generation.orchestration.completionTarget.correlationId":
      input.executionId,
  }).lean<ScenarioGenerativeAIVideoAsset | null>();
}

export async function beginScenarioGenerativeAIActivity(
  input: AiriScenarioGenerativeAIWorkflowInput,
): Promise<ScenarioGenerativeAIBeginResult> {
  const store = await loadExecutionStoreDependencies();
  return beginScenarioGenerativeAIActivityWithDependencies(input, {
    ...store,
    mediaTaskQueue: resolveTemporalMediaTaskQueue,
  });
}

export async function acceptScenarioGenerativeAIImageActivity(
  input: AiriScenarioGenerativeAIWorkflowInput,
): Promise<ScenarioGenerativeAIImageAcceptResult> {
  const [store, CreativeAsset, credentials] = await Promise.all([
    loadExecutionStoreDependencies(),
    loadCreativeAssetModel(),
    import("@/lib/google/creative-credentials"),
  ]);
  try {
    return await acceptScenarioGenerativeAIImageActivityWithDependencies(
      input,
      {
        ...store,
        findAcceptedImage: ({ workspaceId, assetId }) =>
          CreativeAsset.findOne({
            _id: assetId,
            workspaceId,
            kind: "image",
          }).lean<ScenarioGenerativeAIImageAsset | null>(),
        assertSource: async ({ provider, ...scope }) => {
          await (provider === "elevenlabs"
            ? credentials.resolveElevenLabsCreativeWorkerApiKey(scope)
            : credentials.resolveGoogleCreativeWorkerApiKey(scope));
        },
        createImage: async (asset) => {
          // Mongo's _id unique index is the durable admission fence across activity retries.
          const existing = await CreativeAsset.findOneAndUpdate(
            { _id: asset._id, workspaceId: asset.workspaceId },
            { $setOnInsert: asset },
            { upsert: true, new: true, setDefaultsOnInsert: true },
          ).lean<ScenarioGenerativeAIImageAsset | null>();
          if (!existing)
            failClosed("Scenario Generative AI image admission is unavailable");
          return existing;
        },
      },
    );
  } catch (error) {
    // A source that could not be read right now retries; nothing was created.
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "own_ai_source_required" &&
      !credentials.isCreativeAiSourceLookupUnavailable(error)
    ) {
      throw ApplicationFailure.nonRetryable(
        "Connect your own image generation source to generate images",
        "own_ai_source_required",
      );
    }
    throw error;
  }
}

export async function importScenarioGenerativeAISourceActivity(
  input: AiriScenarioGenerativeAIWorkflowInput,
): Promise<ScenarioGenerativeAIImportResult> {
  const store = await loadExecutionStoreDependencies();
  return importScenarioGenerativeAISourceActivityWithDependencies(input, {
    loadOwned: store.loadOwned,
    importSource: scenarioGenerativeWhatsAppSourceActivity,
  });
}

export async function acceptScenarioGenerativeAIVideoActivity(
  input: ScenarioGenerativeAIAcceptInput,
): Promise<ScenarioGenerativeAIAcceptResult> {
  const [store, queue] = await Promise.all([
    loadExecutionStoreDependencies(),
    import("@/lib/creative-assets/video-generation-queue"),
  ]);
  try {
    return await acceptScenarioGenerativeAIVideoActivityWithDependencies(
      input,
      {
        ...store,
        acceptVideo: queue.acceptVideoGeneration,
        findAcceptedVideo: findAcceptedVideoAsset,
      },
    );
  } catch (error) {
    if (
      error instanceof queue.VideoGenerationQueueError &&
      error.status !== 503
    ) {
      throw ApplicationFailure.nonRetryable(
        "Scenario Generative AI video preparation was rejected",
        `ScenarioGenerativeAIPreparation:${error.code}`,
      );
    }
    throw error;
  }
}

export async function startScenarioGenerativeAIVideoActivity(
  input: ScenarioGenerativeAIStartInput,
): Promise<ScenarioGenerativeAIStartResult> {
  const queue = await import("@/lib/creative-assets/video-generation-queue");
  try {
    return await startScenarioGenerativeAIVideoActivityWithDependencies(input, {
      loadVideoAsset,
      ensureStarted: queue.ensureVideoGenerationWorkflowStarted,
    });
  } catch (error) {
    if (
      error instanceof queue.VideoGenerationQueueError &&
      error.status !== 503
    ) {
      throw ApplicationFailure.nonRetryable(
        "Scenario Generative AI video start was rejected",
        `ScenarioGenerativeAIStart:${error.code}`,
      );
    }
    throw error;
  }
}

export async function reportScenarioGenerativeAIResultActivity(
  event: AiriScenarioGenerativeAIResultEvent,
): Promise<void> {
  const { signalWithStartAiriConversationExternalEvent } = await import(
    "@/lib/temporal/client"
  );
  return reportScenarioGenerativeAIResultActivityWithDependencies(event, {
    report: signalWithStartAiriConversationExternalEvent,
  });
}

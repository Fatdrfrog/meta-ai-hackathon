jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));

import {
  CREATIVE_ASSET_EDIT_TASK_QUEUE,
  VIDEO_GENERATION_WORKFLOW_CONTRACT_VERSION,
  type CompiledVideoPrompt,
  type VideoGenerationSpec,
} from "@icecore/temporal";
import type { CreativeAssetVideoGeneration } from "@/models/creative-asset";
import {
  VideoGenerationWorkflowNotRunningError,
  VideoGenerationWorkflowStartAmbiguousError,
} from "@/lib/temporal/video-generation";
import {
  acceptVideoGeneration,
  buildVideoRecipeFingerprint,
  queueVideoGeneration,
  retryVideoGeneration,
  type QueueVideoGenerationDependencies,
  type QueueVideoGenerationInput,
} from "./video-generation-queue";
import { MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_IDS } from "./video-generation-nsfw";

const WORKSPACE_ID = "workspace-1";
const SOURCE_1 = "507f1f77bcf86cd799439011";
const SOURCE_2 = "507f1f77bcf86cd799439012";
const SOURCE_3 = "507f1f77bcf86cd799439013";
const ASSET_ID = "507f1f77bcf86cd799439021";
const CHILD_ID = "507f1f77bcf86cd799439022";

type PersistedAsset = Record<string, unknown> & {
  _id: string;
  id?: string;
  status: string;
  providerSourceId?: string | null;
  generation: CreativeAssetVideoGeneration;
};

function happyHorseInput(
  overrides: Partial<QueueVideoGenerationInput["request"]> = {}
): QueueVideoGenerationInput {
  return {
    workspaceId: WORKSPACE_ID,
    createdBy: "user-1",
    idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
    providerPolicy: { provider: "happyhorse" },
    request: {
      mode: "text_to_video",
      prompt: "A polished product reveal",
      skill: "video",
      durationSeconds: 5,
      aspectRatio: "9:16",
      resolution: "1080P",
      sourceAssetId: null,
      referenceAssetIds: [],
      seed: null,
      ...overrides,
    },
  };
}

function googleInput(): QueueVideoGenerationInput {
  return {
    workspaceId: WORKSPACE_ID,
    createdBy: "user-1",
    idempotencyKey: "123e4567-e89b-42d3-a456-426614174001",
    providerPolicy: { provider: "google", providerSourceId: "google-source" },
    request: {
      mode: "image_to_video",
      prompt: "Animate the product",
      skill: "video",
      durationSeconds: 6,
      aspectRatio: "9:16",
      resolution: "720p",
      sourceAssetId: SOURCE_1,
      referenceAssetIds: [],
      seed: null,
    },
  };
}

function source(id: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: id,
    workspaceId: WORKSPACE_ID,
    kind: "image",
    status: "complete",
    ...overrides,
  };
}

function makeDependencies(
  overrides: Partial<QueueVideoGenerationDependencies> = {}
) {
  const findSources = jest.fn().mockResolvedValue([]);
  const findAsset = jest.fn().mockResolvedValue(null);
  const ensureIndexes = jest.fn().mockResolvedValue(undefined);
  const createAsset: jest.MockedFunction<
    QueueVideoGenerationDependencies["createAsset"]
  > = jest.fn(
    async (value: Record<string, unknown>) =>
      ({
        ...value,
        id: String(value._id),
      }) as Awaited<ReturnType<QueueVideoGenerationDependencies["createAsset"]>>
  );
  const compareAndSetOrchestration = jest.fn().mockResolvedValue(null);
  const findNsfwProviderRequestAlias = jest.fn().mockResolvedValue(null);
  const findNsfwSafetyVerdict = jest.fn().mockResolvedValue(null);
  const markAssetNsfwFromAlias = jest.fn().mockResolvedValue(true);
  const mergeAssetSafetyLineage: jest.MockedFunction<
    QueueVideoGenerationDependencies["mergeAssetSafetyLineage"]
  > = jest.fn(async input => {
    const generation = input.asset.generation;
    if (!generation) return null;
    return {
      ...input.asset,
      generation: {
        ...generation,
        safetyProviderRequestIds: Array.from(
          new Set([
            ...(generation.safetyProviderRequestIds ?? []),
            ...input.providerRequestIds,
          ])
        ),
        safetyAncestors: [
          ...(generation.safetyAncestors ?? []),
          ...input.ancestors,
        ],
      },
    };
  });
  const withPlatformQuotaAdmission = jest.fn(
    async <T>(
      input: {
        workspaceId: string;
        limit: number;
        claimKey: string;
        assetId: string;
      },
      run: (reservation: { assetId: string; replay: boolean }) => Promise<T>
    ) => {
      const value = await run({ assetId: input.assetId, replay: false });
      return {
        accepted: true as const,
        replay: false,
        value,
        quota: { limit: input.limit, used: 1, remaining: input.limit - 1 },
      };
    }
  ) as jest.MockedFunction<
    QueueVideoGenerationDependencies["withPlatformQuotaAdmission"]
  >;
  const getGoogleGenerationLimit = jest.fn(() => 10);
  const isGoogleGenerationConfigured = jest.fn(() => true);
  const startWorkflow = jest.fn().mockResolvedValue({
    workflowId: `video-generation:${ASSET_ID}`,
    duplicate: false,
  });
  const deps: QueueVideoGenerationDependencies = {
    validateCustomerCredentials: jest.fn().mockResolvedValue(undefined),
    ensureIndexes,
    findSources,
    findAsset,
    createAsset,
    compareAndSetOrchestration,
    findNsfwProviderRequestAlias,
    findNsfwSafetyVerdict,
    markAssetNsfwFromAlias,
    mergeAssetSafetyLineage,
    withPlatformQuotaAdmission,
    getGoogleGenerationLimit,
    isGoogleGenerationConfigured,
    startWorkflow,
    newAssetId: jest.fn(() => ASSET_ID),
    newAttemptToken: jest.fn(() => "attempt-1"),
    now: jest.fn(() => new Date("2026-07-23T00:00:00.000Z")),
    ...overrides,
  };
  return {
    deps,
    ensureIndexes,
    findSources,
    findAsset,
    createAsset,
    compareAndSetOrchestration,
    findNsfwProviderRequestAlias,
    findNsfwSafetyVerdict,
    markAssetNsfwFromAlias,
    mergeAssetSafetyLineage,
    withPlatformQuotaAdmission,
    getGoogleGenerationLimit,
    isGoogleGenerationConfigured,
    startWorkflow,
  };
}

function failedParent(overrides: Record<string, unknown> = {}): PersistedAsset {
  const spec: VideoGenerationSpec = {
    contractVersion: 1,
    provider: "higgsfield",
    mode: "image_to_video",
    skill: "video",
    userPrompt: "Frozen prompt",
    modelId: "frozen-higgsfield-model",
    seed: null,
    durationSeconds: 5,
    aspectRatio: null,
    resolution: "provider_default",
    sourceAssetId: SOURCE_1,
    referenceAssetIds: [],
  };
  const prompt: CompiledVideoPrompt = {
    compilerId: "airi-video-director",
    compilerVersion: 1,
    normalizedUserPrompt: "Frozen prompt",
    providerPrompt: "Frozen provider prompt",
    providerPromptSha256: "b".repeat(64),
    warnings: [],
  };
  return {
    _id: ASSET_ID,
    id: ASSET_ID,
    workspaceId: WORKSPACE_ID,
    kind: "video",
    source: "higgsfield",
    provider: "higgsfield",
    status: "failed",
    prompt: spec.userPrompt,
    modelId: spec.modelId,
    sourceAssetId: SOURCE_1,
    providerSourceId: "private-source-1",
    createdBy: "user-1",
    generation: {
      contractVersion: 1,
      spec,
      prompt,
      requestIdempotencyKey: "old-key",
      retryOfAssetId: null,
      recoveryMode: null,
      recipeFingerprint: buildVideoRecipeFingerprint({
        spec,
        providerSourceId: "private-source-1",
        retryOfAssetId: null,
      }),
      orchestration: {
        workflowId: `video-generation:${ASSET_ID}`,
        state: "started",
        startedAt: new Date("2026-07-22T00:00:00.000Z"),
      },
      submission: {
        state: "not_attempted",
        attemptToken: "old-attempt",
        providerRequestId: null,
        submittedAt: null,
      },
      result: null,
      failure: {
        phase: "submit",
        code: "provider_rejected",
        providerCode: null,
        message: "Provider rejected the request",
        retryable: true,
        submissionUncertain: false,
        failedAt: new Date("2026-07-22T00:00:01.000Z"),
      },
    },
    ...overrides,
  };
}

function googleFailedParent(): PersistedAsset {
  const parent = failedParent({
    providerSourceId: null,
    provider: "google",
    source: "google",
  });
  const spec: VideoGenerationSpec = {
    contractVersion: 1,
    provider: "google",
    mode: "image_to_video",
    skill: "video",
    userPrompt: parent.generation.spec.userPrompt,
    modelId: "veo-3.1-generate-preview",
    seed: null,
    durationSeconds: 6,
    aspectRatio: "9:16",
    resolution: "720p",
    sourceAssetId: SOURCE_1,
    referenceAssetIds: [],
  };
  parent.generation.spec = spec;
  parent.generation.recipeFingerprint = buildVideoRecipeFingerprint({
    spec,
    providerSourceId: null,
    retryOfAssetId: null,
  });
  return parent;
}

function recoverableGoogleParent(): PersistedAsset {
  const parent = googleFailedParent();
  parent.providerRequestId = "operations/video-1";
  parent.providerStatusUrl = "operations/video-1";
  parent.generation.submission.state = "submitted";
  parent.generation.submission.providerRequestId = "operations/video-1";
  parent.generation.submission.submittedAt = new Date(
    "2026-07-22T00:00:00.500Z"
  );
  parent.generation.failure = {
    phase: "store",
    code: "provider_result_not_ready",
    providerCode: null,
    message: "Provider result is not ready",
    retryable: false,
    submissionUncertain: false,
    failedAt: new Date("2026-07-22T00:30:00.000Z"),
  };
  return parent;
}

function recoverableHiggsfieldParent(): PersistedAsset {
  const parent = failedParent();
  parent.providerRequestId = "higgsfield-request-1";
  parent.providerStatusUrl = "higgsfield-request-1";
  parent.generation.submission.state = "submitted";
  parent.generation.submission.providerRequestId = "higgsfield-request-1";
  parent.generation.submission.submittedAt = new Date(
    "2026-07-22T00:00:00.500Z"
  );
  parent.generation.failure = {
    phase: "store",
    code: "provider_result_not_ready",
    providerCode: null,
    message: "Provider result is not ready",
    retryable: false,
    submissionUncertain: false,
    failedAt: new Date("2026-07-22T00:30:00.000Z"),
  };
  return parent;
}

describe("queueVideoGeneration", () => {
  it("accepts a video with a private completion target without starting it", async () => {
    const { deps, createAsset, startWorkflow } = makeDependencies();

    const result = await acceptVideoGeneration(
      {
        ...happyHorseInput(),
        completionTarget: {
          workflowId: "scenario-generation:workflow-1",
          signalName: "videoGenerationCompleted",
          correlationId: "execution-1",
        },
      },
      deps
    );

    expect(startWorkflow).not.toHaveBeenCalled();
    expect(createAsset.mock.calls[0]?.[0]).toMatchObject({
      generation: {
        orchestration: {
          completionTarget: {
            workflowId: "scenario-generation:workflow-1",
            signalName: "videoGenerationCompleted",
            correlationId: "execution-1",
          },
        },
      },
    });
    expect(result).toMatchObject({
      asset: { id: ASSET_ID },
      workflowInput: {
        assetId: ASSET_ID,
        workspaceId: WORKSPACE_ID,
        attemptToken: "attempt-1",
        completionTarget: {
          workflowId: "scenario-generation:workflow-1",
          signalName: "videoGenerationCompleted",
          correlationId: "execution-1",
        },
      },
    });
  });

  it("rejects a replay whose private completion target differs", async () => {
    const first = makeDependencies();
    const input = {
      ...happyHorseInput(),
      completionTarget: {
        workflowId: "scenario-generation:workflow-1",
        signalName: "videoGenerationCompleted",
        correlationId: "execution-1",
      },
    };
    const accepted = await acceptVideoGeneration(input, first.deps);
    const persisted = first.createAsset.mock.calls[0]?.[0] as PersistedAsset;

    const replay = makeDependencies({
      findAsset: jest.fn().mockResolvedValue({
        ...persisted,
        id: accepted.asset.id,
      }),
    });
    await expect(
      acceptVideoGeneration(
        {
          ...input,
          completionTarget: {
            ...input.completionTarget,
            correlationId: "execution-2",
          },
        },
        replay.deps
      )
    ).rejects.toMatchObject({
      status: 409,
      code: "idempotency_key_conflict",
    });
    expect(replay.createAsset).not.toHaveBeenCalled();
    expect(replay.startWorkflow).not.toHaveBeenCalled();
  });

  it("replays the same private completion target without creating or starting", async () => {
    const first = makeDependencies();
    const input = {
      ...happyHorseInput(),
      completionTarget: {
        workflowId: "scenario-generation:workflow-1",
        signalName: "videoGenerationCompleted",
        correlationId: "execution-1",
      },
    };
    const accepted = await acceptVideoGeneration(input, first.deps);
    const persisted = first.createAsset.mock.calls[0]?.[0] as PersistedAsset;
    const replay = makeDependencies({
      findAsset: jest.fn().mockResolvedValue({
        ...persisted,
        id: accepted.asset.id,
      }),
    });

    await expect(acceptVideoGeneration(input, replay.deps)).resolves.toEqual({
      asset: expect.objectContaining({ id: ASSET_ID }),
      workflowInput: accepted.workflowInput,
    });
    expect(replay.createAsset).not.toHaveBeenCalled();
    expect(replay.startWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an accepted target",
      {
        workflowId: "scenario-generation:workflow-1",
        signalName: "videoGenerationCompleted",
        correlationId: "execution-1",
      },
      undefined,
    ],
    [
      "an accepted empty target",
      undefined,
      {
        workflowId: "scenario-generation:workflow-1",
        signalName: "videoGenerationCompleted",
        correlationId: "execution-1",
      },
    ],
  ])(
    "rejects a replay with %s",
    async (_description, initialTarget, replayTarget) => {
      const first = makeDependencies();
      const input = { ...happyHorseInput(), completionTarget: initialTarget };
      await acceptVideoGeneration(input, first.deps);
      const persisted = first.createAsset.mock.calls[0]?.[0] as PersistedAsset;
      const replay = makeDependencies({
        findAsset: jest.fn().mockResolvedValue({ ...persisted, id: ASSET_ID }),
      });

      await expect(
        acceptVideoGeneration(
          { ...input, completionTarget: replayTarget },
          replay.deps
        )
      ).rejects.toMatchObject({
        status: 409,
        code: "idempotency_key_conflict",
      });
      expect(replay.createAsset).not.toHaveBeenCalled();
      expect(replay.startWorkflow).not.toHaveBeenCalled();
    }
  );

  it("excludes the private completion target from the provider recipe fingerprint", async () => {
    const first = makeDependencies();
    const second = makeDependencies({ newAssetId: jest.fn(() => CHILD_ID) });

    await acceptVideoGeneration(
      {
        ...happyHorseInput(),
        completionTarget: {
          workflowId: "scenario-generation:workflow-1",
          signalName: "videoGenerationCompleted",
          correlationId: "execution-1",
        },
      },
      first.deps
    );
    await acceptVideoGeneration(
      {
        ...happyHorseInput(),
        idempotencyKey: "123e4567-e89b-42d3-a456-426614174099",
        completionTarget: {
          workflowId: "scenario-generation:workflow-2",
          signalName: "videoGenerationCompleted",
          correlationId: "execution-2",
        },
      },
      second.deps
    );

    expect(
      (first.createAsset.mock.calls[0]?.[0] as PersistedAsset).generation
        .recipeFingerprint
    ).toBe(
      (second.createAsset.mock.calls[0]?.[0] as PersistedAsset).generation
        .recipeFingerprint
    );
  });

  it("builds a canonical fingerprint independent of object key insertion order", () => {
    const left: VideoGenerationSpec = {
      contractVersion: 1,
      provider: "happyhorse",
      mode: "reference_to_video",
      skill: "character",
      userPrompt: "Ordered references",
      modelId: "model-1",
      seed: null,
      durationSeconds: 5,
      aspectRatio: "9:16",
      resolution: "1080P",
      sourceAssetId: null,
      referenceAssetIds: [SOURCE_1, SOURCE_2],
    };
    const right: VideoGenerationSpec = {
      referenceAssetIds: [SOURCE_1, SOURCE_2],
      sourceAssetId: null,
      resolution: "1080P",
      aspectRatio: "9:16",
      durationSeconds: 5,
      seed: null,
      modelId: "model-1",
      userPrompt: "Ordered references",
      skill: "character",
      mode: "reference_to_video",
      provider: "happyhorse",
      contractVersion: 1,
    };

    const leftFingerprint = buildVideoRecipeFingerprint({
      spec: left,
      providerSourceId: null,
      retryOfAssetId: null,
    });
    const rightFingerprint = buildVideoRecipeFingerprint({
      spec: right,
      providerSourceId: null,
      retryOfAssetId: null,
    });
    const reorderedReferencesFingerprint = buildVideoRecipeFingerprint({
      spec: { ...right, referenceAssetIds: [SOURCE_2, SOURCE_1] },
      providerSourceId: null,
      retryOfAssetId: null,
    });

    expect(leftFingerprint).toBe(rightFingerprint);
    expect(leftFingerprint).not.toBe(reorderedReferencesFingerprint);
  });

  it("compiles before create and persists the exact canonical recipe and legacy mirrors", async () => {
    const { deps, createAsset, startWorkflow } = makeDependencies();

    const result = await queueVideoGeneration(
      happyHorseInput({ prompt: "  Cafe\r\nreveal  " }),
      deps
    );

    const persisted = createAsset.mock
      .calls[0]?.[0] as unknown as PersistedAsset;
    expect(persisted).toMatchObject({
      _id: ASSET_ID,
      workspaceId: WORKSPACE_ID,
      kind: "video",
      source: "happyhorse",
      provider: "happyhorse",
      status: "queued",
      prompt: "  Cafe\nreveal  ",
      modelId: expect.any(String),
      sourceAssetId: null,
      providerSourceId: null,
      createdBy: "user-1",
      updatedBy: "user-1",
      generation: {
        contractVersion: 1,
        spec: expect.objectContaining({
          userPrompt: "  Cafe\nreveal  ",
          seed: null,
        }),
        prompt: expect.objectContaining({
          normalizedUserPrompt: "Cafe\nreveal",
          providerPromptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        requestIdempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
        retryOfAssetId: null,
        recoveryMode: null,
        recipeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        orchestration: {
          workflowId: `video-generation:${ASSET_ID}`,
          state: "pending",
          startedAt: null,
        },
        submission: {
          state: "pending",
          attemptToken: "attempt-1",
          providerRequestId: null,
          submittedAt: null,
        },
        result: null,
        failure: null,
      },
    });
    expect(startWorkflow).toHaveBeenCalledWith({
      contractVersion: VIDEO_GENERATION_WORKFLOW_CONTRACT_VERSION,
      workspaceId: WORKSPACE_ID,
      assetId: ASSET_ID,
      attemptToken: "attempt-1",
      spec: persisted.generation.spec,
      prompt: persisted.generation.prompt,
      providerSourceId: null,
      mediaTaskQueue: CREATIVE_ASSET_EDIT_TASK_QUEUE,
    });
    expect(result.asset.id).toBe(ASSET_ID);
  });

  it("ensures generation indexes before the first queue read", async () => {
    const state = makeDependencies();

    await queueVideoGeneration(happyHorseInput(), state.deps);

    expect(state.ensureIndexes).toHaveBeenCalledTimes(1);
    expect(state.ensureIndexes.mock.invocationCallOrder[0]).toBeLessThan(
      state.findAsset.mock.invocationCallOrder[0]!
    );
  });

  it("uses a pinned Google customer source without platform admission", async () => {
    const state = makeDependencies();
    state.findSources.mockResolvedValue([source(SOURCE_1)]);
    const result = await queueVideoGeneration(googleInput(), state.deps);
    expect(result.asset.providerSourceId).toBe("google-source");
    expect(state.deps.validateCustomerCredentials).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      provider: "google",
      providerSourceId: "google-source",
    });
    expect(state.withPlatformQuotaAdmission).not.toHaveBeenCalled();
    expect(state.startWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ providerSourceId: "google-source" })
    );
  });

  it("rejects missing credentials before persisting or starting a new video", async () => {
    const state = makeDependencies({
      validateCustomerCredentials: jest.fn().mockRejectedValue(
        Object.assign(new Error("Connect Google AI"), {
          code: "own_ai_source_required",
        })
      ),
    });
    state.findSources.mockResolvedValue([source(SOURCE_1)]);
    await expect(
      queueVideoGeneration(googleInput(), state.deps)
    ).rejects.toMatchObject({ code: "own_ai_source_required" });
    expect(state.createAsset).not.toHaveBeenCalled();
    expect(state.startWorkflow).not.toHaveBeenCalled();
  });

  it("uses one tenant-scoped image lookup and reconstructs reference order", async () => {
    const { deps, findSources, createAsset } = makeDependencies();
    findSources.mockResolvedValue([
      source(SOURCE_3),
      source(SOURCE_1),
      source(SOURCE_2),
    ]);

    await queueVideoGeneration(
      happyHorseInput({
        mode: "reference_to_video",
        skill: "character",
        sourceAssetId: null,
        referenceAssetIds: [SOURCE_2, SOURCE_1, SOURCE_3],
      }),
      deps
    );

    expect(findSources).toHaveBeenCalledTimes(1);
    expect(findSources).toHaveBeenCalledWith({
      _id: { $in: [SOURCE_2, SOURCE_1, SOURCE_3] },
      workspaceId: WORKSPACE_ID,
      kind: "image",
      status: "complete",
    });
    expect(createAsset.mock.calls[0]?.[0]).toMatchObject({
      generation: {
        spec: { referenceAssetIds: [SOURCE_2, SOURCE_1, SOURCE_3] },
      },
    });
  });

  it("accepts exactly nine ordered references", async () => {
    const ids = Array.from(
      { length: 9 },
      (_, index) =>
        `507f1f77bcf86cd7994390${String(index + 11).padStart(2, "0")}`
    );
    const { deps, findSources, createAsset } = makeDependencies();
    findSources.mockResolvedValue(ids.map(id => source(id)));

    await queueVideoGeneration(
      happyHorseInput({
        mode: "reference_to_video",
        skill: "character",
        sourceAssetId: null,
        referenceAssetIds: ids,
      }),
      deps
    );

    expect(createAsset).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["zero references", []],
    [
      "ten references",
      Array.from(
        { length: 10 },
        (_, index) =>
          `507f1f77bcf86cd7994390${String(index + 11).padStart(2, "0")}`
      ),
    ],
    ["duplicate references", [SOURCE_1, SOURCE_1]],
  ])("rejects %s before querying or creating", async (_label, ids) => {
    const { deps, findSources, createAsset } = makeDependencies();

    await expect(
      queueVideoGeneration(
        happyHorseInput({
          mode: "reference_to_video",
          skill: "character",
          sourceAssetId: null,
          referenceAssetIds: ids,
        }),
        deps
      )
    ).rejects.toMatchObject({ status: 400 });
    expect(findSources).not.toHaveBeenCalled();
    expect(createAsset).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["wrong workspace", { workspaceId: "workspace-2" }],
    ["wrong kind", { kind: "video" }],
    ["wrong status", { status: "failed" }],
  ])("rejects a %s source record", async (_label, mutation) => {
    const { deps, findSources, createAsset } = makeDependencies();
    findSources.mockResolvedValue(
      mutation === null ? [] : [source(SOURCE_1, mutation)]
    );

    await expect(
      queueVideoGeneration(
        {
          ...happyHorseInput({
            mode: "image_to_video",
            sourceAssetId: SOURCE_1,
            aspectRatio: null,
            referenceAssetIds: [],
          }),
        },
        deps
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_source_asset",
    });
    expect(createAsset).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong skill", { mode: "text_to_video", skill: "character" }],
    ["forbidden source", { mode: "text_to_video", sourceAssetId: SOURCE_1 }],
    ["i2v ratio", { mode: "image_to_video", sourceAssetId: SOURCE_1 }],
    [
      "reference source",
      {
        mode: "reference_to_video",
        skill: "character",
        sourceAssetId: SOURCE_1,
        referenceAssetIds: [SOURCE_2],
      },
    ],
    ["non-null seed", { seed: 42 }],
    ["invalid duration", { durationSeconds: 16 }],
    ["invalid resolution", { resolution: "4K" }],
  ])(
    "rejects impossible HappyHorse union member: %s",
    async (_label, request) => {
      const { deps, createAsset } = makeDependencies();

      await expect(
        queueVideoGeneration(
          happyHorseInput(
            request as unknown as QueueVideoGenerationInput["request"]
          ),
          deps
        )
      ).rejects.toMatchObject({ status: 400, code: "invalid_video_recipe" });
      expect(createAsset).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      "higgsfield text mode",
      { provider: "higgsfield", providerSourceId: "source" },
      { mode: "text_to_video" },
    ],
    [
      "higgsfield provider defaults mismatch",
      { provider: "higgsfield", providerSourceId: "source" },
      { mode: "image_to_video", sourceAssetId: SOURCE_1, resolution: "720P" },
    ],
    [
      "google unsupported duration",
      { provider: "google", providerSourceId: "google-source" },
      {
        mode: "image_to_video",
        sourceAssetId: SOURCE_1,
        durationSeconds: 5,
        resolution: "720p",
        aspectRatio: "9:16",
      },
    ],
    [
      "google unsupported aspect",
      { provider: "google", providerSourceId: "google-source" },
      {
        mode: "image_to_video",
        sourceAssetId: SOURCE_1,
        durationSeconds: 6,
        resolution: "720p",
        aspectRatio: "1:1",
      },
    ],
  ])("rejects %s before create", async (_label, providerPolicy, request) => {
    const { deps, createAsset } = makeDependencies();

    await expect(
      queueVideoGeneration(
        {
          ...happyHorseInput(
            request as unknown as QueueVideoGenerationInput["request"]
          ),
          providerPolicy:
            providerPolicy as unknown as QueueVideoGenerationInput["providerPolicy"],
        },
        deps
      )
    ).rejects.toMatchObject({ status: 400, code: "invalid_video_recipe" });
    expect(createAsset).not.toHaveBeenCalled();
  });

  it("maps compile overflow before any Mongo write or workflow start", async () => {
    const { deps, createAsset, startWorkflow } = makeDependencies();

    await expect(
      queueVideoGeneration(
        {
          ...happyHorseInput({
            mode: "image_to_video",
            sourceAssetId: SOURCE_1,
            aspectRatio: null,
            prompt: "x".repeat(5000),
          }),
          providerPolicy: {
            provider: "higgsfield",
            providerSourceId: "private-source-1",
          },
          request: {
            ...happyHorseInput().request,
            mode: "image_to_video",
            sourceAssetId: SOURCE_1,
            aspectRatio: null,
            resolution: "provider_default",
            durationSeconds: 5,
            prompt: "x".repeat(5000),
          },
        },
        {
          ...deps,
          findSources: jest.fn().mockResolvedValue([source(SOURCE_1)]),
        }
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "prompt_too_long_for_provider",
      maxLength: expect.any(Number),
    });
    expect(createAsset).not.toHaveBeenCalled();
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it("returns the same asset and ensures one stable workflow on a duplicate-key race", async () => {
    const baseInput = happyHorseInput();
    const first = makeDependencies();
    await queueVideoGeneration(baseInput, first.deps);
    const matching = first.createAsset.mock
      .calls[0]?.[0] as unknown as PersistedAsset;
    matching.id = ASSET_ID;

    const { deps, createAsset, findAsset, startWorkflow } = makeDependencies();
    createAsset.mockRejectedValue({ code: 11000 });
    findAsset.mockResolvedValueOnce(null).mockResolvedValueOnce(matching);

    const result = await queueVideoGeneration(baseInput, deps);

    expect(findAsset).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      "generation.requestIdempotencyKey": baseInput.idempotencyKey,
    });
    expect(result.asset.id).toBe(ASSET_ID);
    expect(createAsset).toHaveBeenCalledTimes(1);
    expect(startWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: ASSET_ID })
    );
  });

  it("replays an accepted asset before mutable source validation", async () => {
    const baseInput = {
      ...happyHorseInput({
        mode: "image_to_video" as const,
        sourceAssetId: SOURCE_1,
      }),
      providerPolicy: {
        provider: "higgsfield" as const,
        providerSourceId: "private-source-1",
      },
      request: {
        ...happyHorseInput().request,
        mode: "image_to_video" as const,
        sourceAssetId: SOURCE_1,
        aspectRatio: null,
        resolution: "provider_default",
        durationSeconds: 5,
      },
    };
    const first = makeDependencies({
      findSources: jest.fn().mockResolvedValue([source(SOURCE_1)]),
    });
    await queueVideoGeneration(baseInput, first.deps);
    const matching = first.createAsset.mock
      .calls[0]?.[0] as unknown as PersistedAsset;
    matching.id = ASSET_ID;

    const replay = makeDependencies({
      findAsset: jest.fn().mockResolvedValue(matching),
      findSources: jest
        .fn()
        .mockRejectedValue(new Error("source was deleted after acceptance")),
    });

    const result = await queueVideoGeneration(baseInput, replay.deps);

    expect(result.asset.id).toBe(ASSET_ID);
    expect(replay.findSources).not.toHaveBeenCalled();
    expect(replay.createAsset).not.toHaveBeenCalled();
    expect(replay.startWorkflow).toHaveBeenCalledTimes(1);
  });

  it("replays the frozen recipe after provider models and defaults change", async () => {
    const previous = {
      model: process.env.HAPPYHORSE_T2V_MODEL,
      ratio: process.env.HAPPYHORSE_DEFAULT_RATIO,
      resolution: process.env.HAPPYHORSE_DEFAULT_RESOLUTION,
    };
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    try {
      process.env.HAPPYHORSE_T2V_MODEL = "happyhorse-frozen-v1";
      process.env.HAPPYHORSE_DEFAULT_RATIO = "16:9";
      process.env.HAPPYHORSE_DEFAULT_RESOLUTION = "720P";
      const baseInput = happyHorseInput({
        aspectRatio: undefined,
        resolution: undefined,
      });
      const first = makeDependencies();
      await queueVideoGeneration(baseInput, first.deps);
      const accepted = first.createAsset.mock
        .calls[0]?.[0] as unknown as PersistedAsset;
      accepted.id = ASSET_ID;

      process.env.HAPPYHORSE_T2V_MODEL = "happyhorse-changed-v2";
      process.env.HAPPYHORSE_DEFAULT_RATIO = "9:16";
      process.env.HAPPYHORSE_DEFAULT_RESOLUTION = "1080P";
      const replay = makeDependencies({
        findAsset: jest.fn().mockResolvedValue(accepted),
      });

      await expect(
        queueVideoGeneration(baseInput, replay.deps)
      ).resolves.toMatchObject({
        asset: { id: ASSET_ID },
      });

      expect(replay.createAsset).not.toHaveBeenCalled();
      expect(replay.startWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          spec: expect.objectContaining({
            modelId: "happyhorse-frozen-v1",
            aspectRatio: "16:9",
            resolution: "720P",
          }),
        })
      );
    } finally {
      restore("HAPPYHORSE_T2V_MODEL", previous.model);
      restore("HAPPYHORSE_DEFAULT_RATIO", previous.ratio);
      restore("HAPPYHORSE_DEFAULT_RESOLUTION", previous.resolution);
    }
  });

  it("rejects one idempotency key reused for another recipe", async () => {
    const baseInput = happyHorseInput();
    const first = makeDependencies();
    await queueVideoGeneration(baseInput, first.deps);
    const different = first.createAsset.mock
      .calls[0]?.[0] as unknown as PersistedAsset;
    different.id = ASSET_ID;
    different.generation.recipeFingerprint = "different";

    const { deps, createAsset, findAsset, startWorkflow } = makeDependencies();
    createAsset.mockRejectedValue({ codeName: "DuplicateKey" });
    findAsset.mockResolvedValue(different);

    await expect(queueVideoGeneration(baseInput, deps)).rejects.toMatchObject({
      status: 409,
      code: "idempotency_key_conflict",
    });
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it("CASes orchestration to started after a confirmed start", async () => {
    const { deps, compareAndSetOrchestration } = makeDependencies();

    await queueVideoGeneration(happyHorseInput(), deps);

    expect(compareAndSetOrchestration).toHaveBeenCalledWith({
      assetId: ASSET_ID,
      workspaceId: WORKSPACE_ID,
      attemptToken: "attempt-1",
      fromStates: ["pending", "unknown"],
      toState: "started",
      startedAt: new Date("2026-07-23T00:00:00.000Z"),
    });
  });

  it("leaves the asset queued and CASes orchestration to unknown on ambiguous start", async () => {
    const { deps, createAsset, compareAndSetOrchestration, startWorkflow } =
      makeDependencies();
    startWorkflow.mockRejectedValue(
      new VideoGenerationWorkflowStartAmbiguousError(
        new Error("connection reset")
      )
    );

    const result = await queueVideoGeneration(happyHorseInput(), deps);

    expect(compareAndSetOrchestration).toHaveBeenCalledWith({
      assetId: ASSET_ID,
      workspaceId: WORKSPACE_ID,
      attemptToken: "attempt-1",
      fromStates: ["pending"],
      toState: "unknown",
      startedAt: null,
    });
    expect(createAsset.mock.calls[0]?.[0]).toMatchObject({
      status: "queued",
      generation: { failure: null },
    });
    expect(result.asset).toMatchObject({ status: "queued" });
  });

  it("keeps a closed duplicate repairable instead of marking orchestration started", async () => {
    const { deps, compareAndSetOrchestration, startWorkflow } =
      makeDependencies();
    startWorkflow.mockRejectedValue(
      new VideoGenerationWorkflowNotRunningError("FAILED")
    );

    const result = await queueVideoGeneration(happyHorseInput(), deps);

    expect(compareAndSetOrchestration).toHaveBeenCalledWith({
      assetId: ASSET_ID,
      workspaceId: WORKSPACE_ID,
      attemptToken: "attempt-1",
      fromStates: ["pending"],
      toState: "unknown",
      startedAt: null,
    });
    expect(result.asset).toMatchObject({
      status: "queued",
      generation: { orchestration: { state: "unknown" } },
    });
  });

  it("propagates a definite pre-start failure without mutating orchestration", async () => {
    const { deps, compareAndSetOrchestration, startWorkflow } =
      makeDependencies();
    startWorkflow.mockRejectedValue(new Error("Temporal is not configured"));

    await expect(queueVideoGeneration(happyHorseInput(), deps)).rejects.toThrow(
      "Temporal is not configured"
    );
    expect(compareAndSetOrchestration).not.toHaveBeenCalled();
  });

  it("propagates a post-start CAS failure without downgrading to unknown", async () => {
    const { deps, compareAndSetOrchestration } = makeDependencies();
    compareAndSetOrchestration.mockRejectedValueOnce(
      new Error("Mongo unavailable")
    );

    await expect(queueVideoGeneration(happyHorseInput(), deps)).rejects.toThrow(
      "Mongo unavailable"
    );
    expect(compareAndSetOrchestration).toHaveBeenCalledTimes(1);
    expect(compareAndSetOrchestration).toHaveBeenCalledWith({
      assetId: ASSET_ID,
      workspaceId: WORKSPACE_ID,
      attemptToken: "attempt-1",
      fromStates: ["pending", "unknown"],
      toState: "started",
      startedAt: new Date("2026-07-23T00:00:00.000Z"),
    });
  });
});

describe("retryVideoGeneration", () => {
  const retryInput = {
    workspaceId: WORKSPACE_ID,
    assetId: ASSET_ID,
    createdBy: "user-2",
    idempotencyKey: "123e4567-e89b-42d3-a456-426614174001",
    acknowledgePossibleDuplicateCharge: false,
  };

  it("clones the exact frozen recipe and private source lineage into a linked child", async () => {
    const parent = failedParent();
    const { deps, findAsset, createAsset, findSources } = makeDependencies({
      newAssetId: jest.fn(() => CHILD_ID),
      newAttemptToken: jest.fn(() => "attempt-child"),
    });
    findAsset.mockResolvedValue(parent);

    const result = await retryVideoGeneration(retryInput, deps);

    const child = createAsset.mock.calls[0]?.[0] as unknown as PersistedAsset;
    expect(child).toMatchObject({
      _id: CHILD_ID,
      status: "queued",
      prompt: parent.generation.spec.userPrompt,
      modelId: parent.generation.spec.modelId,
      sourceAssetId: parent.generation.spec.sourceAssetId,
      providerSourceId: "private-source-1",
      generation: {
        spec: parent.generation.spec,
        prompt: parent.generation.prompt,
        retryOfAssetId: ASSET_ID,
        submission: { attemptToken: "attempt-child" },
      },
    });
    expect(child.generation.spec).not.toBe(parent.generation.spec);
    expect(child.generation.prompt).not.toBe(parent.generation.prompt);
    expect(findSources).not.toHaveBeenCalled();
    expect(result.asset.id).toBe(CHILD_ID);
    expect(parent.status).toBe("failed");
    expect(parent.generation.retryOfAssetId).toBeNull();
  });

  it("requires explicit duplicate-cost acknowledgement for an uncertain parent", async () => {
    const parent = failedParent();
    parent.generation.failure!.submissionUncertain = true;
    parent.generation.failure!.retryable = false;
    parent.generation.submission.state = "unknown";
    const { deps, findAsset, createAsset } = makeDependencies();
    findAsset.mockResolvedValue(parent);

    await expect(retryVideoGeneration(retryInput, deps)).rejects.toMatchObject({
      status: 409,
      code: "duplicate_charge_acknowledgement_required",
    });
    expect(createAsset).not.toHaveBeenCalled();

    await expect(
      retryVideoGeneration(
        { ...retryInput, acknowledgePossibleDuplicateCharge: true },
        deps
      )
    ).resolves.toBeDefined();
  });

  it("persists ancestor safety lineage before retrying an uncertain Higgsfield submission", async () => {
    const parent = failedParent();
    parent.generation.failure!.submissionUncertain = true;
    parent.generation.failure!.retryable = false;
    parent.generation.submission.state = "unknown";
    const state = makeDependencies({
      newAssetId: jest.fn(() => CHILD_ID),
      newAttemptToken: jest.fn(() => "attempt-child"),
    });
    state.findAsset.mockResolvedValue(parent);

    await retryVideoGeneration(
      { ...retryInput, acknowledgePossibleDuplicateCharge: true },
      state.deps
    );

    const child = state.createAsset.mock
      .calls[0]?.[0] as unknown as PersistedAsset;
    expect(child.generation).toMatchObject({
      retryOfAssetId: ASSET_ID,
      safetyAncestors: [
        {
          assetId: ASSET_ID,
          attemptToken: "old-attempt",
        },
      ],
    });
    expect(state.findNsfwSafetyVerdict).toHaveBeenCalledTimes(2);
    expect(state.findNsfwSafetyVerdict).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      providerRequestIds: [],
      ancestors: [
        {
          assetId: ASSET_ID,
          attemptToken: "old-attempt",
        },
      ],
    });
  });

  it("quarantines an uncertain retry when an ancestor verdict arrives after insert", async () => {
    const parent = failedParent();
    parent.generation.failure!.submissionUncertain = true;
    parent.generation.failure!.retryable = false;
    parent.generation.submission.state = "unknown";
    const state = makeDependencies({
      newAssetId: jest.fn(() => CHILD_ID),
      newAttemptToken: jest.fn(() => "attempt-child"),
    });
    state.findAsset.mockResolvedValue(parent);
    state.findNsfwSafetyVerdict
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        _id: "a".repeat(64),
        providerRequestId: "late-request-1",
        sourceAssetId: ASSET_ID,
        sourceAttemptToken: "old-attempt",
        firstReceivedAt: new Date("2026-07-23T12:00:00.000Z"),
      });

    await expect(
      retryVideoGeneration(
        { ...retryInput, acknowledgePossibleDuplicateCharge: true },
        state.deps
      )
    ).rejects.toMatchObject({
      status: 409,
      code: "nsfw_not_retryable",
    });

    expect(state.createAsset).toHaveBeenCalledTimes(1);
    expect(state.markAssetNsfwFromAlias).toHaveBeenCalledWith({
      assetId: CHILD_ID,
      workspaceId: WORKSPACE_ID,
      providerRequestId: "late-request-1",
      now: new Date("2026-07-23T00:00:00.000Z"),
    });
    expect(state.startWorkflow).not.toHaveBeenCalled();
  });

  it("recovers a known Google provider request without quota admission or another submit", async () => {
    const parent = recoverableGoogleParent();
    const state = makeDependencies({
      newAssetId: jest.fn(() => CHILD_ID),
      newAttemptToken: jest.fn(() => "attempt-recovery"),
    });
    state.findAsset.mockResolvedValue(parent);

    const result = await retryVideoGeneration(retryInput, state.deps);

    const child = state.createAsset.mock
      .calls[0]?.[0] as unknown as PersistedAsset;
    expect(child).toMatchObject({
      _id: CHILD_ID,
      workspaceId: WORKSPACE_ID,
      status: "queued",
      providerRequestId: "operations/video-1",
      providerStatusUrl: "operations/video-1",
      generation: {
        retryOfAssetId: ASSET_ID,
        recoveryMode: "provider_result",
        recoverySource: {
          assetId: ASSET_ID,
          attemptToken: parent.generation.submission.attemptToken,
          providerRequestId: "operations/video-1",
          recipeFingerprint: parent.generation.recipeFingerprint,
          provider: "google",
        },
        submission: {
          state: "submitted",
          attemptToken: "attempt-recovery",
          providerRequestId: "operations/video-1",
          submittedAt: new Date("2026-07-22T00:00:00.500Z"),
        },
        failure: null,
      },
    });
    expect(state.withPlatformQuotaAdmission).not.toHaveBeenCalled();
    expect(state.startWorkflow).toHaveBeenCalledWith({
      contractVersion: VIDEO_GENERATION_WORKFLOW_CONTRACT_VERSION,
      workspaceId: WORKSPACE_ID,
      assetId: CHILD_ID,
      attemptToken: "attempt-recovery",
      spec: parent.generation.spec,
      prompt: parent.generation.prompt,
      providerSourceId: null,
      mediaTaskQueue: CREATIVE_ASSET_EDIT_TASK_QUEUE,
      resume: {
        providerRequestId: "operations/video-1",
        providerRequestLocator: "operations/video-1",
        pollCount: 0,
        elapsedMs: 0,
      },
    });
    expect(result.asset.id).toBe(CHILD_ID);
  });

  it("keeps the durable ancestor when a recovery attempt failed before staging a result", async () => {
    const parent = recoverableGoogleParent();
    parent.generation.recoveryMode = "provider_result";
    parent.generation.recoverySource = {
      assetId: "507f1f77bcf86cd799439010",
      attemptToken: "attempt-original",
      providerRequestId: "operations/video-1",
      recipeFingerprint: "c".repeat(64),
      provider: "google",
    };
    const state = makeDependencies({
      newAssetId: jest.fn(() => CHILD_ID),
      newAttemptToken: jest.fn(() => "attempt-recovery-2"),
    });
    state.findAsset.mockResolvedValue(parent);

    await retryVideoGeneration(retryInput, state.deps);

    expect(state.createAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: expect.objectContaining({
          recoverySource: parent.generation.recoverySource,
        }),
      })
    );
  });

  it("promotes a recovery attempt with a staged GCS result to the next recovery source", async () => {
    const parent = recoverableGoogleParent();
    parent.storageProvider = "gcs";
    parent.bucket = "creative-assets";
    parent.path = `${WORKSPACE_ID}/${ASSET_ID}/video.mp4`;
    parent.generation.recoveryMode = "provider_result";
    parent.generation.recoverySource = {
      assetId: "507f1f77bcf86cd799439010",
      attemptToken: "attempt-original",
      providerRequestId: "operations/video-1",
      recipeFingerprint: "c".repeat(64),
      provider: "google",
    };
    const state = makeDependencies({
      newAssetId: jest.fn(() => CHILD_ID),
      newAttemptToken: jest.fn(() => "attempt-recovery-2"),
    });
    state.findAsset.mockResolvedValue(parent);

    await retryVideoGeneration(retryInput, state.deps);

    expect(state.createAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: expect.objectContaining({
          recoverySource: {
            assetId: ASSET_ID,
            attemptToken: parent.generation.submission.attemptToken,
            providerRequestId: "operations/video-1",
            recipeFingerprint: parent.generation.recipeFingerprint,
            provider: "google",
          },
        }),
      })
    );
  });

  it("rejects recovery when any existing contract-v1 request alias is nsfw", async () => {
    const parent = recoverableHiggsfieldParent();
    const state = makeDependencies();
    state.findAsset.mockResolvedValue(parent);
    state.findNsfwProviderRequestAlias.mockResolvedValue({
      ...parent,
      _id: "507f1f77bcf86cd799439099",
      status: "nsfw",
    });

    await expect(
      retryVideoGeneration(retryInput, state.deps)
    ).rejects.toMatchObject({
      status: 409,
      code: "nsfw_not_retryable",
    });
    expect(state.findNsfwProviderRequestAlias).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      providerRequestId: "higgsfield-request-1",
    });
    expect(state.createAsset).not.toHaveBeenCalled();
    expect(state.startWorkflow).not.toHaveBeenCalled();
  });

  it("rejects a retry when an inherited safety alias is already nsfw", async () => {
    const parent = recoverableHiggsfieldParent();
    parent.generation.safetyProviderRequestIds = ["higgsfield-unsafe-ancestor"];
    const state = makeDependencies();
    state.findAsset.mockResolvedValue(parent);
    state.findNsfwProviderRequestAlias.mockResolvedValueOnce({
      ...parent,
      _id: "507f1f77bcf86cd799439099",
      status: "nsfw",
    });

    await expect(
      retryVideoGeneration(retryInput, state.deps)
    ).rejects.toMatchObject({
      status: 409,
      code: "nsfw_not_retryable",
    });
    expect(state.findNsfwProviderRequestAlias).toHaveBeenCalledTimes(1);
    expect(state.findNsfwProviderRequestAlias).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      providerRequestId: "higgsfield-unsafe-ancestor",
    });
    expect(state.createAsset).not.toHaveBeenCalled();
    expect(state.startWorkflow).not.toHaveBeenCalled();
  });

  it("quarantines a child when an nsfw alias wins the retry creation race", async () => {
    const parent = recoverableHiggsfieldParent();
    const state = makeDependencies({
      newAssetId: jest.fn(() => CHILD_ID),
      newAttemptToken: jest.fn(() => "attempt-recovery"),
    });
    state.findAsset.mockResolvedValue(parent);
    state.findNsfwProviderRequestAlias
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...parent,
        _id: "507f1f77bcf86cd799439099",
        status: "nsfw",
      });

    await expect(
      retryVideoGeneration(retryInput, state.deps)
    ).rejects.toMatchObject({
      status: 409,
      code: "nsfw_not_retryable",
    });
    expect(state.createAsset).toHaveBeenCalledTimes(1);
    expect(state.markAssetNsfwFromAlias).toHaveBeenCalledWith({
      assetId: CHILD_ID,
      workspaceId: WORKSPACE_ID,
      providerRequestId: "higgsfield-request-1",
      now: new Date("2026-07-23T00:00:00.000Z"),
    });
    expect(state.startWorkflow).not.toHaveBeenCalled();
  });

  it("does not consult Higgsfield NSFW markers for a Google recovery", async () => {
    const parent = recoverableGoogleParent();
    const state = makeDependencies({
      newAssetId: jest.fn(() => CHILD_ID),
      newAttemptToken: jest.fn(() => "attempt-recovery"),
    });
    state.findAsset.mockResolvedValue(parent);
    state.findNsfwSafetyVerdict.mockResolvedValue({
      _id: "a".repeat(64),
      providerRequestId: "operations/video-1",
      sourceAssetId: ASSET_ID,
      sourceAttemptToken: parent.generation.submission.attemptToken,
      firstReceivedAt: new Date("2026-07-23T12:00:00.000Z"),
    });
    state.findNsfwProviderRequestAlias.mockResolvedValue({
      ...parent,
      status: "nsfw",
    });

    await expect(
      retryVideoGeneration(retryInput, state.deps)
    ).resolves.toBeDefined();

    expect(state.findNsfwSafetyVerdict).not.toHaveBeenCalled();
    expect(state.findNsfwProviderRequestAlias).not.toHaveBeenCalled();
    expect(state.markAssetNsfwFromAlias).not.toHaveBeenCalled();
    expect(state.startWorkflow).toHaveBeenCalledTimes(1);
  });

  it("ensures generation indexes before reading a retry parent", async () => {
    const parent = failedParent();
    const state = makeDependencies();
    state.findAsset.mockResolvedValue(parent);

    await retryVideoGeneration(retryInput, state.deps);

    expect(state.ensureIndexes).toHaveBeenCalledTimes(1);
    expect(state.ensureIndexes.mock.invocationCallOrder[0]).toBeLessThan(
      state.findAsset.mock.invocationCallOrder[0]!
    );
  });

  it("replays an accepted recovery child without quota admission", async () => {
    const parent = recoverableGoogleParent();
    const initial = makeDependencies({
      newAssetId: jest.fn(() => CHILD_ID),
      newAttemptToken: jest.fn(() => "attempt-recovery"),
    });
    initial.findAsset.mockResolvedValue(parent);
    await retryVideoGeneration(retryInput, initial.deps);
    const child = initial.createAsset.mock
      .calls[0]?.[0] as unknown as PersistedAsset;
    child.id = CHILD_ID;

    const replay = makeDependencies({
      findAsset: jest
        .fn()
        .mockResolvedValueOnce(parent)
        .mockResolvedValueOnce(child),
    });

    await retryVideoGeneration(retryInput, replay.deps);

    expect(replay.createAsset).not.toHaveBeenCalled();
    expect(replay.withPlatformQuotaAdmission).not.toHaveBeenCalled();
    expect(replay.startWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: CHILD_ID,
        attemptToken: "attempt-recovery",
        resume: {
          providerRequestId: "operations/video-1",
          providerRequestLocator: "operations/video-1",
          pollCount: 0,
          elapsedMs: 0,
        },
      })
    );
  });

  it("CAS-merges newly learned safety lineage into an idempotent retry winner", async () => {
    const parent = failedParent();
    parent.providerRequestId = "late-request-1";
    parent.providerStatusUrl = "late-request-1";
    parent.generation.submission.state = "submitted";
    parent.generation.submission.providerRequestId = "late-request-1";
    parent.generation.failure = {
      ...parent.generation.failure!,
      code: "provider_failed",
      phase: "poll",
      submissionUncertain: false,
    };
    const recipeFingerprint = buildVideoRecipeFingerprint({
      spec: parent.generation.spec,
      providerSourceId: parent.providerSourceId ?? null,
      retryOfAssetId: ASSET_ID,
    });
    const existingChild: PersistedAsset = {
      ...parent,
      _id: CHILD_ID,
      id: CHILD_ID,
      status: "queued",
      providerRequestId: null,
      providerStatusUrl: null,
      generation: {
        ...parent.generation,
        requestIdempotencyKey: retryInput.idempotencyKey,
        retryOfAssetId: ASSET_ID,
        recipeFingerprint,
        safetyProviderRequestIds: undefined,
        safetyAncestors: undefined,
        orchestration: {
          ...parent.generation.orchestration,
          state: "pending",
          startedAt: null,
        },
        submission: {
          state: "pending",
          attemptToken: "attempt-child",
          providerRequestId: null,
          submittedAt: null,
        },
        failure: null,
      },
    };
    const state = makeDependencies({
      findAsset: jest
        .fn()
        .mockResolvedValueOnce(parent)
        .mockResolvedValueOnce(existingChild),
    });

    await retryVideoGeneration(retryInput, state.deps);

    expect(state.mergeAssetSafetyLineage).toHaveBeenCalledWith({
      asset: existingChild,
      workspaceId: WORKSPACE_ID,
      providerRequestIds: ["late-request-1"],
      ancestors: [
        {
          assetId: ASSET_ID,
          attemptToken: "old-attempt",
        },
      ],
    });
    expect(
      state.mergeAssetSafetyLineage.mock.invocationCallOrder[0]
    ).toBeLessThan(state.startWorkflow.mock.invocationCallOrder[0]!);
  });

  it("uses a fresh admitted attempt after a definitive provider failure", async () => {
    const parent = recoverableGoogleParent();
    parent.generation.safetyProviderRequestIds = ["operations/video-0"];
    parent.generation.failure = {
      ...parent.generation.failure!,
      phase: "poll",
      code: "provider_failed",
      message: "Provider failed the generation",
      retryable: true,
    };
    const state = makeDependencies({
      newAssetId: jest.fn(() => CHILD_ID),
      newAttemptToken: jest.fn(() => "attempt-paid-retry"),
    });
    state.findAsset.mockResolvedValue(parent);

    await retryVideoGeneration(retryInput, state.deps);

    expect(state.withPlatformQuotaAdmission).not.toHaveBeenCalled();
    expect(state.createAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        providerRequestId: null,
        providerStatusUrl: null,
        generation: expect.objectContaining({
          recoveryMode: null,
          safetyProviderRequestIds: [
            "operations/video-0",
            "operations/video-1",
          ],
          submission: expect.objectContaining({
            state: "pending",
            providerRequestId: null,
          }),
        }),
      })
    );
    expect(state.startWorkflow).toHaveBeenCalledWith(
      expect.not.objectContaining({ resume: expect.anything() })
    );
  });

  it("rejects safety lineage overflow before creating or charging a retry", async () => {
    const parent = recoverableGoogleParent();
    parent.generation.safetyProviderRequestIds = Array.from(
      { length: MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_IDS },
      (_, index) => `operations/ancestor-${index}`
    );
    parent.generation.failure = {
      ...parent.generation.failure!,
      phase: "poll",
      code: "provider_failed",
      message: "Provider failed the generation",
      retryable: true,
    };
    const state = makeDependencies();
    state.findAsset.mockResolvedValue(parent);

    await expect(
      retryVideoGeneration(retryInput, state.deps)
    ).rejects.toMatchObject({
      status: 409,
      code: "video_safety_lineage_limit_exceeded",
    });
    expect(state.createAsset).not.toHaveBeenCalled();
    expect(state.withPlatformQuotaAdmission).not.toHaveBeenCalled();
    expect(state.startWorkflow).not.toHaveBeenCalled();
  });

  it("rejects ancestor safety lineage overflow before creating or charging a retry", async () => {
    const parent = failedParent();
    parent.generation.safetyAncestors = Array.from(
      { length: MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_IDS },
      (_, index) => ({
        assetId: `ancestor-${index}`,
        attemptToken: `attempt-${index}`,
      })
    );
    const state = makeDependencies();
    state.findAsset.mockResolvedValue(parent);

    await expect(
      retryVideoGeneration(retryInput, state.deps)
    ).rejects.toMatchObject({
      status: 409,
      code: "video_safety_lineage_limit_exceeded",
    });
    expect(state.createAsset).not.toHaveBeenCalled();
    expect(state.withPlatformQuotaAdmission).not.toHaveBeenCalled();
    expect(state.startWorkflow).not.toHaveBeenCalled();
  });

  it("does not turn a nonretryable result failure into a paid retry without a locator", async () => {
    const parent = recoverableGoogleParent();
    parent.providerStatusUrl = null;
    const state = makeDependencies();
    state.findAsset.mockResolvedValue(parent);

    await expect(
      retryVideoGeneration(retryInput, state.deps)
    ).rejects.toMatchObject({
      status: 409,
      code: "asset_not_retryable",
    });
    expect(state.createAsset).not.toHaveBeenCalled();
    expect(state.withPlatformQuotaAdmission).not.toHaveBeenCalled();
  });

  it("does not recover a definitive nonretryable materialization failure", async () => {
    const parent = recoverableGoogleParent();
    parent.generation.failure = {
      ...parent.generation.failure!,
      code: "result_duration_invalid",
      message: "Generated video duration is invalid",
    };
    const state = makeDependencies();
    state.findAsset.mockResolvedValue(parent);

    await expect(
      retryVideoGeneration(retryInput, state.deps)
    ).rejects.toMatchObject({
      status: 409,
      code: "asset_not_retryable",
    });
    expect(state.createAsset).not.toHaveBeenCalled();
    expect(state.withPlatformQuotaAdmission).not.toHaveBeenCalled();
  });

  it("does not consume quota again when replaying an accepted Google retry child", async () => {
    const parent = googleFailedParent();
    const initial = makeDependencies({
      newAssetId: jest.fn(() => CHILD_ID),
      newAttemptToken: jest.fn(() => "attempt-child"),
    });
    initial.findAsset.mockResolvedValue(parent);
    await retryVideoGeneration(retryInput, initial.deps);
    const child = initial.createAsset.mock
      .calls[0]?.[0] as unknown as PersistedAsset;
    child.id = CHILD_ID;

    const replay = makeDependencies({
      findAsset: jest
        .fn()
        .mockResolvedValueOnce(parent)
        .mockResolvedValueOnce(child),
    });
    await retryVideoGeneration(retryInput, replay.deps);

    expect(replay.withPlatformQuotaAdmission).not.toHaveBeenCalled();
    expect(replay.createAsset).not.toHaveBeenCalled();
    expect(replay.startWorkflow).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", null, "asset_not_found", 404],
    [
      "non-v1",
      { ...failedParent(), generation: null },
      "asset_not_retryable",
      409,
    ],
    [
      "not failed",
      { ...failedParent(), status: "complete" },
      "asset_not_retryable",
      409,
    ],
    ["nsfw", { ...failedParent(), status: "nsfw" }, "nsfw_not_retryable", 409],
    [
      "permanent failure",
      (() => {
        const parent = failedParent();
        parent.generation.failure!.retryable = false;
        return parent;
      })(),
      "asset_not_retryable",
      409,
    ],
  ])("rejects %s parents", async (_label, parent, code, status) => {
    const { deps, findAsset, createAsset } = makeDependencies();
    findAsset.mockResolvedValue(parent);

    await expect(retryVideoGeneration(retryInput, deps)).rejects.toMatchObject({
      status,
      code,
    });
    expect(createAsset).not.toHaveBeenCalled();
  });

  it("compares retry parent lineage during a duplicate-key race", async () => {
    const parent = failedParent();
    const { deps, findAsset, createAsset, startWorkflow } = makeDependencies({
      newAssetId: jest.fn(() => CHILD_ID),
    });
    findAsset.mockResolvedValueOnce(parent).mockResolvedValueOnce({
      ...parent,
      _id: CHILD_ID,
      id: CHILD_ID,
      generation: {
        ...parent.generation,
        requestIdempotencyKey: retryInput.idempotencyKey,
        retryOfAssetId: "another-parent",
        recipeFingerprint: "different",
      },
    });
    createAsset.mockRejectedValue({ code: 11000 });

    await expect(retryVideoGeneration(retryInput, deps)).rejects.toMatchObject({
      status: 409,
      code: "idempotency_key_conflict",
    });
    expect(startWorkflow).not.toHaveBeenCalled();
  });
});

/**
 * @jest-environment node
 */

import {
  CREATIVE_ASSET_PLATFORM_QUOTA_INDEX,
  CREATIVE_ASSET_PLATFORM_QUOTA_LEGACY_INDEX_NAME,
  CREATIVE_ASSET_VIDEO_IDEMPOTENCY_INDEX,
  CREATIVE_ASSET_VIDEO_NSFW_CLEANUP_INDEX,
  CREATIVE_ASSET_VIDEO_ORCHESTRATION_LEGACY_INDEX_NAME,
  CREATIVE_ASSET_VIDEO_ORCHESTRATION_INDEX,
  CREATIVE_ASSET_VIDEO_SAFETY_ALIAS_INDEX,
  CREATIVE_ASSET_VIDEO_SAFETY_ANCESTOR_INDEX,
  CreativeAsset,
} from "./creative-asset";
import {
  MAX_VIDEO_GENERATION_SAFETY_ANCESTORS,
  MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_IDS,
} from "@/lib/creative-assets/video-generation-nsfw";
import { serializeCreativeAsset } from "@/lib/higgsfield/creative-asset-serialization";

describe("CreativeAsset video generation envelope", () => {
  it("persists a bounded private completion target without exposing it in public DTOs", () => {
    const asset = new CreativeAsset({
      workspaceId: "workspace-1",
      kind: "video",
      source: "happyhorse",
      status: "queued",
      generation: {
        contractVersion: 1,
        spec: {
          contractVersion: 1,
          provider: "happyhorse",
          mode: "text_to_video",
          skill: "video",
          userPrompt: "Create a video",
          modelId: "happyhorse-v1",
          seed: null,
          durationSeconds: 5,
          aspectRatio: "16:9",
          resolution: "720P",
          sourceAssetId: null,
          referenceAssetIds: [],
        },
        prompt: {
          compilerId: "airi-video-director",
          compilerVersion: 1,
          normalizedUserPrompt: "Create a video",
          providerPrompt: "PRIVATE_PROVIDER_PROMPT",
          providerPromptSha256: "a".repeat(64),
          warnings: [],
        },
        requestIdempotencyKey: "request-1",
        retryOfAssetId: null,
        recipeFingerprint: "recipe-1",
        orchestration: {
          workflowId: "video-generation:asset-1",
          state: "pending",
          startedAt: null,
          completionTarget: {
            workflowId: "scenario-generation:workflow-1",
            signalName: "videoGenerationCompleted",
            correlationId: "execution-1",
          },
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

    expect(asset.validateSync()).toBeUndefined();
    const persisted = asset.toObject();
    expect(persisted.generation?.orchestration.completionTarget).toEqual({
      workflowId: "scenario-generation:workflow-1",
      signalName: "videoGenerationCompleted",
      correlationId: "execution-1",
    });
    expect(serializeCreativeAsset(persisted)).not.toHaveProperty(
      "generation.completionTarget"
    );
    expect(serializeCreativeAsset(persisted)).not.toHaveProperty(
      "generation.orchestration"
    );
  });

  it("persists the complete scenario WhatsApp source provenance", () => {
    const asset = new CreativeAsset({
      _id: "0123456789abcdef01234567",
      workspaceId: "workspace-1",
      kind: "image",
      source: "uploaded",
      status: "complete",
      sourceMedia: {
        version: 1,
        provenanceDigest: "a".repeat(64),
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        inputMessageId: "message-1",
        whatsappMediaId: "media-1",
        declaredMimeType: "image/jpeg",
        contentSha256: "b".repeat(64),
      },
    });

    expect(asset.validateSync()).toBeUndefined();
    expect(asset.toObject().sourceMedia).toEqual({
      version: 1,
      provenanceDigest: "a".repeat(64),
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      inputMessageId: "message-1",
      whatsappMediaId: "media-1",
      declaredMimeType: "image/jpeg",
      contentSha256: "b".repeat(64),
    });
  });

  it("persists only the bounded provider-result recovery marker", () => {
    const generation = {
      contractVersion: 1,
      recoveryMode: "provider_result",
      spec: {
        contractVersion: 1,
        provider: "happyhorse",
        mode: "text_to_video",
        skill: "video",
        userPrompt: "Create a video",
        modelId: "happyhorse-v1",
        seed: null,
        durationSeconds: 5,
        aspectRatio: "16:9",
        resolution: "720P",
        sourceAssetId: null,
        referenceAssetIds: [],
      },
      prompt: {
        compilerId: "airi-video-director",
        compilerVersion: 1,
        normalizedUserPrompt: "Create a video",
        providerPrompt: "PRIVATE_PROVIDER_PROMPT",
        providerPromptSha256: "a".repeat(64),
        warnings: [],
      },
      requestIdempotencyKey: "request-1",
      retryOfAssetId: "failed-asset-1",
      safetyProviderRequestIds: ["provider-0"],
      safetyAncestors: [{ assetId: "asset-0", attemptToken: "attempt-0" }],
      recipeFingerprint: "recipe-1",
      orchestration: {
        workflowId: "video-generation:asset-1",
        state: "pending",
        startedAt: null,
      },
      submission: {
        state: "submitted",
        attemptToken: "attempt-1",
        providerRequestId: "provider-1",
        submittedAt: new Date(),
      },
      result: null,
      failure: null,
    };
    const asset = new CreativeAsset({
      workspaceId: "workspace-1",
      kind: "video",
      source: "happyhorse",
      status: "queued",
      generation,
    });

    expect(asset.validateSync()).toBeUndefined();
    expect(asset.toObject().generation?.recoveryMode).toBe("provider_result");
    expect(asset.toObject().generation?.safetyProviderRequestIds).toEqual([
      "provider-0",
    ]);
    expect(asset.toObject().generation?.safetyAncestors).toEqual([
      { assetId: "asset-0", attemptToken: "attempt-0" },
    ]);

    asset.set("generation.recoveryMode", "paid_retry");
    expect(
      asset.validateSync()?.errors["generation.recoveryMode"]
    ).toBeDefined();

    asset.set("generation.recoveryMode", "provider_result");
    asset.set(
      "generation.safetyAncestors",
      Array.from(
        { length: MAX_VIDEO_GENERATION_SAFETY_ANCESTORS + 1 },
        (_, index) => ({
          assetId: `asset-${index}`,
          attemptToken: `attempt-${index}`,
        })
      )
    );
    expect(
      asset.validateSync()?.errors["generation.safetyAncestors"]
    ).toBeDefined();
  });

  it("rejects safety provider request lineage overflow instead of truncating", () => {
    const asset = new CreativeAsset({
      workspaceId: "workspace-1",
      kind: "video",
      source: "happyhorse",
      status: "queued",
      generation: {
        contractVersion: 1,
        spec: {
          contractVersion: 1,
          provider: "happyhorse",
          mode: "text_to_video",
          skill: "video",
          userPrompt: "Create a video",
          modelId: "happyhorse-v1",
          seed: null,
          durationSeconds: 5,
          aspectRatio: "16:9",
          resolution: "720P",
          sourceAssetId: null,
          referenceAssetIds: [],
        },
        prompt: {
          compilerId: "airi-video-director",
          compilerVersion: 1,
          normalizedUserPrompt: "Create a video",
          providerPrompt: "PRIVATE_PROVIDER_PROMPT",
          providerPromptSha256: "a".repeat(64),
          warnings: [],
        },
        requestIdempotencyKey: "request-1",
        retryOfAssetId: null,
        safetyProviderRequestIds: Array.from(
          {
            length: MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_IDS + 1,
          },
          (_, index) => `provider-${index}`
        ),
        recipeFingerprint: "recipe-1",
        orchestration: {
          workflowId: "video-generation:asset-1",
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

    expect(
      asset.validateSync()?.errors["generation.safetyProviderRequestIds"]
    ).toBeDefined();
  });

  it("declares bounded indexes for idempotency and orchestration repair", () => {
    expect(CREATIVE_ASSET_PLATFORM_QUOTA_INDEX).toEqual({
      key: {
        workspaceId: 1,
        "generation.recoveryMode": 1,
        provider: 1,
        status: 1,
        providerSourceId: 1,
      },
      options: {
        name: "workspace_platform_creative_generation_quota_v2",
        partialFilterExpression: {
          provider: { $in: ["google", "elevenlabs"] },
          status: { $in: ["queued", "in_progress", "complete", "nsfw"] },
        },
      },
    });
    expect(CREATIVE_ASSET_PLATFORM_QUOTA_LEGACY_INDEX_NAME).toBe(
      "workspace_platform_creative_generation_quota"
    );
    expect(CREATIVE_ASSET_VIDEO_IDEMPOTENCY_INDEX).toEqual({
      key: { workspaceId: 1, "generation.requestIdempotencyKey": 1 },
      options: {
        name: "workspace_video_generation_idempotency",
        unique: true,
        partialFilterExpression: {
          "generation.requestIdempotencyKey": { $type: "string" },
        },
      },
    });
    expect(CREATIVE_ASSET_VIDEO_SAFETY_ALIAS_INDEX).toEqual({
      key: {
        workspaceId: 1,
        "generation.safetyProviderRequestIds": 1,
      },
      options: {
        name: "workspace_video_generation_safety_alias",
        partialFilterExpression: {
          "generation.contractVersion": 1,
          "generation.spec.provider": "higgsfield",
          "generation.safetyProviderRequestIds": { $exists: true },
        },
      },
    });
    expect(CREATIVE_ASSET_VIDEO_SAFETY_ANCESTOR_INDEX).toEqual({
      key: {
        workspaceId: 1,
        "generation.safetyAncestors.assetId": 1,
        "generation.safetyAncestors.attemptToken": 1,
      },
      options: {
        name: "workspace_video_generation_safety_ancestor",
        partialFilterExpression: {
          "generation.contractVersion": 1,
          "generation.spec.provider": "higgsfield",
          "generation.safetyAncestors": { $exists: true },
        },
      },
    });
    expect(CREATIVE_ASSET_VIDEO_ORCHESTRATION_INDEX).toEqual({
      key: { "generation.orchestration.state": 1, updatedAt: 1, _id: 1 },
      options: {
        name: "video_generation_orchestration_reconcile_v2",
        partialFilterExpression: {
          status: { $in: ["queued", "in_progress"] },
          "generation.contractVersion": 1,
          "generation.orchestration.state": {
            $in: ["pending", "unknown", "started"],
          },
        },
      },
    });
    expect(CREATIVE_ASSET_VIDEO_ORCHESTRATION_LEGACY_INDEX_NAME).toBe(
      "video_generation_orchestration_reconcile"
    );
    expect(CREATIVE_ASSET_VIDEO_NSFW_CLEANUP_INDEX).toEqual({
      key: { updatedAt: 1, _id: 1 },
      options: {
        name: "video_generation_nsfw_storage_cleanup",
        partialFilterExpression: {
          kind: "video",
          status: "nsfw",
          storageProvider: "gcs",
          workspaceId: { $type: "string" },
          bucket: { $type: "string" },
          path: { $type: "string" },
          "generation.contractVersion": 1,
          "generation.submission.attemptToken": { $type: "string" },
        },
      },
    });
  });

  it("rejects more than nine reference assets in the private generation envelope", () => {
    const asset = new CreativeAsset({
      workspaceId: "workspace-1",
      kind: "video",
      source: "happyhorse",
      status: "queued",
      generation: {
        contractVersion: 1,
        spec: {
          contractVersion: 1,
          provider: "happyhorse",
          mode: "reference_to_video",
          skill: "character",
          userPrompt: "Create a video",
          modelId: "happyhorse-v1",
          seed: null,
          durationSeconds: 5,
          aspectRatio: "16:9",
          resolution: "720P",
          sourceAssetId: null,
          referenceAssetIds: Array.from(
            { length: 10 },
            (_, index) => `asset-${index}`
          ),
        },
        prompt: {
          compilerId: "airi-video-director",
          compilerVersion: 1,
          normalizedUserPrompt: "Create a video",
          providerPrompt: "PRIVATE_PROVIDER_PROMPT",
          providerPromptSha256: "a".repeat(64),
          warnings: [],
        },
        requestIdempotencyKey: "request-1",
        retryOfAssetId: null,
        recipeFingerprint: "recipe-1",
        orchestration: {
          workflowId: "video-generation:asset-1",
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

    const error = asset.validateSync();

    expect(error?.errors["generation.spec"]).toBeDefined();
  });

  it("rejects provider settings outside the frozen discriminated union", () => {
    const asset = new CreativeAsset({
      workspaceId: "workspace-1",
      kind: "video",
      source: "happyhorse",
      status: "queued",
      generation: {
        contractVersion: 1,
        spec: {
          contractVersion: 1,
          provider: "happyhorse",
          mode: "image_to_video",
          skill: "video",
          userPrompt: "Create a video",
          modelId: "happyhorse-v1",
          seed: null,
          durationSeconds: 5,
          aspectRatio: null,
          resolution: "720P",
          sourceAssetId: null,
          referenceAssetIds: [],
        },
        prompt: {
          compilerId: "airi-video-director",
          compilerVersion: 1,
          normalizedUserPrompt: "Create a video",
          providerPrompt: "PRIVATE_PROVIDER_PROMPT",
          providerPromptSha256: "a".repeat(64),
          warnings: [],
        },
        requestIdempotencyKey: "request-1",
        retryOfAssetId: null,
        recipeFingerprint: "recipe-1",
        orchestration: {
          workflowId: "video-generation:asset-1",
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

    const error = asset.validateSync();

    expect(error?.errors["generation.spec"]).toBeDefined();
  });

  it("bounds the durable webhook signal history and each key", () => {
    const asset = new CreativeAsset({
      workspaceId: "workspace-1",
      kind: "video",
      source: "higgsfield",
      status: "queued",
      generation: {
        contractVersion: 1,
        webhookSignalKeys: ["x".repeat(513)],
        spec: {
          contractVersion: 1,
          provider: "higgsfield",
          mode: "image_to_video",
          skill: "video",
          userPrompt: "Create a video",
          modelId: "higgsfield-v1",
          seed: null,
          durationSeconds: 5,
          aspectRatio: null,
          resolution: "provider_default",
          sourceAssetId: "source-asset-1",
          referenceAssetIds: [],
        },
        prompt: {
          compilerId: "airi-video-director",
          compilerVersion: 1,
          normalizedUserPrompt: "Create a video",
          providerPrompt: "PRIVATE_PROVIDER_PROMPT",
          providerPromptSha256: "a".repeat(64),
          warnings: [],
        },
        requestIdempotencyKey: "request-1",
        retryOfAssetId: null,
        recipeFingerprint: "recipe-1",
        orchestration: {
          workflowId: "video-generation:asset-1",
          state: "started",
          startedAt: new Date(),
        },
        submission: {
          state: "submitted",
          attemptToken: "attempt-1",
          providerRequestId: "request-1",
          submittedAt: new Date(),
        },
        result: null,
        failure: null,
      },
    });

    const keyError = asset.validateSync();

    expect(keyError?.errors["generation.webhookSignalKeys.0"]).toBeDefined();

    asset.set(
      "generation.webhookSignalKeys",
      Array.from({ length: 7 }, (_, index) => `request-1:status-${index}`)
    );
    const historyError = asset.validateSync();

    expect(historyError?.errors["generation.webhookSignalKeys"]).toBeDefined();
  });
});

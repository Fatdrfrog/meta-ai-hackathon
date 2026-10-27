import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ApplicationFailure } from "@temporalio/activity";

import { VideoProviderError } from "./activities/video-generation/providers/happyhorse.js";

import {
  buildVideoGenerationFinalizeIdentityFilter,
  videoGenerationFinalizeActivity,
  type VideoGenerationFinalizeActivityDependencies,
  type VideoGenerationFinalizeActivityInput,
} from "./activities/video-generation/finalize.js";

const activityInput: VideoGenerationFinalizeActivityInput = {
  contractVersion: 1,
  workspaceId: "workspace-1",
  assetId: "asset-1",
  attemptToken: "attempt-1",
  providerRequestId: "operation-1",
  providerRequestLocator: "operations/operation-1",
};

test("finalizer identity filter pins the immutable provider locator", () => {
  assert.deepEqual(buildVideoGenerationFinalizeIdentityFilter(activityInput), {
    _id: "asset-1",
    workspaceId: "workspace-1",
    "generation.contractVersion": 1,
    "generation.submission.attemptToken": "attempt-1",
    "generation.submission.providerRequestId": "operation-1",
    providerStatusUrl: "operations/operation-1",
  });
});

test("provider reloads and completion CAS retain the activity locator", async () => {
  const source = await readFile(
    new URL("./activities/video-generation/finalize.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /providerRequestLocator:\s*"unused"/);
  assert.doesNotMatch(
    source,
    /providerRequestLocator\s*=\s*asset\.providerStatusUrl/,
  );
  assert.match(
    source,
    /loadProviderResult\(\s*input,\s*activityInput\.providerRequestLocator,?\s*\)/s,
  );
  assert.match(
    source,
    /const completionIdentity = buildVideoGenerationFinalizeIdentityFilter\([\s\S]*?providerRequestLocator:\s*activityInput\.providerRequestLocator[\s\S]*?updateOne\(\s*{\s*\.\.\.completionIdentity,/,
  );
  assert.match(
    source,
    /async stageAsset\(params\)[\s\S]*?providerRequestLocator:\s*activityInput\.providerRequestLocator[\s\S]*?storageProvider:\s*params\.storage\.storageProvider/,
  );
  assert.match(
    source,
    /async clearStagedAsset\(params\)[\s\S]*?providerRequestLocator:\s*activityInput\.providerRequestLocator[\s\S]*?path:\s*params\.storage\.path/,
  );
});

test("finalization returns only bounded workflow state after materialization", async () => {
  const materializerInput = {
    workspaceId: "workspace-1",
    assetId: "asset-1",
    attemptToken: "attempt-1",
    providerRequestId: "operation-1",
    recipeFingerprint: "recipe-1",
    provider: "google" as const,
    requestedDurationSeconds: 4,
    startedAt: new Date("2026-07-22T10:00:00.000Z"),
  };
  const dependencies: VideoGenerationFinalizeActivityDependencies = {
    async loadContext() {
      return {
        asset: {
          _id: "asset-1",
          workspaceId: "workspace-1",
          status: "in_progress",
          providerRequestId: "operation-1",
          providerStatusUrl: "operations/operation-1",
          generation: {
            contractVersion: 1,
            recipeFingerprint: "recipe-1",
            spec: {
              contractVersion: 1,
              provider: "google",
              mode: "image_to_video",
              skill: "video",
              userPrompt: "A product turntable",
              modelId: "veo-3.1-generate-preview",
              seed: null,
              durationSeconds: 4,
              aspectRatio: "9:16",
              resolution: "720p",
              sourceAssetId: "source-1",
              referenceAssetIds: [],
            },
            orchestration: { startedAt: null },
            submission: {
              state: "submitted",
              attemptToken: "attempt-1",
              providerRequestId: "operation-1",
              submittedAt: new Date("2026-07-22T10:00:00.000Z"),
            },
            result: null,
          },
        },
        materializerInput,
      };
    },
    createMaterializerDependencies() {
      return {} as never;
    },
    async materialize(input) {
      assert.deepEqual(input, materializerInput);
      return {
        status: "complete",
        result: {
          durationSeconds: 4,
          width: 720,
          height: 1280,
          mimeType: "video/mp4",
          fileSize: 1_024,
          sha256: "a".repeat(64),
          providerUsage: null,
          warnings: [],
          startedAt: materializerInput.startedAt,
          completedAt: new Date("2026-07-22T10:01:00.000Z"),
        },
      };
    },
  };

  const result = await videoGenerationFinalizeActivity(
    activityInput,
    dependencies,
  );

  assert.deepEqual(result, {
    contractVersion: 1,
    assetId: "asset-1",
    attemptToken: "attempt-1",
    status: "complete",
    terminal: true,
    providerRequestId: "operation-1",
    providerRequestLocator: "operations/operation-1",
    providerStatus: "completed",
    submissionState: "submitted",
  });
  assert.doesNotMatch(JSON.stringify(result), /https?:|videoBytes|signed/i);
});

function failingDependencies(
  error: Error,
): VideoGenerationFinalizeActivityDependencies {
  return {
    async loadContext() {
      return {
        asset: {
          _id: "asset-1",
          workspaceId: "workspace-1",
          status: "in_progress",
          providerRequestId: "operation-1",
          providerStatusUrl: "operations/operation-1",
          generation: {
            contractVersion: 1,
            recipeFingerprint: "recipe-1",
            spec: {
              contractVersion: 1,
              provider: "google",
              mode: "image_to_video",
              skill: "video",
              userPrompt: "A product turntable",
              modelId: "veo-3.1-generate-preview",
              seed: null,
              durationSeconds: 4,
              aspectRatio: "9:16",
              resolution: "720p",
              sourceAssetId: "source-1",
              referenceAssetIds: [],
            },
            orchestration: { startedAt: null },
            submission: {
              state: "submitted",
              attemptToken: "attempt-1",
              providerRequestId: "operation-1",
              submittedAt: new Date("2026-07-22T10:00:00.000Z"),
            },
            result: null,
          },
        },
        materializerInput: {
          workspaceId: "workspace-1",
          assetId: "asset-1",
          attemptToken: "attempt-1",
          providerRequestId: "operation-1",
          recipeFingerprint: "recipe-1",
          provider: "google",
          requestedDurationSeconds: 4,
          startedAt: null,
        },
      };
    },
    createMaterializerDependencies() {
      return {} as never;
    },
    async materialize() {
      throw error;
    },
  };
}

test("serializes provider protocol failures as bounded Temporal details", async () => {
  const providerError = new VideoProviderError({
    code: "provider_protocol_error",
    providerCode: "BAD_RESULT",
    message:
      "Provider returned a secret result at https://signed.example/video?token=secret",
    phase: "poll",
    retryable: false,
    certainty: "not_attempted",
  });

  await assert.rejects(
    videoGenerationFinalizeActivity(
      activityInput,
      failingDependencies(providerError),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplicationFailure);
      assert.equal(error.type, "VideoGenerationFinalizationFailure");
      assert.equal(error.nonRetryable, true);
      assert.deepEqual(error.details, [
        {
          contractVersion: 1,
          phase: "poll",
          code: "provider_protocol_error",
          providerCode: "BAD_RESULT",
          message: "Provider result did not satisfy the completion contract",
          retryable: false,
        },
      ]);
      assert.doesNotMatch(
        JSON.stringify(error.details),
        /https?:|token=|secret/i,
      );
      return true;
    },
  );
});

test("redacts untyped materialization failures before Temporal serialization", async () => {
  await assert.rejects(
    videoGenerationFinalizeActivity(
      activityInput,
      failingDependencies(
        new Error("upload failed for gs://secret-bucket/video?token=secret"),
      ),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ApplicationFailure);
      assert.equal(error.type, "VideoGenerationFinalizationFailure");
      assert.deepEqual(error.details, [
        {
          contractVersion: 1,
          phase: "store",
          code: "result_materialization_failed",
          providerCode: null,
          message: "Generated video could not be verified and stored",
          retryable: true,
        },
      ]);
      assert.doesNotMatch(JSON.stringify(error.details), /gs:|token=|secret/i);
      return true;
    },
  );
});

test("redacts context-loading failures before Temporal serialization", async () => {
  const dependencies = failingDependencies(new Error("unused"));
  dependencies.loadContext = async () => {
    throw new Error(
      "Mongo failed at mongodb://user:secret@private.example/assets",
    );
  };

  await assert.rejects(
    videoGenerationFinalizeActivity(activityInput, dependencies),
    (error: unknown) => {
      assert.ok(error instanceof ApplicationFailure);
      assert.equal(error.type, "VideoGenerationFinalizationFailure");
      assert.deepEqual(error.details, [
        {
          contractVersion: 1,
          phase: "store",
          code: "result_materialization_failed",
          providerCode: null,
          message: "Generated video could not be verified and stored",
          retryable: true,
        },
      ]);
      assert.doesNotMatch(JSON.stringify(error), /mongodb:|user:|secret/i);
      return true;
    },
  );
});

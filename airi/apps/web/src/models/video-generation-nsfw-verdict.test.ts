/**
 * @jest-environment node
 */

import {
  VideoGenerationNsfwVerdict,
  VIDEO_GENERATION_NSFW_VERDICT_PENDING_SWEEP_INDEX,
  VIDEO_GENERATION_NSFW_VERDICT_SOURCE_INDEX,
} from "./video-generation-nsfw-verdict";

describe("VideoGenerationNsfwVerdict", () => {
  it("keeps an irreversible bounded NSFW identity", () => {
    const verdict = new VideoGenerationNsfwVerdict({
      _id: "a".repeat(64),
      workspaceId: "workspace-1",
      provider: "higgsfield",
      providerRequestId: "request-1",
      verdict: "nsfw",
      sourceAssetId: "asset-1",
      sourceAttemptToken: "attempt-1",
      firstReceivedAt: new Date("2026-07-23T12:00:00.000Z"),
      lastReceivedAt: new Date("2026-07-23T12:00:00.000Z"),
      sweepCompletedAt: null,
    });

    expect(verdict.validateSync()).toBeUndefined();
    verdict.set("verdict", "safe");
    expect(verdict.validateSync()?.errors.verdict).toBeDefined();
  });

  it("declares a source-attempt lookup index without a TTL", () => {
    expect(VIDEO_GENERATION_NSFW_VERDICT_SOURCE_INDEX).toEqual({
      key: {
        workspaceId: 1,
        provider: 1,
        sourceAssetId: 1,
        sourceAttemptToken: 1,
      },
      options: {
        name: "workspace_video_nsfw_source_attempt",
      },
    });
    expect(
      VideoGenerationNsfwVerdict.schema
        .indexes()
        .some(([, options]) => "expireAfterSeconds" in options)
    ).toBe(false);
  });

  it("indexes pending sweeps for bounded application-owned replay", () => {
    expect(VIDEO_GENERATION_NSFW_VERDICT_PENDING_SWEEP_INDEX).toEqual({
      key: {
        sweepCompletedAt: 1,
        firstReceivedAt: 1,
        _id: 1,
      },
      options: {
        name: "video_generation_nsfw_pending_sweep",
        partialFilterExpression: {
          sweepCompletedAt: null,
        },
      },
    });
    const pendingIndex = VideoGenerationNsfwVerdict.schema
      .indexes()
      .find(
        ([, options]) =>
          options.name ===
          VIDEO_GENERATION_NSFW_VERDICT_PENDING_SWEEP_INDEX.options.name
      );
    expect(pendingIndex?.[0]).toEqual(
      VIDEO_GENERATION_NSFW_VERDICT_PENDING_SWEEP_INDEX.key
    );
    expect(pendingIndex?.[1]).toMatchObject(
      VIDEO_GENERATION_NSFW_VERDICT_PENDING_SWEEP_INDEX.options
    );
  });
});

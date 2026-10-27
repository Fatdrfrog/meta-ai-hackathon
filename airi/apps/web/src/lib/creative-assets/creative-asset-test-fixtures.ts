// Creative asset documents shared by route suites.

/**
 * An in-progress contract-v1 video whose PRIVATE_* prompt, URL and
 * diagnostic markers and provider ids must never reach a client response.
 */
export function contractV1VideoAsset(assetId: string) {
  return {
    _id: assetId,
    workspaceId: "workspace-1",
    kind: "video",
    source: "happyhorse",
    provider: "happyhorse",
    status: "in_progress",
    prompt: "PRIVATE_TOP_LEVEL_PROMPT",
    url: "https://provider.example/result.mp4?signature=PRIVATE_PROVIDER_URL",
    error: "PRIVATE_PROVIDER_DIAGNOSTIC",
    providerRequestId: "provider-request-1",
    providerSourceId: "provider-source-1",
    providerStatusUrl: "https://provider.example/status",
    providerCancelUrl: "https://provider.example/cancel",
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
        workflowId: `video-generation:${assetId}`,
        state: "pending",
        startedAt: null,
      },
      submission: {
        state: "pending",
        attemptToken: "attempt-1",
        providerRequestId: "provider-request-1",
        submittedAt: null,
      },
      result: null,
      failure: null,
    },
  };
}

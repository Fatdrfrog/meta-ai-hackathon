import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  videoGenerationFailActivity,
  videoGenerationPollActivity,
  videoGenerationSubmitActivity,
  type VideoGenerationActivityDependencies,
  type VideoGenerationAssetSnapshot,
} from "./activities/video-generation/index.js";
import type { VideoGenerationWorkflowInput } from "@icecore/temporal";
import { VideoProviderError } from "./activities/video-generation/providers/happyhorse.js";

const input: VideoGenerationWorkflowInput = {
  contractVersion: 1,
  workspaceId: "workspace-1",
  assetId: "asset-1",
  attemptToken: "attempt-1",
  providerSourceId: null,
  mediaTaskQueue: "media",
  spec: {
    contractVersion: 1,
    provider: "happyhorse",
    mode: "text_to_video",
    skill: "video",
    userPrompt: "A launch",
    modelId: "model-1",
    seed: null,
    durationSeconds: 5,
    aspectRatio: "9:16",
    resolution: "720P",
    sourceAssetId: null,
    referenceAssetIds: [],
  },
  prompt: {
    compilerId: "airi-video-director",
    compilerVersion: 1,
    normalizedUserPrompt: "A launch",
    providerPrompt: "A launch. Vertical framing.",
    providerPromptSha256: "hash-1",
    warnings: [],
  },
};

function snapshot(
  overrides: Partial<VideoGenerationAssetSnapshot> = {},
): VideoGenerationAssetSnapshot {
  return {
    id: input.assetId,
    workspaceId: input.workspaceId,
    status: "queued",
    providerSourceId: null,
    generation: {
      spec: input.spec,
      prompt: input.prompt,
      webhookSignalKeys: [],
      submission: {
        state: "pending",
        attemptToken: input.attemptToken,
        providerRequestId: null,
        providerRequestLocator: null,
      },
    },
    ...overrides,
  };
}

function harness(
  initial = snapshot(),
  options: {
    nsfwVerdict?: {
      providerRequestId: string;
      sourceAssetId: string;
      sourceAttemptToken: string;
    } | null;
  } = {},
) {
  let asset = structuredClone(initial);
  const mutations: Array<{ scope: unknown; update: unknown }> = [];
  let posts = 0;
  const deps: VideoGenerationActivityDependencies = {
    loadAsset: async (scope) => {
      assert.equal(scope.workspaceId, input.workspaceId);
      assert.equal(scope.assetId, input.assetId);
      assert.equal(scope.attemptToken, input.attemptToken);
      return structuredClone(asset);
    },
    mutateAsset: async (scope, update) => {
      mutations.push({ scope, update });
      if (scope.providerRequestId !== undefined) {
        assert.equal(
          scope.providerRequestId,
          asset.generation.submission.providerRequestId,
        );
      }
      if (scope.providerRequestLocator !== undefined) {
        assert.equal(
          scope.providerRequestLocator,
          asset.generation.submission.providerRequestLocator,
        );
      }
      if (scope.providerSourceId !== undefined) {
        assert.equal(scope.providerSourceId, asset.providerSourceId);
      }
      if (
        scope.submissionStates &&
        !scope.submissionStates.includes(asset.generation.submission.state)
      )
        return false;
      if (scope.statuses && !scope.statuses.includes(asset.status))
        return false;
      asset = {
        ...asset,
        status: update.status ?? asset.status,
        generation: {
          ...asset.generation,
          submission: {
            ...asset.generation.submission,
            ...(update.submissionState
              ? { state: update.submissionState }
              : {}),
            ...(update.providerRequestId !== undefined
              ? { providerRequestId: update.providerRequestId }
              : {}),
            ...(update.providerRequestLocator !== undefined
              ? { providerRequestLocator: update.providerRequestLocator }
              : {}),
          },
        },
      };
      return true;
    },
    prepareSubmission: async (value) => ({
      spec: value.spec as Extract<
        typeof value.spec,
        { provider: "happyhorse" }
      >,
      prompt: value.prompt,
      provider: "happyhorse",
      sourceUrls: [],
      post: async () => ({
        providerRequestId: "provider-1",
        providerRequestLocator: "provider-1",
        status: "queued",
      }),
    }),
    submitProvider: async () => {
      posts += 1;
      return {
        providerRequestId: "provider-1",
        providerRequestLocator: "provider-1",
        status: "queued",
      };
    },
    pollProvider: async (_input, persistDiagnostic) => {
      await persistDiagnostic({ token: "secret", state: "working" });
      return { providerRequestId: "provider-1", status: "in_progress" };
    },
  };
  (
    deps as VideoGenerationActivityDependencies & {
      findNsfwSafetyVerdict: () => Promise<unknown>;
    }
  ).findNsfwSafetyVerdict = async () => options.nsfwVerdict ?? null;
  return {
    deps,
    get asset() {
      return asset;
    },
    mutations,
    get posts() {
      return posts;
    },
    replaceAsset(next: VideoGenerationAssetSnapshot) {
      asset = structuredClone(next);
    },
  };
}

test("submit quarantines durable ancestor NSFW before any provider POST", async () => {
  const higgsfieldInput: VideoGenerationWorkflowInput = {
    ...input,
    providerSourceId: "source-1",
    spec: {
      contractVersion: 1,
      provider: "higgsfield",
      mode: "image_to_video",
      skill: "video",
      userPrompt: input.spec.userPrompt,
      sourceAssetId: "source-image-1",
      referenceAssetIds: [],
      modelId: "higgsfield-model",
      seed: null,
      durationSeconds: 5,
      aspectRatio: null,
      resolution: "provider_default",
    },
  };
  const state = harness(
    snapshot({
      providerSourceId: "source-1",
      generation: {
        spec: higgsfieldInput.spec,
        prompt: higgsfieldInput.prompt,
        webhookSignalKeys: [],
        safetyProviderRequestIds: [],
        safetyAncestors: [
          {
            assetId: "parent-asset-1",
            attemptToken: "parent-attempt-1",
          },
        ],
        submission: {
          state: "pending",
          attemptToken: higgsfieldInput.attemptToken,
          providerRequestId: null,
          providerRequestLocator: null,
        },
      },
    } as Partial<VideoGenerationAssetSnapshot>),
    {
      nsfwVerdict: {
        providerRequestId: "unsafe-parent-request",
        sourceAssetId: "parent-asset-1",
        sourceAttemptToken: "parent-attempt-1",
      },
    },
  );

  const result = await videoGenerationSubmitActivity(
    higgsfieldInput,
    state.deps,
  );

  assert.equal(result.status, "nsfw");
  assert.equal(state.posts, 0);
  const update = state.mutations[0]?.update as {
    status?: string;
    failure?: {
      code?: string;
      retryable?: boolean;
      submissionUncertain?: boolean;
    };
  };
  assert.equal(update.status, "nsfw");
  assert.equal(update.failure?.code, "provider_nsfw");
  assert.equal(update.failure?.retryable, false);
  assert.equal(update.failure?.submissionUncertain, false);
});

test("submit claims pending immediately before one outbound POST and persists submitted state", async () => {
  const state = harness();
  const result = await videoGenerationSubmitActivity(input, state.deps);

  assert.equal(state.posts, 1);
  assert.equal(result.submissionState, "submitted");
  assert.equal(result.providerRequestId, "provider-1");
  assert.equal(
    state.mutations[0]?.update &&
      (state.mutations[0].update as { submissionState: string })
        .submissionState,
    "dispatching",
  );
  assert.deepEqual(
    (state.mutations[0]?.scope as { submissionStates: string[] })
      .submissionStates,
    ["pending"],
  );
});

test("a dispatching retry becomes unknown without a second POST", async () => {
  const current = snapshot();
  current.generation.submission.state = "dispatching";
  const state = harness(current);
  const result = await videoGenerationSubmitActivity(input, state.deps);

  assert.equal(state.posts, 0);
  assert.equal(result.status, "failed");
  assert.equal(result.submissionState, "unknown");
  assert.equal(
    (
      state.mutations[0]?.update as {
        failure: { submissionUncertain: boolean };
      }
    ).failure.submissionUncertain,
    true,
  );
});

test("a dispatching retry accepts an authenticated webhook identity winner without another POST", async () => {
  const current = snapshot();
  current.generation.submission.state = "dispatching";
  const adopted = snapshot({ status: "in_progress" });
  adopted.generation.submission.state = "submitted";
  adopted.generation.submission.providerRequestId = "provider-from-webhook";
  adopted.generation.submission.providerRequestLocator =
    "provider-from-webhook";
  const state = harness(current);
  state.deps.mutateAsset = async () => {
    state.replaceAsset(adopted);
    return false;
  };

  const result = await videoGenerationSubmitActivity(input, state.deps);

  assert.equal(state.posts, 0);
  assert.equal(result.status, "in_progress");
  assert.equal(result.submissionState, "submitted");
  assert.equal(result.providerRequestId, "provider-from-webhook");
  assert.equal(result.providerRequestLocator, "provider-from-webhook");
});

test("pre-network preparation failure becomes not_attempted", async () => {
  const state = harness();
  state.deps.prepareSubmission = async () => {
    throw Object.assign(new Error("source unavailable"), {
      code: "source_unavailable",
      certainty: "not_attempted",
      phase: "submit",
      retryable: true,
    });
  };
  const result = await videoGenerationSubmitActivity(input, state.deps);

  assert.equal(state.posts, 0);
  assert.equal(result.submissionState, "not_attempted");
  assert.equal(result.status, "failed");
});

test("post-claim uncertainty becomes unknown and never repeats the POST", async () => {
  const state = harness();
  let attemptedPosts = 0;
  state.deps.submitProvider = async () => {
    attemptedPosts += 1;
    throw Object.assign(new Error("connection reset"), {
      code: "provider_network_error",
      certainty: "unknown",
      phase: "submit",
      retryable: true,
    });
  };
  const first = await videoGenerationSubmitActivity(input, state.deps);
  const second = await videoGenerationSubmitActivity(input, state.deps);

  assert.equal(attemptedPosts, 1);
  assert.equal(first.submissionState, "unknown");
  assert.equal(second.submissionState, "unknown");
});

test("post-claim uncertainty accepts an authenticated webhook identity winner", async () => {
  const state = harness();
  const mutate = state.deps.mutateAsset;
  let mutations = 0;
  state.deps.mutateAsset = async (scope, update) => {
    mutations += 1;
    if (mutations === 1) return mutate(scope, update);
    const adopted = snapshot({ status: "in_progress" });
    adopted.generation.submission.state = "submitted";
    adopted.generation.submission.providerRequestId = "provider-from-webhook";
    adopted.generation.submission.providerRequestLocator =
      "provider-from-webhook";
    state.replaceAsset(adopted);
    return false;
  };
  state.deps.submitProvider = async () => {
    throw new Error("connection reset after provider acceptance");
  };

  const result = await videoGenerationSubmitActivity(input, state.deps);

  assert.equal(result.status, "in_progress");
  assert.equal(result.submissionState, "submitted");
  assert.equal(result.providerRequestId, "provider-from-webhook");
});

test("a definitive provider rejection becomes not_attempted after the claim", async () => {
  const state = harness();
  state.deps.submitProvider = async () => {
    throw new VideoProviderError({
      code: "provider_rejected",
      message: "Request was rejected",
      phase: "submit",
      retryable: false,
      certainty: "not_attempted",
    });
  };

  const result = await videoGenerationSubmitActivity(input, state.deps);
  assert.equal(result.submissionState, "not_attempted");
  assert.equal(result.status, "failed");
  assert.equal(
    (
      state.mutations.at(-1)?.update as {
        failure: { submissionUncertain: boolean };
      }
    ).failure.submissionUncertain,
    false,
  );
});

test("an immediate provider NSFW response persists and returns top-level nsfw", async () => {
  const state = harness();
  state.deps.submitProvider = async () => ({
    providerRequestId: "provider-1",
    providerRequestLocator: "provider-1",
    status: "nsfw",
  });

  const result = await videoGenerationSubmitActivity(input, state.deps);

  assert.equal(result.status, "nsfw");
  assert.equal(result.providerStatus, "nsfw");
  assert.equal(result.terminal, true);
  assert.equal(state.asset.status, "nsfw");
  assert.equal(state.asset.generation.submission.state, "submitted");
});

test("submitted and terminal assets short-circuit without submission", async () => {
  const resumed = snapshot();
  resumed.generation.submission.state = "submitted";
  resumed.generation.submission.providerRequestId = "provider-1";
  resumed.generation.submission.providerRequestLocator = "opaque-locator-1";
  const submitted = harness(resumed);
  const resumedResult = await videoGenerationSubmitActivity(
    input,
    submitted.deps,
  );
  assert.equal(resumedResult.providerRequestId, "provider-1");
  assert.equal(resumedResult.providerRequestLocator, "opaque-locator-1");
  assert.equal(submitted.posts, 0);

  const terminal = snapshot({ status: "complete" });
  const completed = harness(terminal);
  assert.equal(
    (await videoGenerationSubmitActivity(input, completed.deps)).terminal,
    true,
  );
  assert.equal(completed.posts, 0);
});

test("poll persists only a sanitized diagnostic and scopes by request", async () => {
  const current = snapshot();
  current.generation.submission.state = "submitted";
  current.generation.submission.providerRequestId = "provider-1";
  current.generation.submission.providerRequestLocator = "provider-1";
  const state = harness(current);
  const result = await videoGenerationPollActivity(
    {
      ...input,
      providerRequestId: "provider-1",
      providerRequestLocator: "provider-1",
    },
    state.deps,
  );

  assert.equal(result.status, "in_progress");
  const mutation = state.mutations[0] as {
    scope: { providerRequestId: string };
    update: { providerPayload: unknown };
  };
  assert.equal(mutation.scope.providerRequestId, "provider-1");
  assert.doesNotMatch(
    JSON.stringify(mutation.update.providerPayload),
    /secret/,
  );
});

test("provider completion remains distinct until result materialization", async () => {
  const current = snapshot();
  current.generation.submission.state = "submitted";
  current.generation.submission.providerRequestId = "provider-1";
  current.generation.submission.providerRequestLocator = "opaque-locator-1";
  const state = harness(current);
  state.deps.pollProvider = async () => ({
    providerRequestId: "provider-1",
    status: "completed",
  });

  const result = await videoGenerationPollActivity(
    {
      ...input,
      providerRequestId: "provider-1",
      providerRequestLocator: "opaque-locator-1",
    },
    state.deps,
  );
  assert.equal(result.status, "in_progress");
  assert.equal(result.providerStatus, "completed");
  assert.equal(result.terminal, false);
});

test("poll recovers the safest exact durable webhook status before a provider GET", async () => {
  const current = snapshot();
  current.generation.webhookSignalKeys = [
    "provider-10:nsfw",
    "provider-1:failed",
    "provider-1:completed",
  ];
  current.generation.submission.state = "submitted";
  current.generation.submission.providerRequestId = "provider-1";
  current.generation.submission.providerRequestLocator = "locator-1";
  const state = harness(current);
  let polls = 0;
  state.deps.pollProvider = async () => {
    polls += 1;
    return { providerRequestId: "provider-1", status: "queued" };
  };

  const result = await videoGenerationPollActivity(
    {
      ...input,
      providerRequestId: "provider-1",
      providerRequestLocator: "locator-1",
    },
    state.deps,
  );

  assert.equal(result.providerStatus, "completed");
  assert.equal(result.terminal, false);
  assert.equal(polls, 0);
});

test("webhook-only poll returns nonterminal state without a durable key or provider GET", async () => {
  const current = snapshot();
  current.generation.webhookSignalKeys = ["provider-10:completed"];
  current.generation.submission.state = "submitted";
  current.generation.submission.providerRequestId = "provider-1";
  current.generation.submission.providerRequestLocator = "locator-1";
  const state = harness(current);
  let polls = 0;
  state.deps.pollProvider = async () => {
    polls += 1;
    return { providerRequestId: "provider-1", status: "completed" };
  };

  const result = await videoGenerationPollActivity(
    {
      ...input,
      providerRequestId: "provider-1",
      providerRequestLocator: "locator-1",
      webhookOnly: true,
    },
    state.deps,
  );

  assert.equal(result.providerStatus, null);
  assert.equal(result.status, "queued");
  assert.equal(result.terminal, false);
  assert.equal(polls, 0);
});

test("provider failure, cancellation, and NSFW use the compatibility terminal statuses", async () => {
  for (const [providerStatus, expected] of [
    ["failed", "failed"],
    ["cancelled", "failed"],
    ["nsfw", "nsfw"],
  ] as const) {
    const current = snapshot();
    current.generation.submission.state = "submitted";
    current.generation.submission.providerRequestId = "provider-1";
    current.generation.submission.providerRequestLocator = "opaque-locator-1";
    const state = harness(current);
    state.deps.pollProvider = async () => ({
      providerRequestId: "provider-1",
      status: providerStatus,
    });

    const result = await videoGenerationPollActivity(
      {
        ...input,
        providerRequestId: "provider-1",
        providerRequestLocator: "opaque-locator-1",
      },
      state.deps,
    );
    assert.equal(result.status, expected);
    assert.equal(result.terminal, true);
    assert.equal(result.providerStatus, providerStatus);
  }
});

test("failure mutation requires current workspace, token, request, and nonterminal status", async () => {
  const current = snapshot();
  current.generation.submission.state = "submitted";
  current.generation.submission.providerRequestId = "provider-1";
  const state = harness(current);
  await videoGenerationFailActivity(
    {
      ...input,
      providerRequestId: "provider-1",
      phase: "poll",
      code: "provider_timeout",
      message: "Timed out",
      retryable: true,
    },
    state.deps,
  );

  const scope = state.mutations[0]?.scope as {
    workspaceId: string;
    assetId: string;
    attemptToken: string;
    providerRequestId: string;
    statuses: string[];
  };
  assert.equal(scope.workspaceId, input.workspaceId);
  assert.equal(scope.assetId, input.assetId);
  assert.equal(scope.attemptToken, input.attemptToken);
  assert.equal(scope.providerRequestId, "provider-1");
  assert.deepEqual(scope.statuses, ["queued", "in_progress"]);
});

test("submit failure after a dispatch claim preserves duplicate-charge uncertainty", async () => {
  const current = snapshot();
  current.generation.submission.state = "dispatching";
  const state = harness(current);

  const result = await videoGenerationFailActivity(
    {
      ...input,
      providerRequestId: null,
      phase: "submit",
      code: "submit_activity_failed",
      message: "Submission could not be completed",
      retryable: true,
    },
    state.deps,
  );

  const mutation = state.mutations[0] as {
    scope: { submissionStates?: string[] };
    update: {
      submissionState?: string;
      failure: { submissionUncertain: boolean };
    };
  };
  assert.deepEqual(mutation.scope.submissionStates, ["dispatching", "unknown"]);
  assert.equal(mutation.update.submissionState, "unknown");
  assert.equal(mutation.update.failure.submissionUncertain, true);
  assert.equal(result.submissionState, "unknown");
});

test("failure activity persists and returns an explicit NSFW terminal status", async () => {
  const current = snapshot();
  current.generation.submission.state = "submitted";
  current.generation.submission.providerRequestId = "provider-1";
  const state = harness(current);

  const result = await videoGenerationFailActivity(
    {
      ...input,
      providerRequestId: "provider-1",
      phase: "poll",
      code: "provider_nsfw",
      message: "Provider rejected unsafe content",
      retryable: false,
      terminalStatus: "nsfw",
    },
    state.deps,
  );

  assert.equal(result.status, "nsfw");
  assert.equal(result.terminal, true);
  assert.equal(
    (state.mutations.at(-1)?.update as { status: string }).status,
    "nsfw",
  );
});

test("rejects workflow provider-source lineage drift before preparation", async () => {
  const current = snapshot({ providerSourceId: "source-stored" });
  const state = harness(current);
  let prepared = 0;
  state.deps.prepareSubmission = async () => {
    prepared += 1;
    throw new Error("must not prepare");
  };

  await assert.rejects(() =>
    videoGenerationSubmitActivity(
      { ...input, providerSourceId: "source-workflow" },
      state.deps,
    ),
  );
  assert.equal(prepared, 0);
  assert.equal(state.posts, 0);
});

test("poll rejects spec, request, and locator drift before a provider GET", async () => {
  const current = snapshot();
  current.generation.submission.state = "submitted";
  current.generation.submission.providerRequestId = "provider-stored";
  current.generation.submission.providerRequestLocator = "locator-stored";

  for (const changed of [
    {
      ...input,
      spec: { ...input.spec, modelId: "tampered-model" },
      providerRequestId: "provider-stored",
      providerRequestLocator: "locator-stored",
    },
    {
      ...input,
      providerRequestId: "provider-workflow",
      providerRequestLocator: "locator-stored",
    },
    {
      ...input,
      providerRequestId: "provider-stored",
      providerRequestLocator: "locator-workflow",
    },
  ]) {
    const state = harness(current);
    let polls = 0;
    state.deps.pollProvider = async () => {
      polls += 1;
      return { providerRequestId: "provider-stored", status: "queued" };
    };
    await assert.rejects(() =>
      videoGenerationPollActivity(changed, state.deps),
    );
    assert.equal(polls, 0);
  }
});

test("transient poll failures persist bounded diagnostics and escape for Temporal retry", async () => {
  const current = snapshot();
  current.generation.submission.state = "submitted";
  current.generation.submission.providerRequestId = "provider-1";
  current.generation.submission.providerRequestLocator = "locator-1";
  const state = harness(current);
  const transient = new VideoProviderError({
    code: "provider_poll_unavailable",
    message: "Provider temporarily unavailable",
    phase: "poll",
    retryable: true,
    certainty: "not_attempted",
    diagnostic: {
      authorization: "Bearer secret",
      url: "https://provider.example/status?signature=secret",
      body: "x".repeat(100_000),
    },
  });
  state.deps.pollProvider = async () => {
    throw transient;
  };

  await assert.rejects(
    () =>
      videoGenerationPollActivity(
        {
          ...input,
          providerRequestId: "provider-1",
          providerRequestLocator: "locator-1",
        },
        state.deps,
      ),
    transient,
  );
  assert.equal(state.asset.status, "queued");
  const diagnostic = state.mutations.at(-1)?.update as {
    providerPayload: unknown;
  };
  const json = JSON.stringify(diagnostic.providerPayload);
  assert.doesNotMatch(json, /secret|signature/);
  assert.ok(Buffer.byteLength(json, "utf8") <= 32 * 1024);
});

test("permanent poll protocol errors terminalize after persisting diagnostics", async () => {
  const current = snapshot();
  current.generation.submission.state = "submitted";
  current.generation.submission.providerRequestId = "provider-1";
  current.generation.submission.providerRequestLocator = "locator-1";
  const state = harness(current);
  state.deps.pollProvider = async () => {
    throw new VideoProviderError({
      code: "provider_protocol_error",
      message: "Unknown state",
      phase: "poll",
      retryable: false,
      certainty: "not_attempted",
      diagnostic: { token: "secret", status: "ALIEN" },
    });
  };

  const result = await videoGenerationPollActivity(
    {
      ...input,
      providerRequestId: "provider-1",
      providerRequestLocator: "locator-1",
    },
    state.deps,
  );
  assert.equal(result.status, "failed");
  assert.doesNotMatch(JSON.stringify(state.mutations[0]?.update), /secret/);
});

test("a provider request mismatch terminalizes after one poll", async () => {
  const current = snapshot();
  current.generation.submission.state = "submitted";
  current.generation.submission.providerRequestId = "provider-1";
  current.generation.submission.providerRequestLocator = "locator-1";
  const state = harness(current);
  let polls = 0;
  state.deps.pollProvider = async (_pollInput, persistDiagnostic) => {
    polls += 1;
    await persistDiagnostic({ request_id: "provider-other", status: "queued" });
    return { providerRequestId: "provider-other", status: "queued" };
  };

  const result = await videoGenerationPollActivity(
    {
      ...input,
      providerRequestId: "provider-1",
      providerRequestLocator: "locator-1",
    },
    state.deps,
  );

  assert.equal(polls, 1);
  assert.equal(result.status, "failed");
  assert.equal(result.terminal, true);
  assert.equal(state.asset.status, "failed");
  assert.equal(
    (
      state.mutations.at(-1)?.update as {
        failure: { code: string; retryable: boolean };
      }
    ).failure.code,
    "provider_request_mismatch",
  );
});

test("poll errors persist typed HTTP metadata when no body is available", async () => {
  const current = snapshot();
  current.generation.submission.state = "submitted";
  current.generation.submission.providerRequestId = "provider-1";
  current.generation.submission.providerRequestLocator = "locator-1";
  const state = harness(current);
  const transient = new VideoProviderError({
    code: "provider_poll_failed",
    message: "Provider temporarily unavailable",
    providerCode: "503",
    phase: "poll",
    retryable: true,
    certainty: "not_attempted",
  });
  state.deps.pollProvider = async () => {
    throw transient;
  };

  await assert.rejects(
    () =>
      videoGenerationPollActivity(
        {
          ...input,
          providerRequestId: "provider-1",
          providerRequestLocator: "locator-1",
        },
        state.deps,
      ),
    transient,
  );

  const persisted = state.mutations.at(-1)?.update as {
    providerPayload: unknown;
  };
  assert.deepEqual(persisted.providerPayload, {
    code: "provider_poll_failed",
    providerCode: "503",
    retryable: true,
    diagnostic: null,
    message: "Provider temporarily unavailable",
  });
});

test("lost submit-success CAS fails closed instead of returning an unpersisted request", async () => {
  const state = harness();
  const mutate = state.deps.mutateAsset;
  let calls = 0;
  state.deps.mutateAsset = async (scope, update) => {
    calls += 1;
    if (calls === 2) return false;
    return mutate(scope, update);
  };

  await assert.rejects(() => videoGenerationSubmitActivity(input, state.deps));
  assert.equal(state.asset.generation.submission.state, "dispatching");
});

test("submit-success CAS accepts the same request identity after a webhook advances status", async () => {
  const state = harness();
  const mutate = state.deps.mutateAsset;
  let calls = 0;
  state.deps.mutateAsset = async (scope, update) => {
    calls += 1;
    if (calls === 1) return mutate(scope, update);
    const adopted = snapshot({ status: "in_progress" });
    adopted.generation.submission.state = "submitted";
    adopted.generation.submission.providerRequestId = "provider-1";
    adopted.generation.submission.providerRequestLocator = "provider-1";
    state.replaceAsset(adopted);
    return false;
  };

  const result = await videoGenerationSubmitActivity(input, state.deps);

  assert.equal(result.status, "in_progress");
  assert.equal(result.submissionState, "submitted");
  assert.equal(result.providerRequestId, "provider-1");
  assert.equal(result.providerRequestLocator, "provider-1");
});

test("lost dispatching, poll-state, and fail CAS mutations fail closed", async () => {
  const dispatching = snapshot();
  dispatching.generation.submission.state = "dispatching";
  const dispatchState = harness(dispatching);
  dispatchState.deps.mutateAsset = async () => false;
  await assert.rejects(() =>
    videoGenerationSubmitActivity(input, dispatchState.deps),
  );

  const submitted = snapshot();
  submitted.generation.submission.state = "submitted";
  submitted.generation.submission.providerRequestId = "provider-1";
  submitted.generation.submission.providerRequestLocator = "locator-1";
  const pollState = harness(submitted);
  let pollMutations = 0;
  const mutatePoll = pollState.deps.mutateAsset;
  pollState.deps.mutateAsset = async (scope, update) => {
    pollMutations += 1;
    if (pollMutations === 2) return false;
    return mutatePoll(scope, update);
  };
  await assert.rejects(() =>
    videoGenerationPollActivity(
      {
        ...input,
        providerRequestId: "provider-1",
        providerRequestLocator: "locator-1",
      },
      pollState.deps,
    ),
  );

  const failState = harness(submitted);
  failState.deps.mutateAsset = async () => false;
  await assert.rejects(() =>
    videoGenerationFailActivity(
      {
        ...input,
        providerRequestId: "provider-1",
        phase: "poll",
        code: "provider_timeout",
        message: "Timed out",
        retryable: true,
      },
      failState.deps,
    ),
  );
});

test("a lost fail CAS returns a persisted terminal winner", async () => {
  const submitted = snapshot();
  submitted.generation.submission.state = "submitted";
  submitted.generation.submission.providerRequestId = "provider-1";
  submitted.generation.submission.providerRequestLocator = "locator-1";
  const state = harness(submitted);
  state.deps.mutateAsset = async () => {
    state.replaceAsset({ ...submitted, status: "complete" });
    return false;
  };

  const result = await videoGenerationFailActivity(
    {
      ...input,
      providerRequestId: "provider-1",
      phase: "poll",
      code: "provider_timeout",
      message: "Timed out",
      retryable: true,
    },
    state.deps,
  );
  assert.equal(result.status, "complete");
});

test("activity sources contain no provider retries or raw workflow return fields", async () => {
  const files = await Promise.all(
    [
      "submit.ts",
      "poll.ts",
      "failure.ts",
      "providers/happyhorse.ts",
      "providers/higgsfield.ts",
      "providers/google.ts",
    ].map((path) =>
      readFile(
        new URL(`./activities/video-generation/${path}`, import.meta.url),
        "utf8",
      ),
    ),
  );
  const source = files.join("\n");
  assert.doesNotMatch(source, /retry\s*\(|maxRetries|backoff/i);
  assert.doesNotMatch(
    source,
    /return\s+(result|operation)\.(raw|response)|providerPayload:\s*(result|operation)\.(raw|response)/i,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyHappyHorseSubmitFailure,
  loadFinalHappyHorseVideoResult,
  normalizeHappyHorsePollResult,
  normalizeVideoProviderRequestLocator,
  normalizeHappyHorseSubmitResult,
  submitHappyHorseVideoProvider,
  videoProviderResultUnavailable,
  VideoProviderError,
} from "./happyhorse.js";
import {
  classifyHiggsfieldSubmitFailure,
  loadFinalHiggsfieldVideoResult,
  normalizeHiggsfieldPollResult,
  normalizeHiggsfieldSubmitResult,
  submitHiggsfieldVideoProvider,
} from "./higgsfield.js";
import {
  classifyGoogleSubmitFailure,
  normalizeGooglePollResult,
  normalizeGoogleSubmitResult,
  loadFinalGoogleVideoResult,
  prepareGoogleSourceImage,
  submitGoogleVideoProvider,
} from "./google.js";
function assertProtocolFailure(run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof VideoProviderError);
    assert.equal(error.code, "provider_protocol_error");
    assert.equal(error.phase, "poll");
    return true;
  });
}

function assertSubmitProtocolFailure(run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof VideoProviderError);
    assert.equal(error.code, "provider_protocol_error");
    assert.equal(error.phase, "submit");
    assert.equal(error.certainty, "unknown");
    assert.equal(error.retryable, true);
    return true;
  });
}

test("unknown provider statuses are typed protocol errors", () => {
  assertProtocolFailure(() =>
    normalizeHappyHorsePollResult({
      taskId: "hh-1",
      taskStatus: "ALIEN",
      raw: {},
    }),
  );
  assertProtocolFailure(() =>
    normalizeHiggsfieldPollResult(
      { request_id: "hf-1", status: "ALIEN" },
      "hf-1",
    ),
  );
  assertProtocolFailure(() =>
    normalizeGooglePollResult({ name: "operations/g-1", done: true, raw: {} }),
  );
});

test("malformed successful submission responses preserve unknown certainty", () => {
  assertSubmitProtocolFailure(() =>
    normalizeHiggsfieldSubmitResult({ requestId: "hf-1", status: "ALIEN" }),
  );
  assertSubmitProtocolFailure(() =>
    normalizeGoogleSubmitResult({ name: "operations/g-1", done: true }),
  );
});

test("accepted terminal submissions retain provider identity", () => {
  assert.deepEqual(
    normalizeHappyHorseSubmitResult({
      taskId: "hh-failed-1",
      taskStatus: "FAILED",
    }),
    {
      providerRequestId: "hh-failed-1",
      providerRequestLocator: "hh-failed-1",
      status: "failed",
    },
  );
  assert.deepEqual(
    normalizeHappyHorseSubmitResult({
      taskId: "hh-cancelled-1",
      taskStatus: "CANCELLED",
    }),
    {
      providerRequestId: "hh-cancelled-1",
      providerRequestLocator: "hh-cancelled-1",
      status: "cancelled",
    },
  );
  assert.deepEqual(
    normalizeGoogleSubmitResult({
      name: "operations/google-failed-1",
      done: true,
      error: { code: 13, message: "generation failed" },
    }),
    {
      providerRequestId: "operations/google-failed-1",
      providerRequestLocator: "operations/google-failed-1",
      status: "failed",
    },
  );
});

test("opaque provider locators reject URI schemes, controls, and overlength values", () => {
  for (const value of [
    "https:provider.example/jobs/1",
    "data:text/plain,provider-payload",
    "javascript:alert(1)",
    "provider\u0000request",
    "provider-request\n",
    "provider\u0085request",
    "x".repeat(501),
    `${"x".repeat(500)} `,
  ]) {
    assert.throws(
      () => normalizeVideoProviderRequestLocator(value),
      (error: unknown) =>
        error instanceof VideoProviderError &&
        error.code === "provider_protocol_error",
    );
    assert.throws(
      () =>
        normalizeHiggsfieldSubmitResult({ requestId: value, status: "queued" }),
      (error: unknown) =>
        error instanceof VideoProviderError &&
        error.code === "provider_protocol_error",
    );
    assert.throws(
      () => normalizeGoogleSubmitResult({ name: value, done: false }),
      (error: unknown) =>
        error instanceof VideoProviderError &&
        error.code === "provider_protocol_error",
    );
  }
});

test("post-write 5xx and transport failures are submission-unknown", () => {
  for (const failure of [
    classifyHappyHorseSubmitFailure({
      statusCode: 503,
      message: "upstream failed",
      retryable: true,
    }),
    classifyHiggsfieldSubmitFailure({
      statusCode: 503,
      message: "upstream failed",
      retryable: true,
    }),
    classifyGoogleSubmitFailure(
      new Error("Google video generation failed to start: HTTP 503"),
    ),
    classifyGoogleSubmitFailure(new TypeError("fetch failed")),
  ]) {
    assert.equal(failure.certainty, "unknown");
    assert.equal(failure.code, "provider_submission_uncertain");
  }
});

test("definitive 4xx provider responses are not_attempted", () => {
  for (const failure of [
    classifyHappyHorseSubmitFailure({
      statusCode: 400,
      message: "bad request",
      retryable: false,
    }),
    classifyHiggsfieldSubmitFailure({
      statusCode: 422,
      message: "bad request",
      retryable: false,
    }),
    classifyGoogleSubmitFailure(
      new Error("Google video generation failed to start: HTTP 400"),
    ),
  ]) {
    assert.equal(failure.certainty, "not_attempted");
    assert.equal(failure.code, "provider_rejected");
  }
});

test("submit and poll normalization never returns raw payloads, URLs, or bytes", () => {
  const values = [
    normalizeHappyHorseSubmitResult({
      taskId: "hh-1",
      taskStatus: "PENDING",
      raw: { secret: 1 },
    }),
    normalizeHappyHorsePollResult({
      taskId: "hh-1",
      taskStatus: "RUNNING",
      videoUrl: "https://signed.example/x?token=x",
      raw: { secret: 1 },
    }),
    normalizeHiggsfieldSubmitResult({
      requestId: "hf-1",
      status: "queued",
      statusUrl: "https://signed.example/x?token=x",
    }),
    normalizeHiggsfieldPollResult(
      {
        request_id: "hf-1",
        status: "in_progress",
        video: { url: "https://signed.example/x?token=x" },
      },
      "hf-1",
    ),
    normalizeGoogleSubmitResult({
      name: "operations/g-1",
      done: false,
      raw: { videoBytes: "secret" },
    }),
    normalizeGooglePollResult({
      name: "operations/g-1",
      done: false,
      raw: { videoBytes: "secret" },
    }),
  ];

  for (const value of values) {
    const json = JSON.stringify(value);
    assert.doesNotMatch(json, /raw|payload|https?:|videoBytes|secret/);
  }
});

test("Google source preparation validates MIME and size before base64 encoding", async () => {
  const prepared = await prepareGoogleSourceImage(
    "https://storage.example/source.png?signature=secret",
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png", "content-length": "3" },
      }),
  );
  assert.deepEqual(prepared, { data: "AQID", mimeType: "image/png" });

  await assert.rejects(
    () =>
      prepareGoogleSourceImage(
        "https://storage.example/source.txt",
        async () =>
          new Response("not an image", {
            headers: { "content-type": "text/plain" },
          }),
      ),
    (error: unknown) =>
      error instanceof VideoProviderError &&
      error.certainty === "not_attempted",
  );

  const chunk = new Uint8Array(10 * 1024 * 1024);
  let pulls = 0;
  const oversized = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(chunk);
      if (pulls === 3) controller.close();
    },
  });
  await assert.rejects(
    () =>
      prepareGoogleSourceImage(
        "https://storage.example/source.png",
        async () =>
          new Response(oversized, {
            headers: { "content-type": "image/png" },
          }),
      ),
    (error: unknown) =>
      error instanceof VideoProviderError &&
      error.code === "source_media_invalid",
  );
  assert.equal(pulls, 3);
});

test("Google source preparation cancels rejected response bodies", async () => {
  for (const response of [
    { status: 503, mimeType: "application/json", declaredSize: "10" },
    { status: 200, mimeType: "text/plain", declaredSize: "10" },
    {
      status: 200,
      mimeType: "image/png",
      declaredSize: String(21 * 1024 * 1024),
    },
  ]) {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled += 1;
      },
    });
    await assert.rejects(() =>
      prepareGoogleSourceImage(
        "https://storage.example/source.png",
        async () =>
          new Response(body, {
            status: response.status,
            headers: {
              "content-type": response.mimeType,
              "content-length": response.declaredSize,
            },
          }),
      ),
    );
    assert.equal(cancelled, 1);
  }
});

test("Google source preparation supports a stricter inline-image size limit", async () => {
  await assert.rejects(
    () =>
      prepareGoogleSourceImage(
        "https://storage.example/reference.png",
        async () =>
          new Response(new Uint8Array(6), {
            headers: { "content-type": "image/png" },
          }),
        { maxBytes: 5 },
      ),
    (error: unknown) =>
      error instanceof VideoProviderError &&
      error.code === "source_media_invalid",
  );
});

test("Google source preparation bounds stalled body reads with one deadline", async () => {
  let cancelled = 0;
  let requestSignal: AbortSignal | undefined;
  const stalled = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => undefined);
    },
    cancel() {
      cancelled += 1;
    },
  });

  await assert.rejects(
    () =>
      prepareGoogleSourceImage(
        "https://storage.example/source.png",
        async (_url, init) => {
          requestSignal = init?.signal ?? undefined;
          return new Response(stalled, {
            headers: { "content-type": "image/png" },
          });
        },
        { timeoutMs: 10 },
      ),
    (error: unknown) =>
      error instanceof VideoProviderError &&
      error.code === "source_download_failed" &&
      error.retryable,
  );
  assert.equal(requestSignal?.aborted, true);
  assert.equal(cancelled, 1);
});

test("post-claim submit functions contain only the prepared POST and normalization", () => {
  for (const submit of [
    submitHappyHorseVideoProvider,
    submitHiggsfieldVideoProvider,
    submitGoogleVideoProvider,
  ]) {
    const source = submit.toString();
    assert.doesNotMatch(
      source,
      /import\s*\(|buildHiggsfieldWebhookUrl|get[A-Z].*(Key|Host)|assertProviderPrompt/,
    );
  }
});

test("immediate provider NSFW remains a distinct accepted terminal status", () => {
  assert.deepEqual(
    normalizeHiggsfieldSubmitResult({ requestId: "hf-1", status: "nsfw" }),
    {
      providerRequestId: "hf-1",
      providerRequestLocator: "hf-1",
      status: "nsfw",
    },
  );
});

test("Google final result rejects provider-controlled media URLs outside the canonical allowlist", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  const originalAllowlist = process.env.GOOGLE_GENERATIVE_MEDIA_HOST_ALLOWLIST;
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.GOOGLE_GENERATIVE_MEDIA_HOST_ALLOWLIST;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        name: "operations/video-1",
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [
              { video: { uri: "https://attacker.example/video.mp4" } },
            ],
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    await assert.rejects(
      () =>
        loadFinalGoogleVideoResult({
          workspaceId: "workspace-1",
          providerSourceId: null,
          providerRequestLocator: "operations/video-1",
        }),
      /not allowed/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalAllowlist === undefined)
      delete process.env.GOOGLE_GENERATIVE_MEDIA_HOST_ALLOWLIST;
    else process.env.GOOGLE_GENERATIVE_MEDIA_HOST_ALLOWLIST = originalAllowlist;
  }
});

test("HappyHorse final result preserves provider usage metadata", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ALIBABA_API_KEY;
  const originalHost = process.env.ALIBABA_API_HOST;
  process.env.ALIBABA_API_KEY = "test-key";
  process.env.ALIBABA_API_HOST = "https://happyhorse.example";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        output: {
          task_id: "hh-1",
          task_status: "SUCCEEDED",
          video_url: "https://cdn.example/video.mp4",
        },
        usage: { credits: 4, model: "wan-video" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  try {
    await assert.deepEqual(
      await loadFinalHappyHorseVideoResult({
        providerRequestLocator: "hh-1",
      }),
      {
        url: "https://cdn.example/video.mp4",
        providerUsage: { credits: 4, model: "wan-video" },
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ALIBABA_API_KEY;
    else process.env.ALIBABA_API_KEY = originalKey;
    if (originalHost === undefined) delete process.env.ALIBABA_API_HOST;
    else process.env.ALIBABA_API_HOST = originalHost;
  }
});

test("completed signals tolerate bounded provider result propagation lag", async () => {
  const originalFetch = globalThis.fetch;
  const originalAlibabaKey = process.env.ALIBABA_API_KEY;
  const originalAlibabaHost = process.env.ALIBABA_API_HOST;
  const originalGoogleKey = process.env.GEMINI_API_KEY;
  process.env.ALIBABA_API_KEY = "test-key";
  process.env.ALIBABA_API_HOST = "https://happyhorse.example";
  process.env.GEMINI_API_KEY = "test-key";

  const assertNotReady = async (run: () => Promise<unknown>) => {
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof VideoProviderError);
      assert.equal(error.code, "provider_result_not_ready");
      assert.equal(error.phase, "poll");
      assert.equal(error.retryable, true);
      return true;
    });
  };

  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ request_id: "hf-1", status: "in_progress" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    await assertNotReady(() =>
      loadFinalHiggsfieldVideoResult({
        providerRequestId: "hf-1",
        authKey: "test-auth",
      }),
    );

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          output: { task_id: "hh-1", task_status: "RUNNING" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    await assertNotReady(() =>
      loadFinalHappyHorseVideoResult({ providerRequestLocator: "hh-1" }),
    );

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ name: "operations/g-1", done: true, response: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    await assertNotReady(() =>
      loadFinalGoogleVideoResult({
        workspaceId: "workspace-1",
        providerSourceId: null,
        providerRequestLocator: "operations/g-1",
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAlibabaKey === undefined) delete process.env.ALIBABA_API_KEY;
    else process.env.ALIBABA_API_KEY = originalAlibabaKey;
    if (originalAlibabaHost === undefined) delete process.env.ALIBABA_API_HOST;
    else process.env.ALIBABA_API_HOST = originalAlibabaHost;
    if (originalGoogleKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGoogleKey;
  }
});

test("authoritative final-fetch failures preserve fresh-attempt retry eligibility", () => {
  const failed = videoProviderResultUnavailable("failed");
  assert.equal(failed.code, "provider_failed");
  assert.equal(failed.providerCode, "failed");
  assert.equal(failed.retryable, true);

  const cancelled = videoProviderResultUnavailable("cancelled");
  assert.equal(cancelled.code, "provider_cancelled");
  assert.equal(cancelled.providerCode, "cancelled");
  assert.equal(cancelled.retryable, true);
});

test("authoritative final-fetch NSFW remains a distinct provider failure", () => {
  const failure = videoProviderResultUnavailable("nsfw");

  assert.equal(failure.code, "provider_nsfw");
  assert.equal(failure.providerCode, "nsfw");
  assert.equal(failure.phase, "poll");
  assert.equal(failure.retryable, false);
});

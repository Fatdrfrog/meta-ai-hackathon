import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  ElevenLabsSttError,
  submitElevenLabsAudioTranscriptionFromUrl,
  submitElevenLabsVideoTranscriptionFromUrl,
} from "./elevenlabs-stt";
import * as elevenLabsSttModule from "./elevenlabs-stt";

function configureSttTest(
  t: TestContext,
  options: { webhookId?: string; timeoutMs?: string } = {},
) {
  const originalEnv = process.env;
  process.env = {
    ...originalEnv,
    ELEVENLABS_API_KEY: "test-key",
    ELEVENLABS_STT_ENABLED: "true",
  };
  delete process.env.ELEVENLABS_STT_WEBHOOK_ID;
  if (options.webhookId)
    process.env.ELEVENLABS_STT_WEBHOOK_ID = options.webhookId;
  if (options.timeoutMs) process.env.ELEVENLABS_TIMEOUT_MS = options.timeoutMs;
  t.after(() => {
    process.env = originalEnv;
  });
  t.mock.method(console, "warn", () => undefined);
}

function delayedResponseBody(
  signal: AbortSignal | null | undefined,
  body: string,
) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const timer = setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      }, 60);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          controller.error(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    },
  });
}

test("classifies only transient provider failures for Temporal retry", () => {
  const classifier = (
    elevenLabsSttModule as typeof elevenLabsSttModule & {
      isElevenLabsSttTransientError?: (error: unknown) => boolean;
    }
  ).isElevenLabsSttTransientError;

  assert.equal(typeof classifier, "function");
  assert.equal(
    classifier?.(
      new ElevenLabsSttError({
        kind: "server",
        transient: true,
        status: 503,
        message: "temporary outage",
      }),
    ),
    true,
  );
  assert.equal(
    classifier?.(
      new ElevenLabsSttError({
        kind: "invalid_request",
        transient: false,
        status: 400,
        message: "invalid media",
      }),
    ),
    false,
  );
});

test("submits downloaded audio bytes with async webhook metadata and a typed filename", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env;
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];

  process.env = {
    ...originalEnv,
    ELEVENLABS_API_KEY: "test-key",
    ELEVENLABS_STT_ENABLED: "true",
    ELEVENLABS_STT_WEBHOOK_ID: "webhook-1",
  };
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ input, init });
    return Response.json({ request_id: "stt_req_1" });
  }) as typeof fetch;

  try {
    const result = await submitElevenLabsAudioTranscriptionFromUrl(
      "whatsapp-media://media-1",
      "audio/ogg; codecs=opus",
      {
        workflowId:
          "conversation-media-analysis:workspace-1:conversation-1:message-1:voice",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        mediaType: "voice",
      },
      { fileBuffer: Buffer.from("audio-bytes") },
    );

    assert.equal(result.requestId, "stt_req_1");
    assert.equal(result.deliveryMode, "webhook");
    assert.equal(result.transcriptText, null);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.input,
      "https://api.elevenlabs.io/v1/speech-to-text",
    );
    assert.equal(calls[0]?.init?.method, "POST");
    assert.deepEqual(calls[0]?.init?.headers, { "xi-api-key": "test-key" });

    const formData = calls[0]?.init?.body as FormData;
    const file = formData.get("file") as File;
    assert.equal(file.name, "audio-input.ogg");
    assert.equal(file.type, "audio/ogg");
    assert.equal(formData.get("webhook"), "true");
    assert.equal(formData.get("webhook_id"), "webhook-1");
    assert.equal(formData.get("source_url"), null);
    assert.deepEqual(JSON.parse(String(formData.get("webhook_metadata"))), {
      workflowId:
        "conversation-media-analysis:workspace-1:conversation-1:message-1:voice",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      mediaType: "voice",
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("uses inline transcription when no webhook id is configured", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env;
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];

  process.env = {
    ...originalEnv,
    ELEVENLABS_API_KEY: "test-key",
    ELEVENLABS_STT_ENABLED: "true",
  };
  delete process.env.ELEVENLABS_STT_WEBHOOK_ID;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ input, init });
    return Response.json({
      text: "Inline transcript",
      language_code: "en",
      words: [],
    });
  }) as typeof fetch;

  try {
    const result = await submitElevenLabsVideoTranscriptionFromUrl(
      "https://media.example.test/video.mp4",
      "video/mp4",
      {
        workflowId: "conversation-media-analysis:inline",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        mediaType: "video",
      },
    );

    assert.equal(calls.length, 1);
    assert.match(result.requestId, /^inline_[a-f0-9]{32}$/);
    assert.equal(result.deliveryMode, "inline");
    assert.equal(result.transcriptText, "Inline transcript");
    assert.equal(result.languageCode, "en");

    const formData = calls[0]?.init?.body as FormData;
    assert.equal(
      formData.get("source_url"),
      "https://media.example.test/video.mp4",
    );
    assert.equal(formData.get("webhook"), null);
    assert.equal(formData.get("webhook_id"), null);
    assert.equal(formData.get("webhook_metadata"), null);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("falls back to inline transcription when a configured webhook is rejected", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env;
  const originalWarn = console.warn;
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];

  process.env = {
    ...originalEnv,
    ELEVENLABS_API_KEY: "test-key",
    ELEVENLABS_STT_ENABLED: "true",
    ELEVENLABS_STT_WEBHOOK_ID: "stale-webhook",
  };
  console.warn = () => undefined;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ input, init });
    if (calls.length === 1) {
      return Response.json(
        {
          detail: [
            {
              loc: ["body", "webhook_id"],
              msg: "Webhook is not available",
            },
          ],
        },
        { status: 400 },
      );
    }
    return Response.json({
      transcription_id: "stt_inline_recovery",
      text: "Recovered transcript",
      language_code: "kk",
      words: [],
    });
  }) as typeof fetch;

  try {
    const result = await submitElevenLabsAudioTranscriptionFromUrl(
      "https://media.example.test/audio.ogg",
      "audio/ogg",
      {
        workflowId: "conversation-media-analysis:recovery",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        mediaType: "voice",
      },
    );

    assert.equal(calls.length, 2);
    assert.equal(result.deliveryMode, "inline");
    assert.equal(result.transcriptText, "Recovered transcript");

    const webhookFormData = calls[0]?.init?.body as FormData;
    const inlineFormData = calls[1]?.init?.body as FormData;
    assert.equal(webhookFormData.get("webhook"), "true");
    assert.equal(webhookFormData.get("webhook_id"), "stale-webhook");
    assert.equal(inlineFormData.get("webhook"), null);
    assert.equal(inlineFormData.get("webhook_id"), null);
  } finally {
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

for (const inputMode of ["source_url", "file_upload"] as const) {
  test(`normalizes ${inputMode} submission transport failures for Temporal retry`, async (t) => {
    configureSttTest(t);
    t.mock.method(globalThis, "fetch", async () => {
      throw new TypeError("connection reset");
    });

    await assert.rejects(
      submitElevenLabsAudioTranscriptionFromUrl(
        "https://media.example.test/audio.ogg",
        "audio/ogg",
        {
          workflowId: "conversation-media-analysis:transport-error",
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          messageId: "message-1",
          mediaType: "voice",
        },
        inputMode === "file_upload" ? { fileBuffer: Buffer.from("audio") } : {},
      ),
      (error: unknown) => {
        assert.ok(error instanceof ElevenLabsSttError);
        assert.equal(error.info.kind, "unknown");
        assert.equal(error.info.transient, true);
        assert.equal(error.message, "connection reset");
        return true;
      },
    );
  });
}

test("times out when transcription response headers arrive but the JSON body stalls", async (t) => {
  configureSttTest(t, { timeoutMs: "10" });
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = delayedResponseBody(init?.signal, '{"text":"Too late"}');
      return new Response(body, {
        headers: { "content-type": "application/json" },
      });
    },
  );

  await assert.rejects(
    submitElevenLabsAudioTranscriptionFromUrl(
      "https://media.example.test/audio.ogg",
      "audio/ogg",
      {
        workflowId: "conversation-media-analysis:slow-response",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        mediaType: "voice",
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ElevenLabsSttError);
      assert.equal(error.info.kind, "timeout");
      assert.equal(error.info.transient, true);
      return true;
    },
  );
});

test("times out when downloaded media headers arrive but the file body stalls", async (t) => {
  configureSttTest(t, { timeoutMs: "10" });
  let providerSubmissionStarted = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes("api.elevenlabs.io")) {
        providerSubmissionStarted = true;
        return Response.json({ text: "Too late" });
      }
      return new Response(delayedResponseBody(init?.signal, "audio"));
    },
  );

  await assert.rejects(
    submitElevenLabsAudioTranscriptionFromUrl(
      "http://media.example.test/audio.ogg",
      "audio/ogg",
      {
        workflowId: "conversation-media-analysis:slow-download",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        mediaType: "voice",
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ElevenLabsSttError);
      assert.equal(error.info.kind, "timeout");
      assert.equal(error.info.transient, true);
      return true;
    },
  );
  assert.equal(providerSubmissionStarted, false);
});

test("does not retry an invalid media request by disabling an unrelated webhook", async (t) => {
  configureSttTest(t, { webhookId: "valid-webhook" });
  let submissions = 0;
  t.mock.method(globalThis, "fetch", async () => {
    submissions += 1;
    return Response.json(
      { detail: "Audio file is corrupted" },
      { status: 400 },
    );
  });

  await assert.rejects(
    submitElevenLabsAudioTranscriptionFromUrl(
      "https://media.example.test/audio.ogg",
      "audio/ogg",
      {
        workflowId: "conversation-media-analysis:invalid-file",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        mediaType: "voice",
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ElevenLabsSttError);
      assert.equal(error.info.kind, "invalid_request");
      assert.equal(error.info.transient, false);
      return true;
    },
  );
  assert.equal(submissions, 1);
});

test("rejects an explicitly empty file without falling through to URL transcription", async (t) => {
  configureSttTest(t);
  let submissions = 0;
  t.mock.method(globalThis, "fetch", async () => {
    submissions += 1;
    return Response.json({ text: "Unexpected URL transcript" });
  });

  await assert.rejects(
    submitElevenLabsAudioTranscriptionFromUrl(
      "https://media.example.test/audio.ogg",
      "audio/ogg",
      {
        workflowId: "conversation-media-analysis:empty-file",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        mediaType: "voice",
      },
      { fileBuffer: Buffer.alloc(0) },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ElevenLabsSttError);
      assert.equal(error.info.kind, "invalid_request");
      assert.equal(error.info.transient, false);
      return true;
    },
  );
  assert.equal(submissions, 0);
});

test("pins the admitted model and does not make an unreserved webhook fallback request", async (t) => {
  configureSttTest(t, { webhookId: "stale-webhook" });
  process.env.ELEVENLABS_STT_MODEL = "different-model";
  const submittedModels: FormDataEntryValue[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: unknown, init?: RequestInit) => {
      submittedModels.push((init?.body as FormData).get("model_id")!);
      return Response.json(
        {
          detail: [
            { loc: ["body", "webhook_id"], msg: "Webhook is not available" },
          ],
        },
        { status: 400 },
      );
    },
  );

  await assert.rejects(
    submitElevenLabsAudioTranscriptionFromUrl(
      "https://media.example.test/audio.wav",
      "audio/wav",
      {
        workflowId: "bounded",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        mediaType: "voice",
      },
      {
        modelId: "scribe_v2",
        allowWebhookFallback: false,
        fileBuffer: Buffer.from("audio"),
      },
    ),
    ElevenLabsSttError,
  );
  assert.deepEqual(submittedModels, ["scribe_v2"]);
});

test("answers inline when asked to, even with a webhook configured", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env;
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];

  process.env = {
    ...originalEnv,
    ELEVENLABS_API_KEY: "test-key",
    ELEVENLABS_STT_ENABLED: "true",
    ELEVENLABS_STT_WEBHOOK_ID: "webhook-1",
  };
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ input, init });
    return Response.json({
      text: "Кукла Лол, бес мың теңге.",
      language_code: "kaz",
      words: [{ text: "Кукла", type: "word", start: 1.2 }],
    });
  }) as typeof fetch;

  try {
    const result = await submitElevenLabsAudioTranscriptionFromUrl(
      "https://storage.invalid/narration.mp3",
      "audio/mpeg",
      {
        workflowKind: "product_video_import",
        workflowId: "product-video-import:import-1",
        workspaceId: "workspace-1",
        importId: "import-1",
        mediaType: "audio",
      },
      {
        fileBuffer: Buffer.from("mp3 bytes"),
        filename: "narration.mp3",
        timestampsGranularity: "word",
        delivery: "inline",
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(result.deliveryMode, "inline");
    assert.equal(result.languageCode, "kaz");
    assert.deepEqual(
      (result.responsePayload?.words as unknown[] | undefined)?.length,
      1,
    );
    const formData = calls[0]?.init?.body as FormData;
    assert.equal(formData.get("webhook"), null);
    assert.equal(formData.get("webhook_id"), null);
    assert.equal(formData.get("webhook_metadata"), null);
    assert.equal(formData.get("timestamps_granularity"), "word");
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  createMetaResponse,
  editMetaImage,
  generateMetaImage,
  getMetaModels,
  isMetaModelApiConfigured,
  isMetaModelApiTransientError,
  META_MUSE_IMAGE_COST_USD,
  MetaModelApiError,
  metaResponseText,
  metaSamVideoCostUsd,
  streamMetaResponse,
  uploadMetaFile,
} from "./meta-model-api";

type FetchCall = { url: string; init: RequestInit };

function configure(t: TestContext, env: Record<string, string> = {}) {
  const originalEnv = process.env;
  process.env = { ...originalEnv, META_MODEL_API_KEY: "test-key", ...env };
  delete process.env.META_MODEL_API_TIMEOUT_MS;
  if (env.META_MODEL_API_TIMEOUT_MS) {
    process.env.META_MODEL_API_TIMEOUT_MS = env.META_MODEL_API_TIMEOUT_MS;
  }
  t.after(() => {
    process.env = originalEnv;
  });
}

function stubFetch(
  t: TestContext,
  respond: (call: FetchCall, index: number) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call, calls.length - 1);
  });
  return calls;
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("refuses to call without an API key", async (t) => {
  configure(t);
  delete process.env.META_MODEL_API_KEY;
  const calls = stubFetch(t, () => Response.json({}));

  assert.equal(isMetaModelApiConfigured(), false);
  await assert.rejects(
    createMetaResponse({ model: "muse-spark-1.3", input: "hi" }),
    (error: unknown) =>
      error instanceof MetaModelApiError &&
      error.info.kind === "config" &&
      !error.info.transient,
  );
  assert.equal(calls.length, 0);
});

test("posts a Responses call with the key and reads its text", async (t) => {
  configure(t);
  const calls = stubFetch(t, () =>
    Response.json({
      id: "resp_1",
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: "two " },
            { type: "output_text", text: "products" },
          ],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
  );

  const response = await createMetaResponse({
    model: "muse-spark-1.3",
    input: [{ role: "user", content: "list products" }],
  });

  assert.equal(calls[0]?.url, "https://api.meta.ai/v1/responses");
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer test-key");
  assert.equal(headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    model: "muse-spark-1.3",
    input: [{ role: "user", content: "list products" }],
  });
  assert.equal(metaResponseText(response), "two products");
  assert.equal(response.usage?.output_tokens, 20);
});

test("retries a 5xx HTML page, then succeeds", async (t) => {
  configure(t);
  const calls = stubFetch(t, (_call, index) =>
    index === 0
      ? new Response("<html>502 Bad Gateway</html>", { status: 502 })
      : Response.json({ id: "resp_2", status: "completed", output: [] }),
  );

  const response = await createMetaResponse({ model: "m", input: "x" });

  assert.equal(response.id, "resp_2");
  assert.equal(calls.length, 2);
});

test("does not retry a rejected request, and says why", async (t) => {
  configure(t);
  const calls = stubFetch(t, () =>
    Response.json(
      { error: { message: "unsupported_parameter: mask" } },
      { status: 400 },
    ),
  );

  await assert.rejects(
    createMetaResponse({ model: "m", input: "x" }),
    (error: unknown) =>
      error instanceof MetaModelApiError &&
      error.info.kind === "invalid_request" &&
      error.info.status === 400 &&
      error.message === "unsupported_parameter: mask" &&
      !isMetaModelApiTransientError(error),
  );
  assert.equal(calls.length, 1);
});

test("an auth failure is final; rate limits are transient after retries", async (t) => {
  configure(t);
  stubFetch(t, () => new Response("nope", { status: 401 }));
  await assert.rejects(
    createMetaResponse({ model: "m", input: "x" }),
    (error: unknown) =>
      error instanceof MetaModelApiError &&
      error.info.kind === "auth" &&
      !error.info.transient,
  );

  t.mock.restoreAll();
  const calls = stubFetch(t, () => new Response("slow down", { status: 429 }));
  await assert.rejects(
    createMetaResponse({ model: "m", input: "x" }),
    (error: unknown) =>
      isMetaModelApiTransientError(error) && error.info.kind === "rate_limit",
  );
  assert.equal(calls.length, 3);
});

test("stops a call that outlives its timeout", async (t) => {
  configure(t, { META_MODEL_API_TIMEOUT_MS: "20" });
  stubFetch(
    t,
    (call) =>
      new Promise<Response>((_resolve, reject) => {
        call.init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );

  await assert.rejects(
    createMetaResponse({ model: "m", input: "x" }),
    (error: unknown) =>
      isMetaModelApiTransientError(error) && error.info.kind === "timeout",
  );
});

test("streams server-sent events, across chunk boundaries, until [DONE]", async (t) => {
  configure(t);
  const calls = stubFetch(t, () =>
    sseResponse([
      'data: {"type":"response.output_text.delta","delta":"<0f>"}\r\n\r\ndata: {"ty',
      'pe":"response.output_text.done","text":"<0f>"}\n\n',
      "data: [DONE]\n\n",
      'data: {"type":"never.read"}\n\n',
    ]),
  );

  const events = [];
  for await (const event of streamMetaResponse({
    model: "sam-3.1",
    input: "x",
  })) {
    events.push(event.type);
  }

  assert.deepEqual(events, [
    "response.output_text.delta",
    "response.output_text.done",
  ]);
  assert.equal(JSON.parse(String(calls[0]?.init.body)).stream, true);
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.accept, "text/event-stream");
});

test("uploads a file for later calls to refer to", async (t) => {
  configure(t);
  const calls = stubFetch(t, () => Response.json({ id: "file_9" }));

  const file = await uploadMetaFile({
    data: new Uint8Array([1, 2, 3]),
    filename: "shelf.mp4",
    mimeType: "video/mp4",
  });

  assert.equal(file.id, "file_9");
  assert.equal(calls[0]?.url, "https://api.meta.ai/v1/files");
  const form = calls[0]?.init.body as FormData;
  assert.equal(form.get("purpose"), "user_data");
  const sent = form.get("file") as File;
  assert.equal(sent.name, "shelf.mp4");
  assert.equal(sent.type, "video/mp4");
  assert.equal(sent.size, 3);
});

test("edits images with Muse Image and returns the picture and its price", async (t) => {
  configure(t);
  const png = Buffer.from("fake png bytes");
  const calls = stubFetch(t, () =>
    Response.json({ data: [{ b64_json: png.toString("base64") }] }),
  );

  const result = await editMetaImage(
    {
      prompt: "remove the hand",
      images: [{ data: new Uint8Array([7, 8]), mimeType: "image/jpeg" }],
    },
    { size: "1024x1536" },
  );

  assert.equal(calls[0]?.url, "https://api.meta.ai/v1/images/edits");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    model: getMetaModels().museImage,
    prompt: "remove the hand",
    images: [{ image_url: "data:image/jpeg;base64,Bwg=" }],
    n: 1,
    output_format: "png",
    size: "1024x1536",
  });
  assert.deepEqual(result.image, png);
  assert.equal(result.costUsd, META_MUSE_IMAGE_COST_USD);
});

test("Muse Image takes 1 to 10 images, and an empty answer is an error", async (t) => {
  configure(t);
  const calls = stubFetch(t, () => Response.json({ data: [] }));

  await assert.rejects(
    editMetaImage({ prompt: "x", images: [] }),
    (error: unknown) =>
      error instanceof MetaModelApiError &&
      error.info.kind === "invalid_request",
  );
  assert.equal(calls.length, 0);

  await assert.rejects(
    generateMetaImage({ prompt: "an empty oak table" }),
    (error: unknown) => isMetaModelApiTransientError(error),
  );
  assert.equal(calls[0]?.url, "https://api.meta.ai/v1/images/generations");
});

test("models can be switched by env; SAM video bills at least 50 frames", (t) => {
  configure(t, { META_MUSE_IMAGE_MODEL: "muse-image-1.1" });

  assert.deepEqual(getMetaModels(), {
    museSpark: "muse-spark-1.3",
    museImage: "muse-image-1.1",
    sam: "sam-3.1",
  });
  assert.equal(metaSamVideoCostUsd(10), 50 * 0.0002);
  assert.equal(metaSamVideoCostUsd(94), 94 * 0.0002);
});

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  isMetaModelApiTransientError,
  META_SAM_IMAGE_COST_USD,
  MetaModelApiError,
} from "./meta-model-api";
import {
  bestMetaSamMask,
  decodeMaskToRaster,
  recordsOfKind,
  segmentMetaImage,
  segmentMetaVideo,
  type SegmentationRecord,
} from "./meta-sam";

// Frame 0 of a 320×334 clip, two objects, as SAM 3.1 writes it (from the
// @meta-sam/parser README).
const SAM_OUTPUT =
  "<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>" +
  "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>" +
  ",1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334|>" +
  "<|mask;x=0;y=0;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>\n";

function configure(t: TestContext) {
  const originalEnv = process.env;
  process.env = { ...originalEnv, META_MODEL_API_KEY: "test-key" };
  t.after(() => {
    process.env = originalEnv;
  });
}

function stubSamStream(t: TestContext, outputText: string) {
  const split = outputText.indexOf(",1<|box");
  const events = [
    {
      type: "response.output_text.delta",
      item_id: "m",
      output_index: 0,
      content_index: 0,
      delta: outputText.slice(0, split),
    },
    {
      type: "response.output_text.delta",
      item_id: "m",
      output_index: 0,
      content_index: 0,
      delta: outputText.slice(split),
    },
    {
      type: "response.output_text.done",
      item_id: "m",
      output_index: 0,
      content_index: 0,
      text: outputText,
    },
    { type: "response.completed" },
  ];
  const bodies: unknown[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const text = events
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("");
      return new Response(text, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  );
  return bodies;
}

test("segments a video by id and prices it per frame", async (t) => {
  configure(t);
  const bodies = stubSamStream(t, SAM_OUTPUT);

  const { result, costUsd } = await segmentMetaVideo({
    fileId: "file_1",
    prompt: "button",
    frameCount: 120,
  });

  assert.equal(result.outcome.status, "completed");
  const masks = recordsOfKind(result.records, "mask");
  assert.equal(masks.length, 2);
  assert.equal(decodeMaskToRaster(masks[0]!.mask).length, 27 * 60);
  assert.equal(costUsd, 120 * 0.0002);
  assert.deepEqual(bodies[0], {
    model: "sam-3.1",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "button" },
          { type: "input_video", file_id: "file_1" },
        ],
      },
    ],
    metadata: { include_confidence: "true" },
    stream: true,
  });
});

test("segments an image from a data URL", async (t) => {
  configure(t);
  // An image is written as frame <0f> too.
  const bodies = stubSamStream(t, SAM_OUTPUT);

  const { result, costUsd } = await segmentMetaImage({
    imageUrl: "data:image/jpeg;base64,AAAA",
    prompt: "pink toy phone",
  });

  assert.equal(recordsOfKind(result.records, "mask").length, 2);
  assert.equal(costUsd, META_SAM_IMAGE_COST_USD);
  const content = (bodies[0] as { input: [{ content: unknown[] }] }).input[0]
    .content;
  assert.deepEqual(content[1], {
    type: "input_image",
    image_url: "data:image/jpeg;base64,AAAA",
  });
});

test("the best mask is the most confident, then the largest", () => {
  const mask = (
    objectId: string,
    confidence: number | undefined,
    right: number,
  ) =>
    ({
      kind: "mask",
      objectId,
      confidence,
      bounds: { left: 0, top: 0, right, bottom: 10 },
      mask: { x: 0, y: 0, width: right, height: 10, data: "" },
    }) as unknown as SegmentationRecord;

  assert.equal(bestMetaSamMask([]), undefined);
  assert.equal(
    bestMetaSamMask([mask("a", 0.6, 50), mask("b", 0.9, 10)])?.objectId,
    "b",
  );
  assert.equal(
    bestMetaSamMask([mask("a", 0.9, 10), mask("b", 0.9, 30)])?.objectId,
    "b",
  );
});

test("SAM failures keep the client's error, so retries are decided right", async (t) => {
  configure(t);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { message: "bad key" } }, { status: 401 }),
  );

  await assert.rejects(
    segmentMetaImage({
      imageUrl: "data:image/jpeg;base64,AAAA",
      prompt: "cup",
    }),
    (error: unknown) =>
      error instanceof MetaModelApiError &&
      error.info.kind === "auth" &&
      !error.info.transient,
  );
});

test("a SAM stream that stops early is an error a retry may fix, not 'nothing found'", async (t) => {
  configure(t);
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "<0f>" })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  );

  await assert.rejects(
    segmentMetaVideo({ fileId: "file_1", prompt: "cup", frameCount: 60 }),
    (error: unknown) =>
      isMetaModelApiTransientError(error) &&
      error.info.code === "incomplete_eof",
  );
});

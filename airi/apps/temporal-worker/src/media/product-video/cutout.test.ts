import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import sharp from "sharp";

import { cutOutProduct } from "./cutout";
import type { RunProcess } from "./media";

// One frame of SAM 3.1 output for a 320×334 image, two objects, exactly as
// the API writes it (from the @meta-sam/parser README). Object 0 covers
// x 211-270, y 228-254.
const SAM_OUTPUT =
  "<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>" +
  "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>" +
  ",1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334|>" +
  "<|mask;x=0;y=0;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>\n";
// SAM scores each mask; the box carries its own score.
const mask0 = (confidence: number) =>
  "<|mask;x=0;y=0;c=" +
  confidence +
  ";data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>";
const TRACKED_OUTPUT = [0.5, 0.95, 0.7]
  .map(
    (confidence, frame) =>
      `<${frame}f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334;c=${confidence}|>` +
      `${mask0(confidence)}\n`,
  )
  .join("");
const WIDTH = 320;
const HEIGHT = 334;

const frame = (background = "#d8d2c8") =>
  sharp({
    create: {
      width: WIDTH,
      height: HEIGHT,
      channels: 3,
      background,
    },
  }).composite([
    {
      input: {
        create: { width: 60, height: 27, channels: 3, background: "#e0115f" },
      },
      left: 211,
      top: 228,
    },
  ]);

type Scenario = {
  sameProduct?: boolean;
  difference?: string | null;
  restoreStatus?: number;
  restoreMessage?: string;
  boxVisible?: boolean;
  samImageOutput?: string;
  /** Muse's same-product answers, in order; then `sameProduct`. */
  sameAnswers?: boolean[];
  /** Muse's answers to "does this crop show the product?", in order; then yes. */
  shows?: boolean[];
  /** The clip's first frame is from another scene, as after a cut. */
  cutAfterFirstFrame?: boolean;
};

async function setUp(t: TestContext, scenario: Scenario = {}) {
  const originalEnv = process.env;
  process.env = { ...originalEnv, META_MODEL_API_KEY: "test-key" };
  const workDir = await mkdtemp(join(tmpdir(), "product-cutout-"));
  t.after(async () => {
    process.env = originalEnv;
    await rm(workDir, { recursive: true, force: true });
  });

  const runProcess: RunProcess = async ({ args }) => {
    const out = args.at(-1)!;
    if (out.endsWith("frame-%04d.jpg")) {
      for (let i = 1; i <= 12; i++) {
        await frame(
          scenario.cutAfterFirstFrame && i === 1 ? "#203040" : undefined,
        )
          .jpeg()
          .toFile(out.replace("%04d", String(i).padStart(4, "0")));
      }
    } else {
      await writeFile(out, "clip");
    }
    return { stdout: "", stderr: "" };
  };

  const sse = (text: string) =>
    new Response(
      [
        {
          type: "response.output_text.delta",
          item_id: "m",
          output_index: 0,
          content_index: 0,
          delta: text,
        },
        {
          type: "response.output_text.done",
          item_id: "m",
          output_index: 0,
          content_index: 0,
          text,
        },
        { type: "response.completed" },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  const answer = (value: unknown) =>
    Response.json({
      id: "r",
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(value) }],
        },
      ],
      usage: { input_tokens: 1_000, output_tokens: 40 },
    });
  const restoredPng = await frame().png().toBuffer();

  const requests: string[] = [];
  const samImagePrompts: string[] = [];
  const shows = [...(scenario.shows ?? [])];
  const sameAnswers = [...(scenario.sameAnswers ?? [])];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/v1/files") {
      requests.push("upload");
      return Response.json({ id: "file_1" });
    }
    if (path === "/v1/files/file_1" && init.method === "DELETE") {
      requests.push("delete");
      return Response.json({ id: "file_1", deleted: true });
    }
    if (path === "/v1/images/edits") {
      requests.push("restore");
      if (scenario.restoreStatus)
        return Response.json(
          { error: { message: scenario.restoreMessage ?? "refused" } },
          { status: scenario.restoreStatus },
        );
      return Response.json({
        data: [{ b64_json: restoredPng.toString("base64") }],
      });
    }
    const body = JSON.parse(String(init.body));
    const content = body.input[0].content as Array<{
      type: string;
      text?: string;
    }>;
    if (body.stream) {
      const video = content.some((part) => part.type === "input_video");
      requests.push(video ? "sam video" : "sam image");
      if (!video)
        samImagePrompts.push(
          content.find((part) => part.type === "input_text")!.text!,
        );
      return sse(
        video ? TRACKED_OUTPUT : (scenario.samImageOutput ?? SAM_OUTPUT),
      );
    }
    const question = content.find((part) => part.type === "input_text")!.text!;
    if (question.includes("numbered frames")) {
      requests.push("pick frame");
      return answer({ best: 1 });
    }
    if (question.includes("bounding box")) {
      requests.push("box");
      return answer({
        visible: scenario.boxVisible ?? true,
        x_min: 650,
        y_min: 680,
        x_max: 850,
        y_max: 765,
      });
    }
    if (question.includes("main subject")) {
      requests.push("check crop");
      return answer({ shows: shows.shift() ?? true });
    }
    requests.push("same product");
    return answer({
      same: sameAnswers.shift() ?? scenario.sameProduct ?? true,
      difference: scenario.difference ?? null,
    });
  });

  const costs: string[] = [];
  const pulses = { count: 0 };
  const deps = {
    runProcess,
    onCost: (_usd: number, what: string) => costs.push(what),
    pulse: () => {
      pulses.count++;
    },
  };
  const request = {
    videoPath: join(workDir, "video.mp4"),
    window: { fromSeconds: 4, toSeconds: 5.2 },
    name: "LOL doll",
    samPhrase: "blonde doll in blue dress",
    workDir,
  };
  return { deps, request, requests, costs, pulses, samImagePrompts, workDir };
}

test("restores the product, cuts it out and keeps the filmed crop", async (t) => {
  const { deps, request, requests, costs, pulses, samImagePrompts } =
    await setUp(t);

  const cutout = await cutOutProduct(request, deps);

  assert.equal(cutout.method, "restored");
  assert.deepEqual(cutout.notes, []);
  // Frame 1 of the clip, SAM's surest view: 4 s + 1/10 s.
  assert.equal(cutout.frameTimeSeconds, 4.1);
  assert.equal(cutout.samConfidence, 0.95);
  assert.deepEqual(requests, [
    "pick frame",
    "box",
    "upload",
    "sam video",
    "delete",
    "check crop",
    "restore",
    "sam image",
    "sam image",
    "same product",
  ]);
  assert.deepEqual(costs, [
    "pick frame",
    "box product",
    "track product",
    "check crop",
    "restore photo",
    "cut out restored photo",
    "cut out restored photo",
    "same product check",
  ]);

  const png = sharp(cutout.cutoutPath!);
  const { channels, width, height } = await png.metadata();
  assert.equal(channels, 4);
  assert.ok(width! >= 60 && width! <= 68, `width ${width}`);
  assert.ok(height! >= 27 && height! <= 35, `height ${height}`);
  const original = await sharp(cutout.originalPath).metadata();
  assert.equal(original.format, "jpeg");
  assert.ok(original.width! > width!, "the original keeps room around it");
  // The restored product is asked for by its box and by its name, joined.
  const [byBox, byName] = samImagePrompts.slice(-2);
  assert.ok(
    byBox!.includes("<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334"),
    `box prompt: ${byBox}`,
  );
  assert.equal(byName, "blonde doll in blue dress");
  // Each of the eight Meta calls heartbeats while it runs.
  assert.ok(pulses.count >= 8, `${pulses.count} pulses`);
});

test("tracking stays in the shot Muse picked, never past a cut", async (t) => {
  // Muse picks frame 0; the cut after it leaves SAM's surer frames 1 and 2 in
  // another scene, where tracking follows the box onto something else.
  const { deps, request } = await setUp(t, { cutAfterFirstFrame: true });

  const cutout = await cutOutProduct(request, deps);

  assert.equal(cutout.method, "restored");
  assert.equal(cutout.frameTimeSeconds, 4);
  assert.equal(cutout.samConfidence, 0.5);
});

test("a tracked view of something else falls back to Muse's frame, found by its box", async (t) => {
  const { deps, request, requests, samImagePrompts } = await setUp(t, {
    shows: [false],
  });

  const cutout = await cutOutProduct(request, deps);

  assert.equal(cutout.method, "restored");
  assert.equal(cutout.frameTimeSeconds, 4);
  assert.deepEqual(requests.slice(0, 8), [
    "pick frame",
    "box",
    "upload",
    "sam video",
    "delete",
    "check crop",
    "sam image",
    "check crop",
  ]);
  // Muse's box, 650-850 × 680-765 of 1000, in the 320×334 frame.
  assert.ok(
    samImagePrompts[0]!.includes(
      "<|box;x1=208;y1=227;x2=271;y2=255;w=320;h=334",
    ),
    `box prompt: ${samImagePrompts[0]}`,
  );
});

test("shows the frame when no view of the product is confirmed", async (t) => {
  const { deps, request, requests } = await setUp(t, {
    shows: [false, false, false],
  });

  const cutout = await cutOutProduct(request, deps);

  assert.equal(cutout.method, "none");
  assert.equal(cutout.cutoutPath, null);
  assert.deepEqual(cutout.notes, [
    "No clear view of this product was found in the video, so the whole frame is shown.",
  ]);
  // Tracked, then by box, then by name: each checked, nothing restored.
  assert.equal(requests.filter((r) => r === "check crop").length, 3);
  assert.ok(!requests.includes("restore"));
});

test("restores once more when the first restored photo looks different", async (t) => {
  const { deps, request, requests } = await setUp(t, {
    sameAnswers: [false, true],
  });

  const cutout = await cutOutProduct(request, deps);

  assert.equal(cutout.method, "restored");
  assert.deepEqual(cutout.notes, []);
  assert.equal(requests.filter((r) => r === "restore").length, 2);
});

test("uses the filmed product when the restored photo looks different twice", async (t) => {
  const { deps, request, requests } = await setUp(t, {
    sameProduct: false,
    difference: "The doll's dress is red instead of blue.",
  });

  const cutout = await cutOutProduct(request, deps);

  assert.equal(requests.filter((r) => r === "restore").length, 2);
  assert.equal(cutout.method, "tracked");
  assert.deepEqual(cutout.notes, [
    "The cleaned-up photo looked different (The doll's dress is red instead of blue), so the original is used.",
  ]);
  assert.equal((await sharp(cutout.cutoutPath!).metadata()).channels, 4);
});

test("uses the filmed product when Muse Image refuses the photo", async (t) => {
  const { deps, request, requests } = await setUp(t, {
    restoreStatus: 400,
    restoreMessage: "The image was blocked by our safety system.",
  });

  const cutout = await cutOutProduct(request, deps);

  assert.equal(cutout.method, "tracked");
  assert.deepEqual(cutout.notes, [
    "The photo couldn't be cleaned up, so the hand may still show.",
  ]);
  assert.ok(!requests.includes("same product"));
});

test("throws a failure a retry could fix, rather than settling for the filmed photo", async (t) => {
  const { deps, request } = await setUp(t, { restoreStatus: 503 });

  await assert.rejects(cutOutProduct(request, deps), /refused/);
});

test("a rejected request that isn't a refusal fails loudly instead of downgrading the photo", async (t) => {
  const { deps, request } = await setUp(t, {
    restoreStatus: 400,
    restoreMessage: "Unsupported size 1024x1536",
  });

  await assert.rejects(cutOutProduct(request, deps), /Unsupported size/);
});

test("finds the product by name when Muse can't box it, and shows the frame when nothing is found", async (t) => {
  const found = await setUp(t, { boxVisible: false });
  const byName = await cutOutProduct(found.request, found.deps);
  assert.equal(byName.method, "restored");
  assert.ok(!found.requests.includes("sam video"));
  // Once by name on the frame, then box and name on the restored photo.
  assert.equal(found.requests.filter((r) => r === "sam image").length, 3);

  t.mock.restoreAll();
  const nothing = await setUp(t, {
    boxVisible: false,
    samImageOutput: "<0f>\n",
  });
  const none = await cutOutProduct(nothing.request, nothing.deps);
  assert.equal(none.method, "none");
  assert.equal(none.cutoutPath, null);
  assert.deepEqual(none.notes, [
    "No clear view of this product was found in the video, so the whole frame is shown.",
  ]);
  const original = await sharp(none.originalPath).metadata();
  assert.deepEqual([original.width, original.height], [WIDTH, HEIGHT]);
  assert.ok((await readdir(nothing.workDir)).includes("original.jpg"));
});

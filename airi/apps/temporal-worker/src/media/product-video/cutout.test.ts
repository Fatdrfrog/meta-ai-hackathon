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
const WIDTH = 320;
const HEIGHT = 334;

const frame = () =>
  sharp({
    create: {
      width: WIDTH,
      height: HEIGHT,
      channels: 3,
      background: "#d8d2c8",
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
  boxVisible?: boolean;
  samImageOutput?: string;
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
        await frame()
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
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/v1/files") {
      requests.push("upload");
      return Response.json({ id: "file_1" });
    }
    if (path === "/v1/images/edits") {
      requests.push("restore");
      if (scenario.restoreStatus)
        return Response.json(
          { error: { message: "refused" } },
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
      return sse(video ? SAM_OUTPUT : (scenario.samImageOutput ?? SAM_OUTPUT));
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
    requests.push("same product");
    return answer({
      same: scenario.sameProduct ?? true,
      difference: scenario.difference ?? null,
    });
  });

  const costs: string[] = [];
  const deps = {
    runProcess,
    onCost: (_usd: number, what: string) => costs.push(what),
  };
  const request = {
    videoPath: join(workDir, "video.mp4"),
    window: { fromSeconds: 4, toSeconds: 5.2 },
    name: "LOL doll",
    samPhrase: "blonde doll in blue dress",
    workDir,
  };
  return { deps, request, requests, costs, workDir };
}

test("restores the product, cuts it out and keeps the filmed crop", async (t) => {
  const { deps, request, requests, costs } = await setUp(t);

  const cutout = await cutOutProduct(request, deps);

  assert.equal(cutout.method, "restored");
  assert.deepEqual(cutout.notes, []);
  assert.equal(cutout.frameTimeSeconds, 4);
  assert.deepEqual(requests, [
    "pick frame",
    "box",
    "upload",
    "sam video",
    "restore",
    "sam image",
    "same product",
  ]);
  assert.deepEqual(costs, [
    "pick frame",
    "box product",
    "track product",
    "restore photo",
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
});

test("uses the filmed product when the restored photo looks different", async (t) => {
  const { deps, request } = await setUp(t, {
    sameProduct: false,
    difference: "The doll's dress is red instead of blue.",
  });

  const cutout = await cutOutProduct(request, deps);

  assert.equal(cutout.method, "tracked");
  assert.deepEqual(cutout.notes, [
    "The cleaned-up photo looked different (The doll's dress is red instead of blue), so the original is used.",
  ]);
  assert.equal((await sharp(cutout.cutoutPath!).metadata()).channels, 4);
});

test("uses the filmed product when Muse Image refuses the photo", async (t) => {
  const { deps, request, requests } = await setUp(t, { restoreStatus: 400 });

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

test("finds the product by name when Muse can't box it, and shows the frame when nothing is found", async (t) => {
  const found = await setUp(t, { boxVisible: false });
  const byName = await cutOutProduct(found.request, found.deps);
  assert.equal(byName.method, "restored");
  assert.ok(!found.requests.includes("sam video"));
  assert.equal(found.requests.filter((r) => r === "sam image").length, 2);

  t.mock.restoreAll();
  const nothing = await setUp(t, {
    boxVisible: false,
    samImageOutput: "<0f>\n",
  });
  const none = await cutOutProduct(nothing.request, nothing.deps);
  assert.equal(none.method, "none");
  assert.equal(none.cutoutPath, null);
  assert.deepEqual(none.notes, [
    "The product couldn't be found in the video, so the whole frame is shown.",
  ]);
  const original = await sharp(none.originalPath).metadata();
  assert.deepEqual([original.width, original.height], [WIDTH, HEIGHT]);
  assert.ok((await readdir(nothing.workDir)).includes("original.jpg"));
});

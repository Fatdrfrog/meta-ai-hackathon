import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import sharp from "sharp";

import type { RunProcess } from "./media";
import { cutOutPresenter } from "./presenter";

// One SAM 3.1 image result for a 320×334 frame: a single object covering
// x 211-270, y 228-254 (from the @meta-sam/parser README).
const SAM_OUTPUT =
  "<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>" +
  "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>\n";

async function setUp(
  t: TestContext,
  scenario: {
    samOutput?: string;
    /** Muse Spark's verdict on the cleaned-up person. */
    samePerson?: boolean;
    /** Muse Image refuses with this message. */
    refusal?: string;
  } = {},
) {
  const samOutput = scenario.samOutput ?? SAM_OUTPUT;
  // Muse Image's answer: the person on a plain white backdrop.
  const cleaned = await sharp({
    create: { width: 320, height: 334, channels: 3, background: "#ffffff" },
  })
    .composite([
      {
        input: {
          create: { width: 60, height: 27, channels: 3, background: "#7a3b2e" },
        },
        left: 211,
        top: 228,
      },
    ])
    .png()
    .toBuffer();
  const originalEnv = process.env;
  process.env = { ...originalEnv, META_MODEL_API_KEY: "test-key" };
  const workDir = await mkdtemp(join(tmpdir(), "presenter-"));
  t.after(async () => {
    process.env = originalEnv;
    await rm(workDir, { recursive: true, force: true });
  });

  const clips: string[][] = [];
  const runProcess: RunProcess = async ({ args }) => {
    const out = args.at(-1)!;
    if (out.endsWith("frame-%04d.jpg")) {
      for (let i = 1; i <= 20; i++) {
        await sharp({
          create: {
            width: 320,
            height: 334,
            channels: 3,
            background: "#cfc6b8",
          },
        })
          .jpeg()
          .toFile(out.replace("%04d", String(i).padStart(4, "0")));
      }
    } else {
      clips.push(args);
      await writeFile(out, "clip");
    }
    return { stdout: "", stderr: "" };
  };

  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (new URL(url).pathname === "/v1/images/edits") {
      requests.push("clean up");
      if (scenario.refusal)
        return Response.json(
          { error: { message: scenario.refusal } },
          { status: 400 },
        );
      return Response.json({
        data: [{ b64_json: cleaned.toString("base64") }],
      });
    }
    const body = JSON.parse(String(init.body));
    const content = body.input[0].content as Array<{
      type: string;
      text?: string;
    }>;
    const text = content.find((part) => part.type === "input_text")!.text!;
    if (body.stream) {
      requests.push(`sam ${text}`);
      const event = (data: object) => `data: ${JSON.stringify(data)}\n\n`;
      return new Response(
        event({
          type: "response.output_text.delta",
          item_id: "m",
          output_index: 0,
          content_index: 0,
          delta: samOutput,
        }) +
          event({
            type: "response.output_text.done",
            item_id: "m",
            output_index: 0,
            content_index: 0,
            text: samOutput,
          }) +
          event({ type: "response.completed" }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    const samePerson = text.includes("same person");
    requests.push(samePerson ? "same person" : "pick frame");
    const value = samePerson
      ? { same: scenario.samePerson ?? true }
      : { best: 3 };
    return Response.json({
      id: "r",
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(value) }],
        },
      ],
      usage: { input_tokens: 900, output_tokens: 20 },
    });
  });

  const costs: string[] = [];
  const deps = {
    runProcess,
    onCost: (_usd: number, what: string) => costs.push(what),
  };
  return { deps, workDir, requests, costs, clips };
}

test("cuts the presenter out of the clearest frame around their moment", async (t) => {
  const { deps, workDir, requests, costs, clips } = await setUp(t);

  const presenter = await cutOutPresenter(
    {
      videoPath: join(workDir, "video.mp4"),
      momentSeconds: 1,
      durationSeconds: 30,
      workDir,
    },
    deps,
  );

  assert.ok(presenter);
  // A 4-second window kept inside the video: 0-4 s, not -1-3 s.
  const clip = clips[0]!;
  assert.equal(clip[clip.indexOf("-ss") + 1], "0.000");
  assert.equal(clip[clip.indexOf("-t") + 1], "4.000");
  // Frame 3 of the grid is spread index 2 of 8 over 20 frames: frame 5, at 5 fps.
  assert.equal(presenter.frameTimeSeconds, 1);
  assert.equal(presenter.cleaned, true);
  // On the frame by the word "person", then on Muse Image's clean-up by its
  // box and by "person" again, joined.
  assert.deepEqual(requests.slice(0, 3), [
    "pick frame",
    "sam person",
    "clean up",
  ]);
  assert.equal(requests.filter((r) => r.startsWith("sam ")).length, 3);
  assert.equal(requests.at(-1), "same person");
  assert.deepEqual(costs, [
    "pick presenter frame",
    "find presenter",
    "clean up presenter",
    "cut out restored photo",
    "cut out restored photo",
    "same presenter check",
  ]);
  const cutout = await sharp(presenter.cutoutPath).metadata();
  assert.equal(cutout.channels, 4);
  assert.equal((await sharp(presenter.originalPath).metadata()).format, "jpeg");
});

test("finds no presenter when SAM sees no person", async (t) => {
  const { deps, workDir } = await setUp(t, { samOutput: "<0f>\n" });

  assert.equal(
    await cutOutPresenter(
      {
        videoPath: join(workDir, "video.mp4"),
        momentSeconds: 12,
        durationSeconds: 30,
        workDir,
      },
      deps,
    ),
    null,
  );
});

test("keeps the filmed cut-out when the clean-up changed the person or was refused", async (t) => {
  const request = (workDir: string) => ({
    videoPath: join(workDir, "video.mp4"),
    momentSeconds: 12,
    durationSeconds: 30,
    workDir,
  });

  const changed = await setUp(t, { samePerson: false });
  const kept = await cutOutPresenter(request(changed.workDir), changed.deps);
  assert.equal(kept?.cleaned, false);
  assert.equal((await sharp(kept!.cutoutPath).metadata()).channels, 4);

  t.mock.restoreAll();
  const refused = await setUp(t, {
    refusal: "The image was blocked by our safety system.",
  });
  const asFilmed = await cutOutPresenter(
    request(refused.workDir),
    refused.deps,
  );
  assert.equal(asFilmed?.cleaned, false);
  assert.ok(!refused.requests.includes("same person"));
});

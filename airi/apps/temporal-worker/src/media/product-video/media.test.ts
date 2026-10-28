import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  extractProductClip,
  extractReviewClip,
  MAX_PRODUCT_VIDEO_SECONDS,
  prepareProductVideo,
  ProductVideoError,
  type RunProcess,
} from "./media";

async function workDir(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "product-video-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function fakeProcesses(options: { duration?: number; audio?: boolean } = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runProcess: RunProcess = async ({ command, args }) => {
    calls.push({ command, args });
    if (command === "ffprobe") {
      return {
        stdout: JSON.stringify({
          streams: [{ codec_type: "video", width: 720, height: 1280 }],
          format: {
            duration: String(options.duration ?? 64.2),
            format_name: "mov,mp4",
          },
        }),
        stderr: "",
      };
    }
    if (args.includes("0:a:0") && options.audio === false) {
      throw new Error(
        "ffmpeg exited with code 1: Stream map '0:a:0' matches no streams.",
      );
    }
    return { stdout: "", stderr: "" };
  };
  return { calls, runProcess };
}

test("makes an upright silent MP4 for Meta and an MP3 of the narration", async (t) => {
  const dir = await workDir(t);
  const { calls, runProcess } = fakeProcesses();

  const prepared = await prepareProductVideo("C:/in/shelf.MOV", dir, {
    runProcess,
  });

  assert.deepEqual(prepared, {
    videoPath: join(dir, "video.mp4"),
    audioPath: join(dir, "narration.mp3"),
    durationSeconds: 64.2,
    width: 720,
    height: 1280,
  });
  const [video, probe, audio] = calls;
  assert.equal(video!.command, "ffmpeg");
  // Only local files, in the containers phones send.
  assert.deepEqual(video!.args.slice(3, 8), [
    "-nostdin",
    "-protocol_whitelist",
    "file",
    "-format_whitelist",
    "mov,matroska,webm",
  ]);
  assert.ok(video!.args.includes("-an"));
  assert.ok(video!.args.includes("yuv420p"));
  assert.equal(video!.args.at(-1), join(dir, "video.mp4"));
  assert.equal(probe!.command, "ffprobe");
  assert.ok(audio!.args.includes("libmp3lame"));
});

test("a silent video has no narration, and a long one is refused", async (t) => {
  const dir = await workDir(t);

  const silent = await prepareProductVideo("in.mp4", dir, {
    runProcess: fakeProcesses({ audio: false }).runProcess,
  });
  assert.equal(silent.audioPath, null);

  await assert.rejects(
    prepareProductVideo("in.mp4", dir, {
      runProcess: fakeProcesses({ duration: MAX_PRODUCT_VIDEO_SECONDS + 1 })
        .runProcess,
    }),
    (error: unknown) =>
      error instanceof ProductVideoError && error.code === "video_too_long",
  );
});

test("a video ffmpeg can't read is reported as such", async (t) => {
  const dir = await workDir(t);
  await assert.rejects(
    prepareProductVideo("in.mp4", dir, {
      runProcess: async () => {
        throw new Error("ffmpeg exited with code 1: Invalid data found");
      },
    }),
    (error: unknown) =>
      error instanceof ProductVideoError && error.code === "video_unreadable",
  );
});

test("a product's clip goes into its own folder, made on the way", async (t) => {
  const dir = await workDir(t);
  const { calls, runProcess } = fakeProcesses();
  const outPath = join(dir, "products", "03", "clip.mp4");

  await extractProductClip(
    join(dir, "video.mp4"),
    { fromSeconds: 17.25, toSeconds: 24 },
    10,
    outPath,
    { runProcess },
  );

  assert.ok((await stat(join(dir, "products", "03"))).isDirectory());
  const args = calls[0]!.args;
  assert.deepEqual(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 2), [
    "-ss",
    "17.250",
  ]);
  assert.deepEqual(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2), [
    "-t",
    "6.750",
  ]);
  assert.ok(args.includes("fps=10"));
  assert.equal(args.at(-1), outPath);
});

test("a long video stops being transcoded a second past the limit; a timeout isn't the video's fault", async (t) => {
  const dir = await workDir(t);
  const { calls, runProcess } = fakeProcesses();
  await prepareProductVideo("in.mp4", dir, { runProcess });
  const args = calls[0]!.args;
  assert.equal(
    args[args.indexOf("-t") + 1],
    String(MAX_PRODUCT_VIDEO_SECONDS + 1),
  );

  await assert.rejects(
    prepareProductVideo("in.mp4", dir, {
      runProcess: async () => {
        throw new Error("ffmpeg timed out after 300000ms");
      },
    }),
    (error: unknown) =>
      !(error instanceof ProductVideoError) && /timed out/.test(String(error)),
  );
});

test("a review clip is small, with the original file's sound when it has any", async (t) => {
  const dir = await workDir(t);
  const { calls, runProcess } = fakeProcesses();
  const outPath = join(dir, "clips", "p1.mp4");

  await extractReviewClip(
    { videoPath: "C:/w/video.mp4", soundPath: "C:/w/source" },
    { fromSeconds: 12.25, toSeconds: 16 },
    outPath,
    { runProcess },
  );
  await extractReviewClip(
    { videoPath: "C:/w/video.mp4", soundPath: null },
    { fromSeconds: 0, toSeconds: 4 },
    join(dir, "clips", "p2.mp4"),
    { runProcess },
  );

  assert.ok((await stat(join(dir, "clips"))).isDirectory());
  const [withSound, silent] = calls.map((call) => call.args.join(" "));
  assert.match(
    withSound!,
    /-ss 12\.250 -i C:\/w\/video\.mp4 -ss 12\.250 -i C:\/w\/source -t 3\.750 -map 0:v:0 -map 1:a:0 /,
  );
  assert.match(withSound!, /-c:a aac -b:a 64k -ac 1 /);
  assert.match(withSound!, /min\(360,iw\)/);
  assert.ok(withSound!.endsWith(outPath));
  assert.doesNotMatch(silent!, /source|1:a:0|aac/);
  assert.match(silent!, / -an /);
});

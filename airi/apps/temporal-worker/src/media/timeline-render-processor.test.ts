import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { CreativeAssetTimeline } from "@icecore/temporal";

import {
  buildTimelineFfmpegPlan,
  runTimelineRenderProcessor,
  TIMELINE_PROCESS_PULSE_INTERVAL_MS,
  type TimelineRenderSourceMetadata,
} from "./timeline-render-processor";

const execFileAsync = promisify(execFile);

async function commandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

const source: TimelineRenderSourceMetadata = {
  assetId: "asset-1",
  url: "https://storage.example.com/source.mp4",
  fileName: "source.mp4",
  duration: 20,
  width: 1080,
  height: 1920,
  fps: 30,
  hasAudio: true,
};

test("renders approved portrait canvas with still photos and literal captions", () => {
  const caption = "Coffee: 20% off %{metadata:secret}; [out]";
  const plan = buildTimelineFfmpegPlan({
    timeline: {
      canvas: "9:16",
      duration: 3,
      clips: [
        {
          id: "photo",
          assetId: source.assetId,
          trackId: "V1",
          timelineStart: 0,
          sourceStart: 0,
          duration: 3,
          caption,
        },
      ],
    },
    sources: [
      {
        ...source,
        kind: "image",
        width: 4032,
        height: 3024,
        duration: 0,
        hasAudio: false,
      },
    ],
    captionTextFiles: { photo: "C:/temp/caption-0.txt" },
    outputPath: "output.mp4",
  });
  assert.equal(plan.width, 720);
  assert.equal(plan.height, 1280);
  assert.equal(plan.fps, 30);
  assert.ok(plan.args.includes("-loop"));
  assert.match(plan.filterComplex, /force_original_aspect_ratio=decrease/);
  assert.match(plan.filterComplex, /drawtext=.*textfile=.*expansion=none/);
  assert.ok(!plan.filterComplex.includes(caption));
});

test("rejects unsupported canvases and unsafe or unbounded timeline clip data", () => {
  const timeline: CreativeAssetTimeline = {
    duration: 3,
    clips: [
      {
        id: "one",
        assetId: source.assetId,
        trackId: "V1",
        timelineStart: 0,
        sourceStart: 0,
        duration: 3,
      },
    ],
  };
  for (const invalid of [
    { ...timeline, canvas: "16:9" },
    {
      ...timeline,
      clips: [{ ...timeline.clips[0], caption: "x".repeat(121) }],
    },
    {
      ...timeline,
      clips: [{ ...timeline.clips[0], caption: "null\u0000byte" }],
    },
    { ...timeline, clips: [{ ...timeline.clips[0], timelineStart: -1 }] },
    { ...timeline, clips: [{ ...timeline.clips[0], duration: Number.NaN }] },
  ]) {
    assert.throws(
      () =>
        buildTimelineFfmpegPlan({
          timeline: invalid as CreativeAssetTimeline,
          sources: [source],
          outputPath: "output.mp4",
        }),
      /invalid/i,
    );
  }
  assert.throws(
    () =>
      buildTimelineFfmpegPlan({
        timeline: {
          ...timeline,
          clips: [{ ...timeline.clips[0], sourceStart: 1 }],
        },
        sources: [{ ...source, kind: "image" }],
        outputPath: "output.mp4",
      }),
    /image.*source start/i,
  );
});

test("keeps long-running probe and encode progress on a 30 second pulse", () => {
  assert.equal(TIMELINE_PROCESS_PULSE_INTERVAL_MS, 30_000);
});

test("resolves mixed-case Mongo clip ids to the same renderer input without changing the timeline", () => {
  const assetId = "abcdef123456abcdef123456";
  const timeline: CreativeAssetTimeline = {
    duration: 2,
    clips: [assetId.toUpperCase(), assetId].map((id, index) => ({
      id: `clip-${index}`,
      assetId: id,
      trackId: "V1",
      timelineStart: index,
      sourceStart: 0,
      duration: 1,
    })),
  };
  const snapshot = JSON.stringify(timeline);
  const plan = buildTimelineFfmpegPlan({
    timeline,
    sources: [{ ...source, assetId }],
    outputPath: "output.mp4",
  });
  assert.equal(plan.filterComplex.match(/\[0:v\]trim/g)?.length, 2);
  assert.equal(JSON.stringify(timeline), snapshot);
});

test("rejects duplicate physical sources before probing mixed-case Mongo ids", async () => {
  const assetId = "abcdef123456abcdef123456";
  await assert.rejects(
    runTimelineRenderProcessor({
      workspaceId: "workspace",
      outputAssetId: "output",
      timeline: {
        duration: 1,
        clips: [
          {
            id: "clip",
            assetId,
            trackId: "V1",
            timelineStart: 0,
            sourceStart: 0,
            duration: 1,
          },
        ],
      },
      sources: [assetId, assetId.toUpperCase()].map((id) => ({
        assetId: id,
        url: "must-not-probe",
      })),
    }),
    /sources must be unique by asset id/,
  );
});

test("shared worker validation preserves carriage returns and the probe boundary tolerance", () => {
  const timeline: CreativeAssetTimeline = {
    duration: 3,
    clips: [{
      id: "clip-1",
      assetId: source.assetId,
      trackId: "V1",
      timelineStart: 0,
      sourceStart: 0,
      duration: 3.049,
      caption: "First\r\nSecond",
    }],
  };
  const build = () => buildTimelineFfmpegPlan({
    timeline,
    sources: [{ ...source, duration: 3 }],
    outputPath: "output.mp4",
    captionTextFiles: { "clip-1": "caption-0.txt" },
  });
  assert.match(build().filterComplex, /trim=start=0:end=3\.049/);
  timeline.clips[0]!.duration = 3.0501;
  assert.throws(build, /Timeline clip clip-1 exceeds the render duration/);
});

test("builds a full-frame FFmpeg composition with source offsets and audio", () => {
  const plan = buildTimelineFfmpegPlan({
    timeline: {
      duration: 12,
      clips: [
        {
          id: "clip-1",
          assetId: "asset-1",
          trackId: "V2",
          timelineStart: 5,
          sourceStart: 2,
          duration: 4,
          effect: "chroma_key",
        },
      ],
    },
    sources: [source],
    outputPath: "output.mp4",
  });

  assert.equal(plan.width, 1080);
  assert.equal(plan.height, 1920);
  assert.equal(plan.fps, 30);
  assert.deepEqual(plan.args.slice(0, 6), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    source.url,
    "-filter_complex",
  ]);
  assert.match(plan.filterComplex, /trim=start=2:end=6/);
  assert.match(plan.filterComplex, /setpts=PTS-STARTPTS\+5\/TB/);
  assert.match(plan.filterComplex, /format=rgba,colorkey=0x00ff00:0\.24:0\.08/);
  assert.match(plan.filterComplex, /adelay=5000\|5000/);
  assert.match(plan.filterComplex, /overlay=.*between\(t,5,9\)/);
  assert.deepEqual(plan.args.slice(-3), [
    "-movflags",
    "+faststart",
    "output.mp4",
  ]);
  assert.ok(plan.args.includes("-fs"));
});

test("rejects source media above the decoder dimension budget", () => {
  assert.throws(
    () =>
      buildTimelineFfmpegPlan({
        timeline: {
          duration: 4,
          clips: [
            {
              id: "clip-1",
              assetId: "asset-1",
              trackId: "V1",
              timelineStart: 0,
              sourceStart: 0,
              duration: 4,
            },
          ],
        },
        sources: [{ ...source, width: 7680, height: 4320 }],
        outputPath: "output.mp4",
      }),
    /source dimensions exceed the processing limit/i,
  );
});

test("keeps expanded phone-photo decode bounds separate from video bounds", () => {
  const timeline = {
    canvas: "9:16" as const,
    duration: 1,
    clips: [
      {
        id: "photo",
        assetId: source.assetId,
        trackId: "V1" as const,
        timelineStart: 0,
        sourceStart: 0,
        duration: 1,
      },
    ],
  };
  for (const invalid of [
    { ...source, kind: "image" as const, width: 8194, height: 1000 },
    { ...source, kind: "image" as const, width: 6000, height: 4002 },
    { ...source, kind: "video" as const, width: 4032, height: 3024 },
  ])
    assert.throws(
      () =>
        buildTimelineFfmpegPlan({
          timeline,
          sources: [invalid],
          outputPath: "output.mp4",
        }),
      /source dimensions exceed/i,
    );
});

test("rejects timelines above the bounded frame-pixel work budget", () => {
  assert.throws(
    () =>
      buildTimelineFfmpegPlan({
        timeline: {
          duration: 7200,
          clips: [
            {
              id: "clip-1",
              assetId: "asset-1",
              trackId: "V1",
              timelineStart: 0,
              sourceStart: 0,
              duration: 7200,
            },
          ],
        },
        sources: [
          {
            ...source,
            duration: 7200,
            width: 1920,
            height: 1080,
            fps: 60,
          },
        ],
        outputPath: "output.mp4",
      }),
    /timeline render exceeds the processing work limit/i,
  );
});

test("rejects a clip that reads beyond its source duration", () => {
  assert.throws(
    () =>
      buildTimelineFfmpegPlan({
        timeline: {
          duration: 10,
          clips: [
            {
              id: "clip-1",
              assetId: "asset-1",
              trackId: "V1",
              timelineStart: 0,
              sourceStart: 18,
              duration: 4,
            },
          ],
        },
        sources: [source],
        outputPath: "output.mp4",
      }),
    /clip clip-1 exceeds source asset asset-1 duration/i,
  );
});

test("uses only the selected visual track as the audio program", () => {
  const plan = buildTimelineFfmpegPlan({
    timeline: {
      duration: 4,
      audioTrack: "V2",
      clips: [
        {
          id: "background",
          assetId: "asset-1",
          trackId: "V1",
          timelineStart: 0,
          sourceStart: 0,
          duration: 4,
        },
        {
          id: "foreground",
          assetId: "asset-2",
          trackId: "V2",
          timelineStart: 0,
          sourceStart: 0,
          duration: 4,
        },
      ],
    },
    sources: [
      { ...source, assetId: "asset-1" },
      { ...source, assetId: "asset-2" },
    ],
    outputPath: "output.mp4",
  });

  assert.doesNotMatch(plan.filterComplex, /\[0:a\]/);
  assert.match(plan.filterComplex, /\[1:a\]/);
  assert.match(
    plan.filterComplex,
    /amix=inputs=1:duration=longest:normalize=1/,
  );
});

test(
  "renders concatenated timeline clips at the source frame rate",
  {
    skip:
      !(await commandAvailable("ffmpeg")) ||
      !(await commandAvailable("ffprobe")),
  },
  async () => {
    const fixtureDir = await mkdtemp(
      path.join(tmpdir(), "airi-timeline-test-"),
    );
    const redPath = path.join(fixtureDir, "red.mp4");
    const bluePath = path.join(fixtureDir, "blue.mp4");
    let cleanupOutput: (() => Promise<void>) | null = null;

    try {
      await Promise.all(
        [
          [redPath, "red", "440"],
          [bluePath, "blue", "660"],
        ].map(([outputPath, color, frequency]) =>
          execFileAsync("ffmpeg", [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            `color=c=${color}:s=320x240:r=30:d=1`,
            "-f",
            "lavfi",
            "-i",
            `sine=frequency=${frequency}:sample_rate=48000:duration=1`,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            outputPath,
          ]),
        ),
      );

      const result = await runTimelineRenderProcessor({
        workspaceId: "workspace-1",
        outputAssetId: "output-1",
        timeline: {
          duration: 2,
          clips: [
            {
              id: "red",
              assetId: "red-asset",
              trackId: "V1",
              timelineStart: 0,
              sourceStart: 0,
              duration: 1,
            },
            {
              id: "blue",
              assetId: "blue-asset",
              trackId: "V1",
              timelineStart: 1,
              sourceStart: 0,
              duration: 1,
            },
          ],
        },
        sources: [
          { assetId: "red-asset", url: redPath, fileName: "red.mp4" },
          { assetId: "blue-asset", url: bluePath, fileName: "blue.mp4" },
        ],
      });
      cleanupOutput = result.cleanup;

      const { stdout } = await execFileAsync("ffprobe", [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        result.outputPath,
      ]);
      const metadata = JSON.parse(stdout) as {
        streams?: Array<{
          codec_type?: string;
          avg_frame_rate?: string;
          width?: number;
          height?: number;
        }>;
        format?: { duration?: string };
      };
      const video = metadata.streams?.find(
        (stream) => stream.codec_type === "video",
      );
      const audio = metadata.streams?.find(
        (stream) => stream.codec_type === "audio",
      );

      assert.equal(video?.avg_frame_rate, "30/1");
      assert.equal(video?.width, 320);
      assert.equal(video?.height, 240);
      assert.ok(audio);
      assert.ok(Math.abs(Number(metadata.format?.duration) - 2) < 0.15);
      assert.equal(result.providerPayload.fps, 30);
      assert.equal(result.providerPayload.clipCount, 2);
    } finally {
      await cleanupOutput?.();
      await rm(fixtureDir, { recursive: true, force: true });
    }
  },
);

test(
  "renders a photo followed by a video with visible literal captions at 9:16",
  {
    skip:
      !(await commandAvailable("ffmpeg")) ||
      !(await commandAvailable("ffprobe")),
  },
  async () => {
    const fixtureDir = await mkdtemp(
      path.join(tmpdir(), "airi-photo-timeline-test-"),
    );
    const photoPath = path.join(fixtureDir, "photo.png");
    const videoPath = path.join(fixtureDir, "clip.mp4");
    const imageServer = createServer(async (_request, response) => {
      response.setHeader("Content-Type", "image/png");
      response.end(await readFile(photoPath));
    });
    let cleanupOutput: (() => Promise<void>) | undefined;
    try {
      await execFileAsync("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=4032x3024",
        "-frames:v",
        "1",
        photoPath,
      ]);
      await execFileAsync("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=320x240:r=24:d=1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        videoPath,
      ]);
      await new Promise<void>((resolve) =>
        imageServer.listen(0, "127.0.0.1", resolve),
      );
      const address = imageServer.address();
      assert.ok(address && typeof address === "object");
      const result = await runTimelineRenderProcessor({
        workspaceId: "workspace",
        outputAssetId: "output",
        timeline: {
          canvas: "9:16",
          duration: 2,
          clips: [
            {
              id: "photo",
              assetId: "photo",
              trackId: "V1",
              sourceStart: 0,
              timelineStart: 0,
              duration: 1,
              caption: "Coffee: 20% off %{metadata:secret}; [out]",
            },
            {
              id: "video",
              assetId: "video",
              trackId: "V1",
              sourceStart: 0,
              timelineStart: 1,
              duration: 1,
              caption: `Fresh every morning.\r\n\nКофе для вас\n${"☕".repeat(27)}`,
            },
          ],
        },
        sources: [
          {
            assetId: "photo",
            kind: "image",
            url: `http://127.0.0.1:${address.port}/signed-photo?token=test`,
          },
          { assetId: "video", kind: "video", url: videoPath },
        ],
      });
      cleanupOutput = result.cleanup;
      const { stdout: probe } = await execFileAsync("ffprobe", [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        result.outputPath,
      ]);
      const metadata = JSON.parse(probe);
      const video = metadata.streams.find(
        (stream: { codec_type: string }) => stream.codec_type === "video",
      );
      assert.equal(video.width, 720);
      assert.equal(video.height, 1280);
      assert.equal(video.avg_frame_rate, "30/1");
      assert.ok(Math.abs(Number(metadata.format.duration) - 2) < 0.15);
      const { stdout: normalizedProbe } = await execFileAsync("ffprobe", [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        path.join(path.dirname(result.outputPath), "image-0.png"),
      ]);
      const normalizedImage = JSON.parse(normalizedProbe).streams[0];
      assert.equal(normalizedImage.width, 720);
      assert.equal(normalizedImage.height, 540);
      assert.equal(
        await readFile(
          path.join(path.dirname(result.outputPath), "caption-0.txt"),
          "utf8",
        ),
        "Coffee: 20% off\n%{metadata:secret}; [out]",
      );
      assert.equal(
        await readFile(
          path.join(path.dirname(result.outputPath), "caption-1.txt"),
          "utf8",
        ),
        `Fresh every morning.\n\nКофе для вас\n${"☕".repeat(26)}\n☕`,
        "Preserve explicit line breaks, including blank lines, while wrapping long words",
      );
      const readFrame = async (time: string) =>
        (
          await execFileAsync(
            "ffmpeg",
            [
              "-v",
              "error",
              "-ss",
              time,
              "-i",
              result.outputPath,
              "-frames:v",
              "1",
              "-f",
              "rawvideo",
              "-pix_fmt",
              "rgb24",
              "pipe:1",
            ],
            { encoding: "buffer", maxBuffer: 4_000_000 },
          )
        ).stdout;
      const first = await readFrame("0.4");
      const second = await readFrame("1.4");
      const center = (640 * 720 + 360) * 3;
      assert.ok(
        first[center] > 200 && first[center + 2] < 40,
        "First scene keeps the photo content",
      );
      assert.ok(
        second[center + 2] > 200 && second[center] < 40,
        "Second scene keeps the video content",
      );
      let captionPixels = 0;
      for (let y = 850; y < 1180; y++)
        for (let x = 30; x < 690; x++) {
          const pixel = (y * 720 + x) * 3;
          if (
            first[pixel] > 220 &&
            first[pixel + 1] > 220 &&
            first[pixel + 2] > 220
          )
            captionPixels++;
        }
      assert.ok(
        captionPixels > 100,
        "Caption text is visible in the rendered frame",
      );
    } finally {
      try {
        await cleanupOutput?.();
      } finally {
        try {
          if (imageServer.listening) {
            await new Promise<void>((resolve, reject) =>
              imageServer.close((error) => (error ? reject(error) : resolve())),
            );
          }
        } finally {
          await rm(fixtureDir, { recursive: true, force: true });
        }
      }
    }
  },
);

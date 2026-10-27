import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runProcess, type ProcessRunInput } from "../process-runner";
import { probeVideoFile } from "../video-probe";
import { PULSE_INTERVAL_MS } from "./pulse";

// ffmpeg steps of a product video import: one upright, silent H.264 copy for
// Meta's models, the narration as MP3 for speech-to-text, and per-product
// clips and frames.

export type RunProcess = (
  input: ProcessRunInput,
) => Promise<{ stdout: string; stderr: string }>;

export type ProductVideoMediaDeps = {
  runProcess?: RunProcess;
  signal?: AbortSignal;
  /** Called while ffmpeg runs, so a Temporal activity can heartbeat. */
  pulse?: () => void;
};

/** Longer videos cost too much to read, and are rarely one shelf. */
export const MAX_PRODUCT_VIDEO_SECONDS = 300;
const FFMPEG_TIMEOUT_MS = 5 * 60_000;
// Local files only, in the containers phones and WhatsApp send.
const INPUT_GUARD = [
  "-nostdin",
  "-protocol_whitelist",
  "file",
  "-format_whitelist",
  "mov,matroska,webm",
];

/**
 * A problem with the video itself, which retrying won't change: the import
 * should stop and tell the owner.
 */
export class ProductVideoError extends Error {
  readonly code: "video_too_long" | "video_unreadable" | "no_frames";

  constructor(code: ProductVideoError["code"], message: string) {
    super(message);
    this.name = "ProductVideoError";
    this.code = code;
  }
}

function ffmpeg(args: string[], deps: ProductVideoMediaDeps) {
  return (deps.runProcess ?? runProcess)({
    command: "ffmpeg",
    args: ["-y", "-v", "error", ...INPUT_GUARD, ...args],
    timeoutMs: FFMPEG_TIMEOUT_MS,
    signal: deps.signal,
    onPulse: deps.pulse,
    pulseIntervalMs: deps.pulse ? PULSE_INTERVAL_MS : undefined,
  });
}

export type PreparedProductVideo = {
  /** Upright, silent H.264 MP4, short side at most 720 px, index first. */
  videoPath: string;
  /** Mono 16 kHz MP3 of the narration, or null when the video has no sound. */
  audioPath: string | null;
  durationSeconds: number;
  width: number;
  height: number;
};

// Phones send rotated HEVC .mov files, often 10-bit. Muse Spark takes MP4
// only and SAM remuxes files whose index sits at the end, so every video is
// normalized once. Muse Spark gets no sound: given the narration as audio it
// sometimes invented its own instead of using the transcript.
export async function prepareProductVideo(
  sourcePath: string,
  workDir: string,
  deps: ProductVideoMediaDeps = {},
): Promise<PreparedProductVideo> {
  await mkdir(workDir, { recursive: true });
  const videoPath = join(workDir, "video.mp4");
  try {
    await ffmpeg(
      [
        "-i",
        sourcePath,
        // Stop a second past the limit, so a long video is refused quickly.
        "-t",
        String(MAX_PRODUCT_VIDEO_SECONDS + 1),
        "-an",
        "-vf",
        "scale='if(gt(iw,ih),-2,min(720,iw))':'if(gt(iw,ih),min(720,ih),-2)'",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        videoPath,
      ],
      deps,
    );
  } catch (error) {
    // A timeout or a cancel isn't the video's fault; only ffmpeg giving up is.
    if (!/exited with code/.test(String(error))) throw error;
    throw new ProductVideoError(
      "video_unreadable",
      `The video couldn't be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const probe = await probeVideoFile(videoPath, {
    runProcess: deps.runProcess,
  });
  if (probe.durationSeconds > MAX_PRODUCT_VIDEO_SECONDS) {
    throw new ProductVideoError(
      "video_too_long",
      `The video is ${Math.round(probe.durationSeconds)} s long; the limit is ${MAX_PRODUCT_VIDEO_SECONDS} s.`,
    );
  }

  const audioPath = join(workDir, "narration.mp3");
  let hasAudio = true;
  try {
    await ffmpeg(
      [
        "-i",
        sourcePath,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "48k",
        audioPath,
      ],
      deps,
    );
  } catch (error) {
    // A video without a sound track: products can still be found, unpriced.
    if (!/matches no streams|does not contain any stream/i.test(String(error)))
      throw error;
    hasAudio = false;
  }

  return {
    videoPath,
    audioPath: hasAudio ? audioPath : null,
    durationSeconds: probe.durationSeconds,
    width: probe.width,
    height: probe.height,
  };
}

/** A silent clip of one stretch of the video at `fps`, for SAM to track one product through. */
export async function extractProductClip(
  videoPath: string,
  window: { fromSeconds: number; toSeconds: number },
  fps: number,
  outPath: string,
  deps: ProductVideoMediaDeps = {},
): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  const start = Math.max(0, window.fromSeconds);
  await ffmpeg(
    [
      "-ss",
      start.toFixed(3),
      "-i",
      videoPath,
      "-t",
      Math.max(0.1, window.toSeconds - start).toFixed(3),
      "-vf",
      `fps=${fps}`,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outPath,
    ],
    deps,
  );
}

/** Every frame of a clip as JPEG, in order: element i is the clip's frame i, as SAM numbers them. */
export async function extractClipFrames(
  clipPath: string,
  outDir: string,
  deps: ProductVideoMediaDeps = {},
): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  await ffmpeg(
    ["-i", clipPath, "-q:v", "2", join(outDir, "frame-%04d.jpg")],
    deps,
  );
  return (await readdir(outDir))
    .filter((name) => /^frame-\d+\.jpg$/.test(name))
    .sort()
    .map((name) => join(outDir, name));
}

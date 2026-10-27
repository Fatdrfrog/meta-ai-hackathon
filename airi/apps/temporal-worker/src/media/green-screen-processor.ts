import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { sanitizeStorageFilename } from "@icecore/shared/lib/storage-filename";

export type GreenScreenProcessorInput = {
  workspaceId: string;
  sourceAssetId: string;
  outputAssetId: string;
  sourceUrl: string;
  sourceFileName?: string | null;
  onProgress?: (details: GreenScreenProcessorProgress) => void;
};

export type GreenScreenProcessorResult = {
  buffer: Buffer;
  mimeType: "video/mp4";
  fileName: string;
  providerPayload: Record<string, unknown>;
};

export type GreenScreenProcessorProgress = {
  phase: string;
  elapsedMs?: number;
  phaseElapsedMs?: number;
  totalElapsedMs?: number;
  frames?: number;
  bytes?: number;
  totalBytes?: number;
  chunkIndex?: number;
  chunkCount?: number;
};

type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
};

type FfprobePayload = {
  streams?: FfprobeStream[];
  format?: {
    duration?: string;
    size?: string;
  };
};

export const GREEN_SCREEN_PROCESSOR_LIMITS = Object.freeze({
  maxSourceBytes: 256 * 1024 * 1024,
  maxOutputBytes: 256 * 1024 * 1024,
  maxDurationSeconds: 90,
  maxPixels: 4_000_000,
  maxLongEdge: 960,
  maxFrames: 360,
  maxFps: 12,
  processTimeoutMs: 15 * 60_000,
  totalTimeoutMs: 25 * 60_000,
});

const PROGRESS_HEARTBEAT_INTERVAL_MS = 30_000;
const DOWNLOAD_PROGRESS_INTERVAL_MS = 15_000;
const DOWNLOAD_PROGRESS_BYTES = 8 * 1024 * 1024;

function createTimeoutBudget() {
  const startedAt = Date.now();
  const totalTimeoutMs = GREEN_SCREEN_PROCESSOR_LIMITS.totalTimeoutMs;

  return {
    elapsedMs() {
      return Date.now() - startedAt;
    },
    timeoutMsForPhase(phase: string) {
      const remainingMs = totalTimeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        throw new Error(
          `Green-screen processing timed out after ${Math.round(totalTimeoutMs / 60_000)} minutes during ${phase}`,
        );
      }

      return Math.min(
        GREEN_SCREEN_PROCESSOR_LIMITS.processTimeoutMs,
        remainingMs,
      );
    },
  };
}

const GREEN_SCREEN_MATTING_RUNNER_PATH = fileURLToPath(
  new URL("../../media-runners/mediapipe_green_screen.py", import.meta.url),
);
const SUPPORTED_VIDEO_CODECS = new Set([
  "h264",
  "hevc",
  "mpeg4",
  "vp8",
  "vp9",
  "av1",
]);

export function resolveGreenScreenMattingCommand(): {
  command: string;
  args: string[];
} {
  return {
    command: "python3",
    args: [GREEN_SCREEN_MATTING_RUNNER_PATH],
  };
}

function withGreenScreenSuffix(fileName: string | null | undefined): string {
  const clean = sanitizeStorageFilename(fileName, "source.mp4");
  const ext = path.extname(clean);
  const base = ext ? clean.slice(0, -ext.length) : clean;
  return `${base || "video"}-green-screen.mp4`;
}

export function buildGreenScreenProcessorPaths(params: {
  workDir: string;
  sourceFileName?: string | null;
}) {
  const inputDir = path.join(params.workDir, "input");
  const outputDir = path.join(params.workDir, "output");
  const framesDir = path.join(params.workDir, "frames");
  const mattedFramesDir = path.join(params.workDir, "matted");

  return {
    inputDir,
    outputDir,
    framesDir,
    mattedFramesDir,
    inputPath: path.join(
      inputDir,
      sanitizeStorageFilename(params.sourceFileName, "source.mp4"),
    ),
    outputPath: path.join(outputDir, "green-screen.mp4"),
    framePattern: path.join(framesDir, "%06d.jpg"),
    mattedFramePattern: path.join(mattedFramesDir, "%06d.png"),
  };
}

function parsePositiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseFrameRate(value: string | undefined): number | null {
  if (!value || value === "0/0") return null;
  const [rawNumerator, rawDenominator] = value.split("/");
  const numerator = Number(rawNumerator);
  const denominator = rawDenominator === undefined ? 1 : Number(rawDenominator);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return null;
  }
  if (denominator <= 0) return null;
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

export function resolveGreenScreenProcessingPlan(params: {
  durationSeconds: number;
  sourceFps: number;
}): { processingFps: number; estimatedFrames: number } {
  const maxFps = GREEN_SCREEN_PROCESSOR_LIMITS.maxFps;
  const maxFrames = GREEN_SCREEN_PROCESSOR_LIMITS.maxFrames;
  const roundedSourceFps = Math.max(1, Math.round(params.sourceFps));
  const fpsForFrameBudget = Math.max(
    1,
    Math.floor(maxFrames / params.durationSeconds),
  );
  const processingFps = Math.max(
    1,
    Math.min(maxFps, roundedSourceFps, fpsForFrameBudget),
  );

  return {
    processingFps,
    estimatedFrames: Math.ceil(params.durationSeconds * processingFps),
  };
}

function toEvenDimension(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

export function resolveGreenScreenProcessingDimensions(params: {
  width: number;
  height: number;
}): { width: number; height: number } {
  const maxLongEdge = GREEN_SCREEN_PROCESSOR_LIMITS.maxLongEdge;
  const longEdge = Math.max(params.width, params.height);
  if (longEdge <= maxLongEdge) {
    return {
      width: toEvenDimension(params.width),
      height: toEvenDimension(params.height),
    };
  }

  const scale = maxLongEdge / longEdge;
  return {
    width: toEvenDimension(params.width * scale),
    height: toEvenDimension(params.height * scale),
  };
}

async function runProcess(params: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  timeoutMs?: number;
  phase: string;
  onProgress?: (details: GreenScreenProcessorProgress) => void;
}): Promise<{ stdout: string }> {
  const timeoutMs =
    params.timeoutMs || GREEN_SCREEN_PROCESSOR_LIMITS.processTimeoutMs;

  return new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env,
      shell: params.shell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const startedAt = Date.now();
    params.onProgress?.({ phase: params.phase, phaseElapsedMs: 0 });
    const progressInterval = setInterval(() => {
      if (settled) return;
      params.onProgress?.({
        phase: params.phase,
        phaseElapsedMs: Date.now() - startedAt,
      });
    }, PROGRESS_HEARTBEAT_INTERVAL_MS);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(progressInterval);
      child.kill("SIGKILL");
      reject(
        new Error(
          `Green-screen processing phase ${params.phase} timed out after ${Math.round(timeoutMs / 1000)}s`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(progressInterval);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(progressInterval);
      params.onProgress?.({
        phase: params.phase,
        phaseElapsedMs: Date.now() - startedAt,
      });
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdout).toString("utf8") });
        return;
      }

      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(
        new Error(
          `${params.command} exited with code ${code}${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
  });
}

export async function downloadSourceVideo(
  url: string,
  outputPath: string,
  options?: {
    onProgress?: (details: GreenScreenProcessorProgress) => void;
  },
): Promise<number> {
  const maxBytes = GREEN_SCREEN_PROCESSOR_LIMITS.maxSourceBytes;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Source video URL must use HTTP or HTTPS");
  }

  const response = await fetch(parsed, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to download source video: HTTP ${response.status}`);
  }
  const contentLength = Number.parseInt(
    response.headers.get("content-length") || "",
    10,
  );
  const knownTotalBytes =
    Number.isFinite(contentLength) && contentLength > 0
      ? contentLength
      : undefined;
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("Source video exceeds green-screen processing size limit");
  }

  let totalBytes = 0;
  let lastProgressAt = Date.now();
  let lastProgressBytes = 0;
  const reportProgress = (force = false) => {
    const now = Date.now();
    if (
      !force &&
      totalBytes - lastProgressBytes < DOWNLOAD_PROGRESS_BYTES &&
      now - lastProgressAt < DOWNLOAD_PROGRESS_INTERVAL_MS
    ) {
      return;
    }
    lastProgressAt = now;
    lastProgressBytes = totalBytes;
    options?.onProgress?.({
      phase: "download",
      bytes: totalBytes,
      ...(knownTotalBytes ? { totalBytes: knownTotalBytes } : {}),
    });
  };
  const body = response.body;
  if (!body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error(
        "Source video exceeds green-screen processing size limit",
      );
    }
    await writeFile(outputPath, buffer);
    totalBytes = buffer.byteLength;
    reportProgress(true);
    return buffer.byteLength;
  }

  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        callback(
          new Error("Source video exceeds green-screen processing size limit"),
        );
        return;
      }
      reportProgress();
      callback(null, chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>),
    limiter,
    createWriteStream(outputPath),
  );
  reportProgress(true);
  return totalBytes;
}

async function ffprobe(
  inputPath: string,
  params?: {
    timeoutMs?: number;
    onProgress?: (details: GreenScreenProcessorProgress) => void;
  },
): Promise<FfprobePayload> {
  const result = await runProcess({
    command: "ffprobe",
    args: [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      inputPath,
    ],
    phase: "probe",
    timeoutMs: params?.timeoutMs,
    onProgress: params?.onProgress,
  });
  return JSON.parse(result.stdout) as FfprobePayload;
}

function validateVideoMetadata(payload: FfprobePayload) {
  const stream = payload.streams?.find(
    (candidate) => candidate.codec_type === "video",
  );
  if (!stream) {
    throw new Error("FFprobe did not find a video stream");
  }

  const durationSeconds =
    parsePositiveNumber(stream.duration) ||
    parsePositiveNumber(payload.format?.duration);
  if (!durationSeconds) {
    throw new Error("FFprobe did not return a usable video duration");
  }

  const codec = String(stream.codec_name || "")
    .trim()
    .toLowerCase();
  if (!codec || !SUPPORTED_VIDEO_CODECS.has(codec)) {
    throw new Error(
      codec
        ? `Unsupported source video codec for green-screen edit: ${codec}`
        : "FFprobe did not return a usable video codec",
    );
  }

  const width = Number(stream.width);
  const height = Number(stream.height);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("FFprobe did not return usable video dimensions");
  }

  const maxDurationSeconds = GREEN_SCREEN_PROCESSOR_LIMITS.maxDurationSeconds;
  if (durationSeconds > maxDurationSeconds) {
    throw new Error(
      `Source video is too long for green-screen processing. Maximum is ${maxDurationSeconds}s`,
    );
  }

  const maxPixels = GREEN_SCREEN_PROCESSOR_LIMITS.maxPixels;
  if (width * height > maxPixels) {
    throw new Error(
      "Source video dimensions exceed green-screen processing limit",
    );
  }

  const sourceFps =
    parseFrameRate(stream.avg_frame_rate) ||
    parseFrameRate(stream.r_frame_rate) ||
    GREEN_SCREEN_PROCESSOR_LIMITS.maxFps;
  const processingDimensions = resolveGreenScreenProcessingDimensions({
    width,
    height,
  });
  const { processingFps, estimatedFrames } = resolveGreenScreenProcessingPlan({
    durationSeconds,
    sourceFps,
  });
  const maxFrames = GREEN_SCREEN_PROCESSOR_LIMITS.maxFrames;
  if (estimatedFrames > maxFrames) {
    throw new Error(
      `Source video exceeds green-screen frame limit. Maximum is ${maxFrames} frames`,
    );
  }

  return {
    codec,
    sourceWidth: width,
    sourceHeight: height,
    width: processingDimensions.width,
    height: processingDimensions.height,
    durationSeconds,
    processingFps,
    estimatedFrames,
  };
}

async function countImageFrames(
  directory: string,
  extensions = [".png"],
): Promise<number> {
  const normalizedExtensions = new Set(
    extensions.map((extension) => extension.toLowerCase()),
  );
  const entries = await readdir(directory);
  return entries.filter((entry) =>
    normalizedExtensions.has(path.extname(entry).toLowerCase()),
  ).length;
}

async function assertOutputSize(outputPath: string): Promise<void> {
  const maxBytes = GREEN_SCREEN_PROCESSOR_LIMITS.maxOutputBytes;
  const output = await stat(outputPath);
  if (output.size <= 0) {
    throw new Error("Green-screen processor produced an empty video");
  }
  if (output.size > maxBytes) {
    throw new Error("Green-screen output exceeds creative asset size limit");
  }
}

async function runMattingCommand(params: {
  workspaceId: string;
  sourceAssetId: string;
  outputAssetId: string;
  inputPath: string;
  framesDir: string;
  mattedFramesDir: string;
  workingDir: string;
  width: number;
  height: number;
  fps: number;
  timeoutMs?: number;
  onProgress?: (details: GreenScreenProcessorProgress) => void;
}): Promise<void> {
  const command = resolveGreenScreenMattingCommand();
  await runProcess({
    command: command.command,
    args: [
      ...command.args,
      "--frames-dir",
      params.framesDir,
      "--matted-frames-dir",
      params.mattedFramesDir,
      "--fps",
      String(params.fps),
    ],
    cwd: params.workingDir,
    phase: "matting",
    timeoutMs: params.timeoutMs,
    onProgress: params.onProgress,
  });
}

export async function runGreenScreenProcessor(
  input: GreenScreenProcessorInput,
): Promise<GreenScreenProcessorResult> {
  const budget = createTimeoutBudget();
  const reportProgress = (details: GreenScreenProcessorProgress) => {
    input.onProgress?.({
      ...details,
      totalElapsedMs: budget.elapsedMs(),
    });
  };
  const workDir = await mkdtemp(path.join(tmpdir(), "airi-green-screen-"));
  const paths = buildGreenScreenProcessorPaths({
    workDir,
    sourceFileName: input.sourceFileName,
  });

  try {
    await mkdir(paths.inputDir, { recursive: true });
    await mkdir(paths.outputDir, { recursive: true });
    await mkdir(paths.framesDir, { recursive: true });
    await mkdir(paths.mattedFramesDir, { recursive: true });

    reportProgress({ phase: "download" });
    const sourceBytes = await downloadSourceVideo(
      input.sourceUrl,
      paths.inputPath,
      { onProgress: reportProgress },
    );
    reportProgress({ phase: "downloaded", bytes: sourceBytes });
    const metadata = validateVideoMetadata(
      await ffprobe(paths.inputPath, {
        timeoutMs: budget.timeoutMsForPhase("probe"),
        onProgress: reportProgress,
      }),
    );
    reportProgress({
      phase: "metadata_validated",
      frames: metadata.estimatedFrames,
    });

    await runProcess({
      command: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        paths.inputPath,
        "-vf",
        `fps=${metadata.processingFps},scale=${metadata.width}:${metadata.height}:flags=lanczos`,
        "-q:v",
        "3",
        paths.framePattern,
      ],
      phase: "extract_frames",
      timeoutMs: budget.timeoutMsForPhase("extract_frames"),
      onProgress: reportProgress,
    });

    const extractedFrames = await countImageFrames(paths.framesDir, [
      ".jpg",
      ".jpeg",
    ]);
    if (extractedFrames <= 0) {
      throw new Error("FFmpeg did not extract any video frames");
    }
    reportProgress({ phase: "frames_extracted", frames: extractedFrames });

    await runMattingCommand({
      workspaceId: input.workspaceId,
      sourceAssetId: input.sourceAssetId,
      outputAssetId: input.outputAssetId,
      inputPath: paths.inputPath,
      framesDir: paths.framesDir,
      mattedFramesDir: paths.mattedFramesDir,
      workingDir: workDir,
      width: metadata.width,
      height: metadata.height,
      fps: metadata.processingFps,
      timeoutMs: budget.timeoutMsForPhase("matting"),
      onProgress: reportProgress,
    });

    const mattedFrames = await countImageFrames(paths.mattedFramesDir, [
      ".png",
    ]);
    if (mattedFrames !== extractedFrames) {
      throw new Error(
        `Matting command returned ${mattedFrames} frames for ${extractedFrames} extracted frames`,
      );
    }
    reportProgress({ phase: "frames_matted", frames: mattedFrames });

    await runProcess({
      command: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-framerate",
        String(metadata.processingFps),
        "-i",
        paths.mattedFramePattern,
        "-i",
        paths.inputPath,
        "-filter_complex",
        `color=c=0x00ff00:s=${metadata.width}x${metadata.height}:r=${metadata.processingFps},format=rgba[bg];[bg][0:v]overlay=shortest=1:format=auto,format=yuv420p[v]`,
        "-map",
        "[v]",
        "-map",
        "1:a?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-shortest",
        "-movflags",
        "+faststart",
        paths.outputPath,
      ],
      phase: "encode",
      timeoutMs: budget.timeoutMsForPhase("encode"),
      onProgress: reportProgress,
    });

    await assertOutputSize(paths.outputPath);
    reportProgress({ phase: "output_verified" });

    return {
      buffer: await readFile(paths.outputPath),
      mimeType: "video/mp4",
      fileName: withGreenScreenSuffix(input.sourceFileName),
      providerPayload: {
        operation: "green_screen",
        processor: "ffmpeg-mediapipe-image-segmenter",
        sourceBytes,
        durationSeconds: metadata.durationSeconds,
        codec: metadata.codec,
        width: metadata.width,
        height: metadata.height,
        fps: metadata.processingFps,
        frames: extractedFrames,
        sourceWidth: metadata.sourceWidth,
        sourceHeight: metadata.sourceHeight,
        backgroundColor: "#00ff00",
      },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

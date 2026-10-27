import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

import { AIRI_GREEN_SCREEN_MODEL_ID } from "@icecore/temporal";
import { readTrimmedString as cleanString } from "@icecore/shared/lib/value-utils";

import type {
  GreenScreenProcessorProgress,
  GreenScreenProcessorResult,
} from "./green-screen-processor.js";

export type BriaGreenScreenProcessorInput = {
  workspaceId: string;
  sourceAssetId: string;
  outputAssetId: string;
  sourceUrl: string;
  sourceFileName?: string | null;
  sourceFileSize?: number | null;
  providerRequestId?: string | null;
  providerStatusUrl?: string | null;
  abortSignal?: AbortSignal;
  uploadChunkSource?: (params: {
    buffer: Buffer;
    fileName: string;
    mimeType: "video/mp4";
    chunkIndex: number;
    chunkCount: number;
  }) => Promise<{ url: string; bucket?: string | null; path?: string | null }>;
  deleteChunkSource?: (params: {
    bucket?: string | null;
    path?: string | null;
  }) => Promise<void>;
  onProviderSubmitted?: (submission: {
    requestId: string;
    statusUrl: string;
    raw: Record<string, unknown>;
    chunkIndex?: number;
    chunkCount?: number;
  }) => Promise<void> | void;
  onProgress?: (details: GreenScreenProcessorProgress) => void;
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

type SourceVideoMetadata = {
  durationSeconds: number;
  codec: string;
  width: number;
  height: number;
  fps: number | null;
  sourceBytes: number | null;
};

const BRIA_GREEN_SCREEN_ENDPOINT =
  "https://engine.prod.bria-api.com/v2/video/edit/green_screen";
const BRIA_GREEN_SCREEN_STATUS_BASE_URL =
  "https://engine.prod.bria-api.com/v2/status";
const BRIA_GREEN_SCREEN_USER_AGENT = "BriaPlatform/APIdocs/LLMsAgent";
const BRIA_GREEN_SCREEN_PROVIDER = "bria";
const BRIA_GREEN_SCREEN_PROCESSOR = "bria-video-green-screen-api";
const BRIA_GREEN_SHADE = "chroma_green";
const BRIA_GREEN_BACKGROUND_COLOR = "#00ff00";
const BRIA_OUTPUT_CONTAINER_AND_CODEC = "mp4_h264";
const BRIA_PRESERVE_AUDIO = true;
const BRIA_CHUNK_SPLIT_MODE = "stream_copy";

export const BRIA_GREEN_SCREEN_LIMITS = Object.freeze({
  maxSourceBytes: 1024 * 1024 * 1024,
  maxOutputBytes: 512 * 1024 * 1024,
  maxDurationSeconds: 60,
  maxDimension: 16_000,
  ffprobeTimeoutMs: 60_000,
  pollIntervalMs: 5_000,
  pollTimeoutMs: 20 * 60_000,
  chunkSeconds: 55,
  downloadTimeoutMs: 10 * 60_000,
  splitTimeoutMs: 20 * 60_000,
  stitchTimeoutMs: 20 * 60_000,
});

const BRIA_PROGRESS_HEARTBEAT_INTERVAL_MS = 30_000;

const BRIA_SUPPORTED_VIDEO_CODECS = new Set([
  "h264",
  "hevc",
  "vp9",
  "av1",
  "mjpeg",
]);

const BRIA_TERMINAL_HTTP_STATUSES = new Set([400, 403, 405, 413, 415, 422]);
const BRIA_IN_PROGRESS_STATUSES = new Set([
  "IN_PROGRESS",
  "PROCESSING",
  "QUEUED",
  "PENDING",
  "STARTED",
]);
const BRIA_FAILED_STATUSES = new Set(["ERROR", "FAILED", "UNKNOWN"]);

export class BriaGreenScreenTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BriaGreenScreenTerminalError";
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Bria green-screen processing cancelled");
}

function parsePositiveNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseFrameRate(value: unknown): number | null {
  const text = cleanString(value);
  if (!text) return null;
  const [numeratorText, denominatorText] = text.split("/");
  const numerator = Number.parseFloat(numeratorText || "");
  const denominator = denominatorText ? Number.parseFloat(denominatorText) : 1;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return null;
  }
  if (denominator <= 0) return null;
  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

export function createBriaProgressPulse(params: {
  phase: string;
  onProgress?: (details: GreenScreenProcessorProgress) => void;
  details?: Omit<GreenScreenProcessorProgress, "phase" | "phaseElapsedMs">;
  intervalMs?: number;
}): () => void {
  if (!params.onProgress) return () => undefined;
  const startedAt = Date.now();
  const intervalMs = Math.max(
    1,
    params.intervalMs ?? BRIA_PROGRESS_HEARTBEAT_INTERVAL_MS,
  );
  const report = () => {
    params.onProgress?.({
      ...params.details,
      phase: params.phase,
      phaseElapsedMs: Date.now() - startedAt,
    });
  };

  report();
  const interval = setInterval(report, intervalMs);
  return () => {
    clearInterval(interval);
    report();
  };
}

async function withBriaProgressPulse<T>(
  params: Parameters<typeof createBriaProgressPulse>[0],
  task: () => Promise<T>,
): Promise<T> {
  const stopPulse = createBriaProgressPulse(params);
  try {
    return await task();
  } finally {
    stopPulse();
  }
}

function withGreenScreenSuffix(fileName: string | null | undefined): string {
  const parsed = path.parse(cleanString(fileName) || "video.mp4");
  const base = parsed.name.replace(/-green-screen$/i, "") || "video";
  return `${base}-green-screen.mp4`;
}

function resolveBriaStatusUrl(params: {
  requestId: string;
  statusUrl?: string | null;
}): string {
  const statusUrl = cleanString(params.statusUrl);
  if (statusUrl) return statusUrl;
  return `${BRIA_GREEN_SCREEN_STATUS_BASE_URL}/${encodeURIComponent(
    params.requestId,
  )}`;
}

function getBriaApiToken(): string {
  const token = cleanString(process.env.BRIA_API_TOKEN);
  if (!token) {
    throw new BriaGreenScreenTerminalError(
      "BRIA_API_TOKEN is required for green-screen processing",
    );
  }
  return token;
}

function assertHttpUrl(value: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new BriaGreenScreenTerminalError(
      "Source video URL must use HTTP or HTTPS",
    );
  }
}

function validateKnownSourceSize(sourceBytes: number | null | undefined): void {
  if (
    typeof sourceBytes === "number" &&
    sourceBytes > BRIA_GREEN_SCREEN_LIMITS.maxSourceBytes
  ) {
    throw new BriaGreenScreenTerminalError(
      "Source video exceeds Bria green-screen processing size limit",
    );
  }
}

async function runProcess(params: {
  command: string;
  args: string[];
  timeoutMs: number;
  phase?: string;
  onProgress?: (details: GreenScreenProcessorProgress) => void;
  signal?: AbortSignal;
  progressDetails?: Omit<
    GreenScreenProcessorProgress,
    "phase" | "phaseElapsedMs"
  >;
}): Promise<{ stdout: string; stderr: string }> {
  throwIfAborted(params.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const stopProgress = params.phase
      ? createBriaProgressPulse({
          phase: params.phase,
          onProgress: params.onProgress,
          details: params.progressDetails,
        })
      : () => undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const abort = () => {
      if (!finish()) return;
      child.kill("SIGKILL");
      reject(
        params.signal?.reason instanceof Error
          ? params.signal.reason
          : new Error("Bria green-screen processing cancelled"),
      );
    };
    const finish = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", abort);
      stopProgress();
      return true;
    };
    const timeout = setTimeout(() => {
      if (!finish()) return;
      child.kill("SIGKILL");
      reject(
        new BriaGreenScreenTerminalError(
          `${params.command} timed out while processing ${params.phase || "source video"}`,
        ),
      );
    }, params.timeoutMs);
    if (params.signal?.aborted) {
      abort();
    } else {
      params.signal?.addEventListener("abort", abort, { once: true });
    }

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      if (!finish()) return;
      reject(error);
    });
    child.on("close", (code) => {
      if (!finish()) return;
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (code === 0) {
        resolve({ stdout: stdoutText, stderr: stderrText });
        return;
      }
      reject(
        new BriaGreenScreenTerminalError(
          `${params.command} failed while processing ${params.phase || "source video"}: ${stderrText || `exit ${code}`}`,
        ),
      );
    });
  });
}

async function ffprobe(
  sourceUrl: string,
  onProgress?: (details: GreenScreenProcessorProgress) => void,
  signal?: AbortSignal,
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
      sourceUrl,
    ],
    timeoutMs: BRIA_GREEN_SCREEN_LIMITS.ffprobeTimeoutMs,
    phase: "metadata",
    onProgress,
    signal,
  });

  try {
    return JSON.parse(result.stdout) as FfprobePayload;
  } catch {
    throw new BriaGreenScreenTerminalError(
      "FFprobe returned invalid metadata for green-screen source video",
    );
  }
}

async function downloadSourceVideoToFile(params: {
  sourceUrl: string;
  outputPath: string;
  onProgress?: (details: GreenScreenProcessorProgress) => void;
  signal?: AbortSignal;
}): Promise<void> {
  throwIfAborted(params.signal);
  const response = await fetch(params.sourceUrl, {
    method: "GET",
    signal: params.signal,
    headers: {
      "User-Agent": BRIA_GREEN_SCREEN_USER_AGENT,
    },
  });
  if (!response.ok || !response.body) {
    const payload = await parseJsonResponse(response);
    throw new Error(
      formatBriaError(
        `Failed to download source video for chunking: HTTP ${response.status}`,
        payload,
      ),
    );
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > BRIA_GREEN_SCREEN_LIMITS.maxSourceBytes
  ) {
    throw new BriaGreenScreenTerminalError(
      "Source video exceeds Bria green-screen processing size limit",
    );
  }

  await withBriaProgressPulse(
    {
      phase: "source_download",
      onProgress: params.onProgress,
      details: {
        totalBytes: Number.isFinite(contentLength) ? contentLength : undefined,
      },
    },
    () =>
      pipeline(
        Readable.fromWeb(response.body as never),
        createWriteStream(params.outputPath),
        { signal: params.signal },
      ),
  );
}

function concatListLine(filePath: string): string {
  return `file '${filePath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

function chunkFileName(
  sourceFileName: string | null | undefined,
  index: number,
) {
  const parsed = path.parse(cleanString(sourceFileName) || "video.mp4");
  const base = parsed.name.replace(/-green-screen$/i, "") || "video";
  return `${base}-chunk-${String(index + 1).padStart(3, "0")}.mp4`;
}

async function splitSourceVideo(params: {
  inputPath: string;
  chunksDir: string;
  sourceFileName?: string | null;
  durationSeconds: number;
  onProgress?: (details: GreenScreenProcessorProgress) => void;
  signal?: AbortSignal;
}): Promise<Array<{ path: string; fileName: string; index: number }>> {
  await mkdir(params.chunksDir, { recursive: true });
  const chunkCount = Math.ceil(
    params.durationSeconds / BRIA_GREEN_SCREEN_LIMITS.chunkSeconds,
  );
  const chunks: Array<{ path: string; fileName: string; index: number }> = [];
  for (let index = 0; index < chunkCount; index += 1) {
    throwIfAborted(params.signal);
    const startSeconds = index * BRIA_GREEN_SCREEN_LIMITS.chunkSeconds;
    const durationSeconds = Math.min(
      BRIA_GREEN_SCREEN_LIMITS.chunkSeconds,
      Math.max(0.1, params.durationSeconds - startSeconds),
    );
    const fileName = chunkFileName(params.sourceFileName, index);
    const outputPath = path.join(params.chunksDir, fileName);
    await runProcess({
      command: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        String(startSeconds),
        "-t",
        String(durationSeconds),
        "-i",
        params.inputPath,
        "-map",
        "0",
        "-c",
        "copy",
        "-avoid_negative_ts",
        "make_zero",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      timeoutMs: BRIA_GREEN_SCREEN_LIMITS.splitTimeoutMs,
      phase: "split_chunk",
      onProgress: params.onProgress,
      signal: params.signal,
      progressDetails: {
        chunkIndex: index + 1,
        chunkCount,
      },
    });
    chunks.push({ path: outputPath, fileName, index });
  }
  return chunks;
}

async function stitchOutputChunks(params: {
  chunkBuffers: Buffer[];
  outputDir: string;
  outputPath: string;
  onProgress?: (details: GreenScreenProcessorProgress) => void;
  signal?: AbortSignal;
}): Promise<Buffer> {
  await mkdir(params.outputDir, { recursive: true });
  const chunkPaths: string[] = [];
  for (const [index, buffer] of params.chunkBuffers.entries()) {
    const chunkPath = path.join(
      params.outputDir,
      `bria-output-${String(index + 1).padStart(3, "0")}.mp4`,
    );
    await writeFile(chunkPath, buffer);
    chunkPaths.push(chunkPath);
  }

  const concatPath = path.join(params.outputDir, "concat.txt");
  await writeFile(concatPath, chunkPaths.map(concatListLine).join("\n"));
  await runProcess({
    command: "ffmpeg",
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatPath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      params.outputPath,
    ],
    timeoutMs: BRIA_GREEN_SCREEN_LIMITS.stitchTimeoutMs,
    phase: "stitch",
    onProgress: params.onProgress,
    progressDetails: {
      chunkCount: params.chunkBuffers.length,
    },
    signal: params.signal,
  });
  return readFile(params.outputPath);
}

function validateVideoMetadata(
  payload: FfprobePayload,
  knownSourceFileSize?: number | null,
): SourceVideoMetadata {
  const videoStream = payload.streams?.find(
    (stream) => stream.codec_type === "video",
  );
  if (!videoStream) {
    throw new BriaGreenScreenTerminalError(
      "FFprobe did not find a usable video stream",
    );
  }

  const durationSeconds =
    parsePositiveNumber(videoStream.duration) ||
    parsePositiveNumber(payload.format?.duration);
  if (!durationSeconds) {
    throw new BriaGreenScreenTerminalError(
      "FFprobe did not return a usable video duration",
    );
  }
  const codec = cleanString(videoStream.codec_name).toLowerCase();
  if (!codec || !BRIA_SUPPORTED_VIDEO_CODECS.has(codec)) {
    throw new BriaGreenScreenTerminalError(
      codec
        ? `Unsupported source video codec for Bria green-screen edit: ${codec}`
        : "FFprobe did not return a source video codec",
    );
  }

  const width = Number(videoStream.width);
  const height = Number(videoStream.height);
  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    throw new BriaGreenScreenTerminalError(
      "FFprobe did not return usable source video dimensions",
    );
  }
  if (
    width > BRIA_GREEN_SCREEN_LIMITS.maxDimension ||
    height > BRIA_GREEN_SCREEN_LIMITS.maxDimension
  ) {
    throw new BriaGreenScreenTerminalError(
      "Source video dimensions exceed Bria green-screen processing limit",
    );
  }

  const ffprobeSourceBytes = parsePositiveNumber(payload.format?.size);
  const sourceBytes =
    typeof knownSourceFileSize === "number" && knownSourceFileSize > 0
      ? knownSourceFileSize
      : ffprobeSourceBytes;
  validateKnownSourceSize(sourceBytes);

  return {
    durationSeconds,
    codec,
    width,
    height,
    fps:
      parseFrameRate(videoStream.avg_frame_rate) ||
      parseFrameRate(videoStream.r_frame_rate),
    sourceBytes,
  };
}

async function parseJsonResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return { message: text };
  }
}

function formatBriaError(
  prefix: string,
  payload: Record<string, unknown>,
): string {
  const error = payload.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = cleanString((error as Record<string, unknown>).message);
    if (message) return `${prefix}: ${message}`;
  }
  const message = cleanString(payload.message) || cleanString(payload.detail);
  return message ? `${prefix}: ${message}` : prefix;
}

async function submitBriaGreenScreenJob(params: {
  token: string;
  sourceUrl: string;
  signal?: AbortSignal;
}): Promise<{
  requestId: string;
  statusUrl: string;
  raw: Record<string, unknown>;
}> {
  throwIfAborted(params.signal);
  const response = await fetch(BRIA_GREEN_SCREEN_ENDPOINT, {
    method: "POST",
    signal: params.signal,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": BRIA_GREEN_SCREEN_USER_AGENT,
      api_token: params.token,
    },
    body: JSON.stringify({
      video: params.sourceUrl,
      green_shade: BRIA_GREEN_SHADE,
      output_container_and_codec: BRIA_OUTPUT_CONTAINER_AND_CODEC,
      preserve_audio: BRIA_PRESERVE_AUDIO,
    }),
  });
  const payload = await parseJsonResponse(response);

  if (!response.ok) {
    const message = formatBriaError(
      `Bria green-screen API returned HTTP ${response.status}`,
      payload,
    );
    if (BRIA_TERMINAL_HTTP_STATUSES.has(response.status)) {
      throw new BriaGreenScreenTerminalError(message);
    }
    throw new Error(message);
  }

  const requestId =
    cleanString(payload.request_id) || cleanString(payload.requestId);
  const statusUrl =
    cleanString(payload.status_url) || cleanString(payload.statusUrl);
  if (!requestId || !statusUrl) {
    throw new Error("Bria green-screen API did not return request metadata");
  }

  return { requestId, statusUrl, raw: payload };
}

function extractBriaOutputVideoUrl(payload: Record<string, unknown>): string {
  const result =
    payload.result &&
    typeof payload.result === "object" &&
    !Array.isArray(payload.result)
      ? (payload.result as Record<string, unknown>)
      : {};
  const candidates = [
    result.video_url,
    result.video,
    result.url,
    payload.video_url,
    payload.video,
    payload.url,
  ];
  for (const candidate of candidates) {
    const value = cleanString(candidate);
    if (value) return value;
  }
  throw new Error("Bria green-screen API completed without a result video URL");
}

async function pollBriaGreenScreenJob(params: {
  token: string;
  requestId: string;
  statusUrl: string;
  signal?: AbortSignal;
  onProgress?: (details: GreenScreenProcessorProgress) => void;
}): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= BRIA_GREEN_SCREEN_LIMITS.pollTimeoutMs) {
    throwIfAborted(params.signal);
    const response = await fetch(params.statusUrl, {
      method: "GET",
      signal: params.signal,
      headers: {
        "User-Agent": BRIA_GREEN_SCREEN_USER_AGENT,
        api_token: params.token,
      },
    });
    const payload = await parseJsonResponse(response);

    if (!response.ok) {
      const message = formatBriaError(
        `Bria green-screen status API returned HTTP ${response.status}`,
        payload,
      );
      if (BRIA_TERMINAL_HTTP_STATUSES.has(response.status)) {
        throw new BriaGreenScreenTerminalError(message);
      }
      throw new Error(message);
    }

    const status = cleanString(payload.status).toUpperCase();
    params.onProgress?.({
      phase: "bria_poll",
      elapsedMs: Date.now() - startedAt,
    });

    if (status === "COMPLETED") return payload;
    if (BRIA_FAILED_STATUSES.has(status)) {
      throw new BriaGreenScreenTerminalError(
        formatBriaError("Bria green-screen API failed", payload),
      );
    }
    if (!status || BRIA_IN_PROGRESS_STATUSES.has(status)) {
      await delay(BRIA_GREEN_SCREEN_LIMITS.pollIntervalMs, undefined, {
        signal: params.signal,
      });
      continue;
    }

    throw new Error(
      `Bria green-screen API returned unexpected status: ${status}`,
    );
  }

  throw new Error(
    "Bria green-screen API timed out while waiting for completion",
  );
}

async function downloadBriaOutput(
  url: string,
  params?: {
    onProgress?: (details: GreenScreenProcessorProgress) => void;
    signal?: AbortSignal;
    progressDetails?: Omit<
      GreenScreenProcessorProgress,
      "phase" | "phaseElapsedMs"
    >;
  },
): Promise<Buffer> {
  throwIfAborted(params?.signal);
  const response = await fetch(url, {
    method: "GET",
    signal: params?.signal,
    headers: {
      "User-Agent": BRIA_GREEN_SCREEN_USER_AGENT,
    },
  });
  if (!response.ok) {
    const payload = await parseJsonResponse(response);
    throw new Error(
      formatBriaError(
        `Failed to download Bria green-screen output: HTTP ${response.status}`,
        payload,
      ),
    );
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > BRIA_GREEN_SCREEN_LIMITS.maxOutputBytes
  ) {
    throw new BriaGreenScreenTerminalError(
      "Bria green-screen output exceeds creative asset size limit",
    );
  }

  const buffer = await withBriaProgressPulse(
    {
      phase: "download",
      onProgress: params?.onProgress,
      details: {
        ...params?.progressDetails,
        totalBytes: Number.isFinite(contentLength) ? contentLength : undefined,
      },
    },
    async () => Buffer.from(await response.arrayBuffer()),
  );
  if (!buffer.length) {
    throw new Error("Bria green-screen API produced an empty video");
  }
  if (buffer.length > BRIA_GREEN_SCREEN_LIMITS.maxOutputBytes) {
    throw new BriaGreenScreenTerminalError(
      "Bria green-screen output exceeds creative asset size limit",
    );
  }

  return buffer;
}

async function processBriaGreenScreenJob(params: {
  input: BriaGreenScreenProcessorInput;
  token: string;
  sourceUrl: string;
  requestId?: string | null;
  statusUrl?: string | null;
  signal?: AbortSignal;
  chunkIndex?: number;
  chunkCount?: number;
}): Promise<{
  buffer: Buffer;
  requestId: string;
  statusUrl: string;
  outputUrl: string;
  completedPayload: Record<string, unknown>;
  submitResponse: Record<string, unknown> | null;
}> {
  let requestId = cleanString(params.requestId);
  let statusUrl = cleanString(params.statusUrl);
  let submitResponse: Record<string, unknown> | null = null;
  const chunkProgress =
    typeof params.chunkIndex === "number" &&
    typeof params.chunkCount === "number"
      ? {
          chunkIndex: params.chunkIndex,
          chunkCount: params.chunkCount,
        }
      : {};

  if (!requestId) {
    params.input.onProgress?.({ phase: "bria_submit", ...chunkProgress });
    const submitted = await submitBriaGreenScreenJob({
      token: params.token,
      sourceUrl: params.sourceUrl,
      signal: params.signal,
    });
    requestId = submitted.requestId;
    statusUrl = submitted.statusUrl;
    submitResponse = submitted.raw;
    await params.input.onProviderSubmitted?.({
      ...submitted,
      ...chunkProgress,
    });
  }
  statusUrl = resolveBriaStatusUrl({ requestId, statusUrl });

  params.input.onProgress?.({ phase: "bria_poll", ...chunkProgress });
  const completedPayload = await pollBriaGreenScreenJob({
    token: params.token,
    requestId,
    statusUrl,
    signal: params.signal,
    onProgress: (details) =>
      params.input.onProgress?.({ ...details, ...chunkProgress }),
  });
  const outputUrl = extractBriaOutputVideoUrl(completedPayload);

  params.input.onProgress?.({ phase: "download", ...chunkProgress });
  const buffer = await downloadBriaOutput(outputUrl, {
    onProgress: params.input.onProgress,
    signal: params.signal,
    progressDetails: chunkProgress,
  });
  params.input.onProgress?.({
    phase: "downloaded",
    bytes: buffer.length,
    ...chunkProgress,
  });

  return {
    buffer,
    requestId,
    statusUrl,
    outputUrl,
    completedPayload,
    submitResponse,
  };
}

export async function runBriaGreenScreenProcessor(
  input: BriaGreenScreenProcessorInput,
): Promise<GreenScreenProcessorResult> {
  throwIfAborted(input.abortSignal);
  assertHttpUrl(input.sourceUrl);
  validateKnownSourceSize(input.sourceFileSize);
  const token = getBriaApiToken();
  input.onProgress?.({ phase: "metadata" });
  const metadata = validateVideoMetadata(
    await ffprobe(input.sourceUrl, input.onProgress, input.abortSignal),
    input.sourceFileSize,
  );
  input.onProgress?.({ phase: "metadata_validated" });

  const isChunked =
    metadata.durationSeconds > BRIA_GREEN_SCREEN_LIMITS.maxDurationSeconds;
  const chunkCount = isChunked
    ? Math.ceil(
        metadata.durationSeconds / BRIA_GREEN_SCREEN_LIMITS.chunkSeconds,
      )
    : 1;
  let buffer: Buffer;
  let requestId = "";
  let statusUrl = "";
  let outputUrl = "";
  let completedPayload: Record<string, unknown> = {};
  let submitResponse: Record<string, unknown> | null = null;
  const chunkRequests: Array<{
    chunkIndex: number;
    requestId: string;
    statusUrl: string;
    outputUrl: string;
  }> = [];

  if (!isChunked) {
    const processed = await processBriaGreenScreenJob({
      input,
      token,
      sourceUrl: input.sourceUrl,
      requestId: input.providerRequestId,
      statusUrl: input.providerStatusUrl,
      signal: input.abortSignal,
    });
    buffer = processed.buffer;
    requestId = processed.requestId;
    statusUrl = processed.statusUrl;
    outputUrl = processed.outputUrl;
    completedPayload = processed.completedPayload;
    submitResponse = processed.submitResponse;
  } else {
    if (!input.uploadChunkSource) {
      throw new BriaGreenScreenTerminalError(
        "Chunked Bria green-screen processing requires temporary GCS chunk uploads",
      );
    }

    const workDir = await mkdtemp(path.join(tmpdir(), "bria-green-screen-"));
    const inputPath = path.join(workDir, "source.mp4");
    const chunksDir = path.join(workDir, "chunks");
    const outputsDir = path.join(workDir, "outputs");
    const finalPath = path.join(workDir, "green-screen.mp4");
    const uploadedChunks: Array<{
      bucket?: string | null;
      path?: string | null;
    }> = [];
    try {
      await downloadSourceVideoToFile({
        sourceUrl: input.sourceUrl,
        outputPath: inputPath,
        onProgress: input.onProgress,
        signal: input.abortSignal,
      });
      const chunks = await splitSourceVideo({
        inputPath,
        chunksDir,
        sourceFileName: input.sourceFileName,
        durationSeconds: metadata.durationSeconds,
        onProgress: input.onProgress,
        signal: input.abortSignal,
      });
      const outputBuffers: Buffer[] = [];
      for (const chunk of chunks) {
        throwIfAborted(input.abortSignal);
        const chunkIndex = chunk.index + 1;
        const chunkBuffer = await readFile(chunk.path);
        input.onProgress?.({
          phase: "upload_chunk",
          chunkIndex,
          chunkCount,
          bytes: chunkBuffer.byteLength,
        });
        const uploaded = await withBriaProgressPulse(
          {
            phase: "upload_chunk",
            onProgress: input.onProgress,
            details: {
              chunkIndex,
              chunkCount,
              bytes: chunkBuffer.byteLength,
            },
          },
          () =>
            input.uploadChunkSource!({
              buffer: chunkBuffer,
              fileName: chunk.fileName,
              mimeType: "video/mp4",
              chunkIndex,
              chunkCount,
            }),
        );
        uploadedChunks.push(uploaded);
        const processed = await processBriaGreenScreenJob({
          input,
          token,
          sourceUrl: uploaded.url,
          signal: input.abortSignal,
          chunkIndex,
          chunkCount,
        });
        outputBuffers.push(processed.buffer);
        chunkRequests.push({
          chunkIndex,
          requestId: processed.requestId,
          statusUrl: processed.statusUrl,
          outputUrl: processed.outputUrl,
        });
      }
      buffer = await stitchOutputChunks({
        chunkBuffers: outputBuffers,
        outputDir: outputsDir,
        outputPath: finalPath,
        onProgress: input.onProgress,
        signal: input.abortSignal,
      });
      requestId = chunkRequests[0]?.requestId || "";
      statusUrl = chunkRequests[0]?.statusUrl || "";
      outputUrl = chunkRequests.at(-1)?.outputUrl || "";
      completedPayload = {
        status: "COMPLETED",
        chunked: true,
        chunkCount,
      };
    } finally {
      await Promise.allSettled(
        uploadedChunks.map((chunk) => input.deleteChunkSource?.(chunk)),
      );
      await rm(workDir, { recursive: true, force: true });
    }
  }

  return {
    buffer,
    mimeType: "video/mp4",
    fileName: withGreenScreenSuffix(input.sourceFileName),
    providerPayload: {
      operation: "green_screen",
      provider: BRIA_GREEN_SCREEN_PROVIDER,
      processor: BRIA_GREEN_SCREEN_PROCESSOR,
      modelId: AIRI_GREEN_SCREEN_MODEL_ID,
      requestId,
      statusUrl,
      greenShade: BRIA_GREEN_SHADE,
      backgroundColor: BRIA_GREEN_BACKGROUND_COLOR,
      outputContainerAndCodec: BRIA_OUTPUT_CONTAINER_AND_CODEC,
      preserveAudio: BRIA_PRESERVE_AUDIO,
      endpoint: BRIA_GREEN_SCREEN_ENDPOINT,
      sourceBytes: metadata.sourceBytes,
      outputBytes: buffer.length,
      durationSeconds: metadata.durationSeconds,
      chunked: isChunked,
      chunkCount,
      chunkSeconds: BRIA_GREEN_SCREEN_LIMITS.chunkSeconds,
      chunkSplitMode: BRIA_CHUNK_SPLIT_MODE,
      usageMultiplier: chunkCount,
      ...(chunkRequests.length ? { chunkRequests } : {}),
      codec: metadata.codec,
      width: metadata.width,
      height: metadata.height,
      fps: metadata.fps,
      briaStatus: cleanString(completedPayload.status) || "COMPLETED",
      outputUrl,
      ...(submitResponse ? { submitResponse } : {}),
    },
  };
}

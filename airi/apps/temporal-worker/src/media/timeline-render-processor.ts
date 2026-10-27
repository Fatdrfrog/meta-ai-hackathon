import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CREATIVE_ASSET_TIMELINE_MAX_SOURCES,
  CREATIVE_ASSET_TIMELINE_PROBE_END_TOLERANCE_SECONDS,
  creativeAssetTimelineSourceKey,
  roundCreativeAssetTimelineSeconds,
  validateCreativeAssetTimeline,
  type CreativeAssetTimeline,
} from "@icecore/temporal";
import { readTrimmedString } from "@icecore/shared/lib/value-utils";
import { runProcess as runBoundedProcess } from "./process-runner";

const TIMELINE_RENDER_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const TIMELINE_PROBE_TIMEOUT_MS = 2 * 60 * 1000;
export const TIMELINE_PROCESS_PULSE_INTERVAL_MS = 30_000;

export const TIMELINE_RENDER_LIMITS = {
  maxSourceLongEdge: 4096,
  maxSourcePixels: 4096 * 2160,
  maxImageSourceLongEdge: 8192,
  maxImageSourcePixels: 24_000_000,
  maxSourceFps: 120,
  maxOutputLongEdge: 2160,
  maxOutputPixels: 4_000_000,
  maxOutputFps: 60,
  maxFramePixelWork: 150_000_000_000,
  maxOutputBytes: 8 * 1024 * 1024 * 1024,
} as const;

type FfprobePayload = {
  streams?: Array<{
    codec_type?: string;
    duration?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
  }>;
  format?: { duration?: string };
};

export type TimelineRenderProgress = {
  phase: "probe" | "encode" | "output_verified";
  phaseElapsedMs?: number;
  sourceIndex?: number;
  sourceCount?: number;
};

export type TimelineRenderSource = {
  assetId: string;
  url: string;
  kind?: "video" | "image";
  fileName?: string | null;
};

export type TimelineRenderSourceMetadata = {
  assetId: string;
  url: string;
  fileName: string | null;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  kind?: "video" | "image";
};

export type TimelineRenderProcessorResult = {
  outputPath: string;
  mimeType: "video/mp4";
  fileName: string;
  fileSize: number;
  providerPayload: Record<string, unknown>;
  cleanup: () => Promise<void>;
};

export class TimelineRenderTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimelineRenderTerminalError";
  }
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function parseFrameRate(value: unknown): number | null {
  const text = readTrimmedString(value);
  if (!text) return null;
  if (!text.includes("/")) return positiveNumber(text);
  const [numeratorText, denominatorText] = text.split("/", 2);
  const numerator = positiveNumber(numeratorText);
  const denominator = positiveNumber(denominatorText);
  if (!numerator || !denominator) return null;
  return numerator / denominator;
}

function evenDimension(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function resolveOutputDimensions(source: { width: number; height: number }): {
  width: number;
  height: number;
} {
  const longEdge = Math.max(source.width, source.height);
  const pixels = source.width * source.height;
  const scale = Math.min(
    1,
    TIMELINE_RENDER_LIMITS.maxOutputLongEdge / longEdge,
    Math.sqrt(TIMELINE_RENDER_LIMITS.maxOutputPixels / pixels),
  );
  return {
    width: evenDimension(source.width * scale),
    height: evenDimension(source.height * scale),
  };
}

function ffmpegNumber(value: number): string {
  return String(roundCreativeAssetTimelineSeconds(value));
}

// Caption text never enters a filter expression. Only a renderer-owned file
// path is escaped through FFmpeg's option and filtergraph parsing layers.
function ffmpegTextFilePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
}

function wrapCaption(value: string): string {
  return value
    .trim()
    .split(/\r\n|[\r\n]/u)
    .map(wrapCaptionLine)
    .join("\n");
}

function wrapCaptionLine(value: string): string {
  const lines: string[] = [];
  let current = "";
  for (const word of value.trim().split(/\s+/u)) {
    const letters = Array.from(word);
    while (letters.length > 26) {
      if (current) lines.push(current);
      lines.push(letters.splice(0, 26).join(""));
      current = "";
    }
    const remainder = letters.join("");
    if (Array.from(current).length + 1 + letters.length > 26) {
      if (current) lines.push(current);
      current = remainder;
    } else {
      current = current ? `${current} ${remainder}` : remainder;
    }
  }
  if (current) lines.push(current);
  return lines.join("\n");
}

function safeOutputName(fileName: string | null | undefined): string {
  const baseName = path
    .basename(readTrimmedString(fileName) || "timeline")
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
  return `${baseName || "timeline"}-timeline.mp4`;
}

async function runProcess(params: {
  command: string;
  args: string[];
  timeoutMs: number;
  phase: TimelineRenderProgress["phase"];
  abortSignal?: AbortSignal;
  onProgress?: (progress: TimelineRenderProgress) => void;
}): Promise<string> {
  const startedAt = Date.now();
  const result = await runBoundedProcess({
    command: params.command,
    args: params.args,
    timeoutMs: params.timeoutMs,
    signal: params.abortSignal,
    maxOutputBytes: 128 * 1024,
    pulseIntervalMs: TIMELINE_PROCESS_PULSE_INTERVAL_MS,
    onPulse: () =>
      params.onProgress?.({
        phase: params.phase,
        phaseElapsedMs: Date.now() - startedAt,
      }),
  });
  return result.stdout;
}

async function probeTimelineSource(
  source: TimelineRenderSource,
  params: {
    abortSignal?: AbortSignal;
    onProgress?: (progress: TimelineRenderProgress) => void;
  },
): Promise<TimelineRenderSourceMetadata> {
  const url = readTrimmedString(source.url);
  if (!url) {
    throw new TimelineRenderTerminalError(
      `Timeline source asset ${source.assetId} has no readable URL`,
    );
  }
  const stdout = await runProcess({
    command: "ffprobe",
    args: [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      url,
    ],
    timeoutMs: TIMELINE_PROBE_TIMEOUT_MS,
    phase: "probe",
    abortSignal: params.abortSignal,
    onProgress: params.onProgress,
  });
  const payload = JSON.parse(stdout) as FfprobePayload;
  const video = payload.streams?.find(
    (stream) => stream.codec_type === "video",
  );
  const isImage = source.kind === "image";
  const duration = isImage
    ? 0
    : positiveNumber(video?.duration) ||
      positiveNumber(payload.format?.duration);
  const width = positiveNumber(video?.width);
  const height = positiveNumber(video?.height);
  const fps = isImage
    ? 30
    : parseFrameRate(video?.avg_frame_rate) ||
      parseFrameRate(video?.r_frame_rate);
  if (!video || (!isImage && !duration) || !width || !height || !fps) {
    throw new TimelineRenderTerminalError(
      `FFprobe did not return usable metadata for timeline source ${source.assetId}`,
    );
  }

  return {
    assetId: source.assetId,
    url,
    fileName: readTrimmedString(source.fileName) || null,
    kind: source.kind || "video",
    duration: duration || 0,
    width,
    height,
    fps,
    hasAudio:
      !isImage &&
      Boolean(payload.streams?.some((stream) => stream.codec_type === "audio")),
  };
}

function validateTimeline(timeline: CreativeAssetTimeline): void {
  const [issue] = validateCreativeAssetTimeline(timeline, {
    allowCarriageReturns: true,
    clipEndToleranceSeconds: CREATIVE_ASSET_TIMELINE_PROBE_END_TOLERANCE_SECONDS,
  });
  if (!issue) return;
  const messages = {
    timeline: "Timeline render payload is invalid",
    canvas: "Timeline render canvas is invalid",
    audio_track: "Timeline render audio track is invalid",
    duration: "Timeline render duration is invalid",
    clip_count: "Timeline render clip count is invalid",
    source_count: `Timeline render can use at most ${CREATIVE_ASSET_TIMELINE_MAX_SOURCES} sources`,
    clip: "Timeline render clip or caption is invalid",
    duplicate_clip_id: "Timeline render clip or caption is invalid",
    clip_end: `Timeline clip ${timeline?.clips?.[Number(issue.path[1])]?.id} exceeds the render duration`,
  };
  throw new TimelineRenderTerminalError(messages[issue.code]);
}

export function buildTimelineFfmpegPlan(params: {
  timeline: CreativeAssetTimeline;
  sources: TimelineRenderSourceMetadata[];
  outputPath: string;
  captionTextFiles?: Record<string, string>;
}): {
  args: string[];
  filterComplex: string;
  width: number;
  height: number;
  fps: number;
} {
  validateTimeline(params.timeline);
  const sourcesById = new Map(
    params.sources.map((source, index) => [
      creativeAssetTimelineSourceKey(source.assetId),
      { source, inputIndex: index },
    ]),
  );
  const firstClip = [...params.timeline.clips].sort(
    (left, right) => left.timelineStart - right.timelineStart,
  )[0];
  const targetSource = firstClip
    ? sourcesById.get(creativeAssetTimelineSourceKey(firstClip.assetId))?.source
    : null;
  if (!targetSource) {
    throw new TimelineRenderTerminalError(
      "Timeline render is missing its first source asset",
    );
  }

  for (const source of params.sources) {
    const maxLongEdge =
      source.kind === "image"
        ? TIMELINE_RENDER_LIMITS.maxImageSourceLongEdge
        : TIMELINE_RENDER_LIMITS.maxSourceLongEdge;
    const maxPixels =
      source.kind === "image"
        ? TIMELINE_RENDER_LIMITS.maxImageSourcePixels
        : TIMELINE_RENDER_LIMITS.maxSourcePixels;
    if (
      Math.max(source.width, source.height) > maxLongEdge ||
      source.width * source.height > maxPixels
    ) {
      throw new TimelineRenderTerminalError(
        `Timeline source dimensions exceed the processing limit: ${source.width}x${source.height}`,
      );
    }
    if (source.fps > TIMELINE_RENDER_LIMITS.maxSourceFps) {
      throw new TimelineRenderTerminalError(
        `Timeline source frame rate exceeds the processing limit: ${source.fps}`,
      );
    }
  }

  const { width, height } =
    params.timeline.canvas === "9:16"
      ? { width: 720, height: 1280 }
      : resolveOutputDimensions(targetSource);
  const fps =
    params.timeline.canvas === "9:16"
      ? 30
      : Math.min(
          TIMELINE_RENDER_LIMITS.maxOutputFps,
          Math.max(1, roundCreativeAssetTimelineSeconds(targetSource.fps)),
        );
  const framePixelWork = width * height * fps * params.timeline.duration;
  if (framePixelWork > TIMELINE_RENDER_LIMITS.maxFramePixelWork) {
    throw new TimelineRenderTerminalError(
      "Timeline render exceeds the processing work limit",
    );
  }
  const timelineDuration = ffmpegNumber(params.timeline.duration);
  const sortedClips = [...params.timeline.clips].sort(
    (left, right) =>
      (left.trackId === "V1" ? 1 : 2) - (right.trackId === "V1" ? 1 : 2) ||
      left.timelineStart - right.timelineStart ||
      left.id.localeCompare(right.id),
  );
  const filters = [
    `color=c=black:s=${width}x${height}:r=${ffmpegNumber(fps)}:d=${timelineDuration},format=yuv420p[base]`,
  ];
  const audioLabels: string[] = [];
  const audioTrack =
    params.timeline.audioTrack ||
    (sortedClips.some((clip) => clip.trackId === "V2") ? "V2" : "V1");

  sortedClips.forEach((clip, clipIndex) => {
    const resolved = sourcesById.get(
      creativeAssetTimelineSourceKey(clip.assetId),
    );
    if (!resolved) {
      throw new TimelineRenderTerminalError(
        `Timeline source asset ${clip.assetId} was not provided`,
      );
    }
    const sourceEnd = clip.sourceStart + clip.duration;
    if (resolved.source.kind === "image" && clip.sourceStart !== 0) {
      throw new TimelineRenderTerminalError(
        "Timeline image source start must be zero",
      );
    }
    if (
      resolved.source.kind !== "image" &&
      sourceEnd >
        resolved.source.duration + CREATIVE_ASSET_TIMELINE_PROBE_END_TOLERANCE_SECONDS
    ) {
      throw new TimelineRenderTerminalError(
        `Timeline clip ${clip.id} exceeds source asset ${clip.assetId} duration`,
      );
    }

    const sourceStart = ffmpegNumber(clip.sourceStart);
    const sourceEndText = ffmpegNumber(sourceEnd);
    const timelineStart = ffmpegNumber(clip.timelineStart);
    const timelineEnd = ffmpegNumber(clip.timelineStart + clip.duration);
    const keyedForeground =
      clip.trackId === "V2" && clip.effect === "chroma_key";
    const padColor = keyedForeground ? "0x00ff00" : "black";
    const outputFormat = keyedForeground
      ? "format=rgba,colorkey=0x00ff00:0.24:0.08"
      : "format=yuv420p";
    let captionFilter = "";
    if (readTrimmedString(clip.caption)) {
      const textFile = params.captionTextFiles?.[clip.id];
      if (!textFile)
        throw new TimelineRenderTerminalError(
          "Timeline caption text file is missing",
        );
      const longestLine = Math.max(
        ...wrapCaption(clip.caption!)
          .split("\n")
          .map((line) => Array.from(line).length),
      );
      const fontSize = Math.max(
        1,
        Math.floor(Math.min(width * 0.05, (width * 0.86) / longestLine)),
      );
      captionFilter = `,drawtext=font=sans-serif:textfile='${ffmpegTextFilePath(textFile)}':expansion=none:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=${Math.max(1, Math.round(width * 0.015))}:line_spacing=${Math.round(fontSize * 0.25)}:x=(w-text_w)/2:y=h*0.84-text_h:fix_bounds=1`;
    }
    filters.push(
      `[${resolved.inputIndex}:v]trim=start=${sourceStart}:end=${sourceEndText},setpts=PTS-STARTPTS+${timelineStart}/TB,scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:${padColor},setsar=1,fps=${ffmpegNumber(fps)},${outputFormat}${captionFilter}[clipv${clipIndex}]`,
    );
    const previousVideo = clipIndex === 0 ? "base" : `video${clipIndex - 1}`;
    filters.push(
      `[${previousVideo}][clipv${clipIndex}]overlay=eof_action=pass:shortest=0:enable='between(t,${timelineStart},${timelineEnd})'[video${clipIndex}]`,
    );

    if (resolved.source.hasAudio && clip.trackId === audioTrack) {
      const delayMs = Math.max(0, Math.round(clip.timelineStart * 1000));
      filters.push(
        `[${resolved.inputIndex}:a]atrim=start=${sourceStart}:end=${sourceEndText},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs},apad=whole_dur=${timelineDuration}[clipa${clipIndex}]`,
      );
      audioLabels.push(`[clipa${clipIndex}]`);
    }
  });

  const finalVideo = `video${sortedClips.length - 1}`;
  if (audioLabels.length) {
    filters.push(
      `${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=1,atrim=start=0:end=${timelineDuration}[aout]`,
    );
  } else {
    filters.push(
      `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${timelineDuration}[aout]`,
    );
  }

  const filterComplex = filters.join(";");
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    ...params.sources.flatMap((source) =>
      source.kind === "image"
        ? ["-loop", "1", "-framerate", ffmpegNumber(fps), "-i", source.url]
        : ["-i", source.url],
    ),
    "-filter_complex",
    filterComplex,
    "-map",
    `[${finalVideo}]`,
    "-map",
    "[aout]",
    "-t",
    timelineDuration,
    "-r",
    ffmpegNumber(fps),
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
    "192k",
    "-ar",
    "48000",
    "-fs",
    String(TIMELINE_RENDER_LIMITS.maxOutputBytes),
    "-movflags",
    "+faststart",
    params.outputPath,
  ];

  return { args, filterComplex, width, height, fps };
}

export async function runTimelineRenderProcessor(input: {
  workspaceId: string;
  outputAssetId: string;
  timeline: CreativeAssetTimeline;
  sources: TimelineRenderSource[];
  abortSignal?: AbortSignal;
  onProgress?: (progress: TimelineRenderProgress) => void;
}): Promise<TimelineRenderProcessorResult> {
  validateTimeline(input.timeline);
  const sourceIds = new Set(
    input.sources.map((source) =>
      creativeAssetTimelineSourceKey(source.assetId),
    ),
  );
  if (sourceIds.size !== input.sources.length) {
    throw new TimelineRenderTerminalError(
      "Timeline render sources must be unique by asset id",
    );
  }

  const metadata: TimelineRenderSourceMetadata[] = [];
  for (let index = 0; index < input.sources.length; index += 1) {
    input.onProgress?.({
      phase: "probe",
      sourceIndex: index + 1,
      sourceCount: input.sources.length,
    });
    metadata.push(
      await probeTimelineSource(input.sources[index]!, {
        abortSignal: input.abortSignal,
        onProgress: input.onProgress,
      }),
    );
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "airi-timeline-render-"));
  const fileName = safeOutputName(metadata[0]?.fileName);
  const outputPath = path.join(workDir, fileName);
  let keepOutput = false;

  try {
    const captionTextFiles: Record<string, string> = Object.create(null);
    for (let index = 0; index < input.timeline.clips.length; index += 1) {
      const clip = input.timeline.clips[index]!;
      if (!readTrimmedString(clip.caption)) continue;
      const captionPath = path.join(workDir, `caption-${index}.txt`);
      await writeFile(captionPath, wrapCaption(clip.caption!), "utf8");
      captionTextFiles[clip.id] = captionPath;
    }
    let plan = buildTimelineFfmpegPlan({
      timeline: input.timeline,
      sources: metadata,
      outputPath,
      captionTextFiles,
    });
    const renderSources = metadata.map((source) => ({ ...source }));
    // Decode each original photo once, sequentially, after its bounds pass.
    // The multi-source composition then loops only small canvas-sized stills.
    for (let index = 0; index < renderSources.length; index += 1) {
      const source = renderSources[index]!;
      if (source.kind !== "image") continue;
      const imagePath = path.join(workDir, `image-${index}.png`);
      await runProcess({
        command: "ffmpeg",
        args: [
          "-hide_banner",
          "-loglevel",
          "error",
          "-threads",
          "1",
          "-i",
          source.url,
          "-frames:v",
          "1",
          "-vf",
          `scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1`,
          "-threads",
          "1",
          imagePath,
        ],
        timeoutMs: TIMELINE_PROBE_TIMEOUT_MS,
        phase: "encode",
        abortSignal: input.abortSignal,
        onProgress: input.onProgress,
      });
      source.url = imagePath;
    }
    if (renderSources.some((source) => source.kind === "image")) {
      plan = buildTimelineFfmpegPlan({
        timeline: input.timeline,
        sources: renderSources,
        outputPath,
        captionTextFiles,
      });
    }
    await runProcess({
      command: "ffmpeg",
      args: plan.args,
      timeoutMs: TIMELINE_RENDER_TIMEOUT_MS,
      phase: "encode",
      abortSignal: input.abortSignal,
      onProgress: input.onProgress,
    });
    const output = await stat(outputPath);
    if (output.size <= 0) {
      throw new TimelineRenderTerminalError(
        "Timeline renderer produced an empty video",
      );
    }
    if (output.size > TIMELINE_RENDER_LIMITS.maxOutputBytes) {
      throw new TimelineRenderTerminalError(
        "Timeline render output exceeds the processing size limit",
      );
    }
    input.onProgress?.({ phase: "output_verified" });
    keepOutput = true;
    let cleaned = false;

    return {
      outputPath,
      mimeType: "video/mp4",
      fileName,
      fileSize: output.size,
      providerPayload: {
        operation: "timeline_render",
        processor: "ffmpeg-timeline-renderer",
        outputContainerAndCodec: "mp4_h264_aac",
        preserveAudio: true,
        durationSeconds: input.timeline.duration,
        clipCount: input.timeline.clips.length,
        sourceCount: metadata.length,
        width: plan.width,
        height: plan.height,
        fps: plan.fps,
        timeline: input.timeline,
      },
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await rm(workDir, { recursive: true, force: true });
      },
    };
  } finally {
    if (!keepOutput) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

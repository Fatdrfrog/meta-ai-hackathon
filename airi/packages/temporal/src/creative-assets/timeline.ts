export const CREATIVE_ASSET_TIMELINE_MAX_CLIPS = 100;
export const CREATIVE_ASSET_TIMELINE_MAX_SOURCES = 20;
export const CREATIVE_ASSET_TIMELINE_MAX_DURATION_SECONDS = 2 * 60 * 60;
export const CREATIVE_ASSET_TIMELINE_MIN_CLIP_SECONDS = 0.25;
export const CREATIVE_ASSET_TIMELINE_MAX_CAPTION_LENGTH = 120;
export const CREATIVE_ASSET_TIMELINE_CLIP_END_TOLERANCE_SECONDS = 0.001;
// Media probes and frame boundaries have coarser precision than saved timelines.
export const CREATIVE_ASSET_TIMELINE_PROBE_END_TOLERANCE_SECONDS = 0.05;

export type CreativeAssetTimelineClip = {
  id: string;
  assetId: string;
  trackId: "V1" | "V2";
  timelineStart: number;
  sourceStart: number;
  duration: number;
  effect?: "chroma_key";
  /** Literal display text; rendered separately from FFmpeg expressions. */
  caption?: string;
};

export type CreativeAssetTimeline = {
  duration: number;
  /** Fixed portrait output. Omission preserves the first source dimensions. */
  canvas?: "9:16";
  audioTrack?: "V1" | "V2";
  clips: CreativeAssetTimelineClip[];
};

export type CreativeAssetTextValidationOptions = {
  /** Older worker payloads accept CR; new HTTP input rejects it. */
  allowCarriageReturns?: boolean;
};

export type CreativeAssetTimelineValidationOptions =
  CreativeAssetTextValidationOptions & {
    clipEndToleranceSeconds?: number;
  };

export type CreativeAssetTimelineValidationIssue = {
  code:
    | "timeline"
    | "canvas"
    | "audio_track"
    | "duration"
    | "clip_count"
    | "source_count"
    | "clip"
    | "duplicate_clip_id"
    | "clip_end";
  path: (string | number)[];
  message: string;
};

export function roundCreativeAssetTimelineSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Lookup identity only: keep approved timeline bytes and opaque IDs unchanged. */
export function creativeAssetTimelineSourceKey(assetId: string): string {
  return /^[a-f\d]{24}$/i.test(assetId) ? assetId.toLowerCase() : assetId;
}

export function normalizeCreativeAssetTimeline(
  timeline: CreativeAssetTimeline,
): CreativeAssetTimeline {
  const round = roundCreativeAssetTimelineSeconds;
  // Preserve field insertion and clip ordering: persisted fingerprints use JSON.
  return {
    duration: round(timeline.duration),
    ...(timeline.canvas ? { canvas: timeline.canvas } : {}),
    ...(timeline.audioTrack ? { audioTrack: timeline.audioTrack } : {}),
    clips: timeline.clips
      .map((clip) => ({
        ...clip,
        timelineStart: round(clip.timelineStart),
        sourceStart: round(clip.sourceStart),
        duration: round(clip.duration),
      }))
      .sort(
        (left, right) =>
          left.trackId.localeCompare(right.trackId) ||
          left.timelineStart - right.timelineStart ||
          left.id.localeCompare(right.id),
      ),
  };
}

export function hasUnsupportedCreativeAssetTextCharacters(
  value: string,
  options: CreativeAssetTextValidationOptions = {},
): boolean {
  return options.allowCarriageReturns
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    : /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value);
}

export function isCreativeAssetTimelineCaption(
  value: unknown,
  options: CreativeAssetTextValidationOptions = {},
): value is string {
  return (
    typeof value === "string" &&
    value.length <= CREATIVE_ASSET_TIMELINE_MAX_CAPTION_LENGTH &&
    !hasUnsupportedCreativeAssetTextCharacters(value, options)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumberAtLeast(
  value: unknown,
  minimum: number,
): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= minimum
  );
}

/** Portable semantics; transport parsers own ID formats and field stripping. */
export function validateCreativeAssetTimeline(
  value: unknown,
  options: CreativeAssetTimelineValidationOptions = {},
): CreativeAssetTimelineValidationIssue[] {
  const issues: CreativeAssetTimelineValidationIssue[] = [];
  const add = (
    code: CreativeAssetTimelineValidationIssue["code"],
    path: CreativeAssetTimelineValidationIssue["path"],
    message: string,
  ) => {
    issues.push({ code, path, message });
  };
  if (!isRecord(value)) {
    add("timeline", [], "Timeline payload is invalid");
    return issues;
  }
  if (value.canvas !== undefined && value.canvas !== "9:16")
    add("canvas", ["canvas"], "Timeline canvas is invalid");
  if (
    value.audioTrack !== undefined &&
    value.audioTrack !== "V1" &&
    value.audioTrack !== "V2"
  )
    add("audio_track", ["audioTrack"], "Timeline audio track is invalid");
  const validDuration =
    isFiniteNumberAtLeast(
      value.duration,
      CREATIVE_ASSET_TIMELINE_MIN_CLIP_SECONDS,
    ) && value.duration <= CREATIVE_ASSET_TIMELINE_MAX_DURATION_SECONDS;
  if (!validDuration)
    add("duration", ["duration"], "Timeline duration is invalid");
  if (
    !Array.isArray(value.clips) ||
    value.clips.length < 1 ||
    value.clips.length > CREATIVE_ASSET_TIMELINE_MAX_CLIPS
  ) {
    add("clip_count", ["clips"], "Timeline clip count is invalid");
    return issues;
  }

  const clipIds = new Set<string>();
  const sourceIds = new Set<string>();
  const tolerance =
    options.clipEndToleranceSeconds ??
    CREATIVE_ASSET_TIMELINE_CLIP_END_TOLERANCE_SECONDS;
  value.clips.forEach((clip: unknown, index: number) => {
    if (!isRecord(clip)) {
      add("clip", ["clips", index], "Timeline clip is invalid");
      return;
    }
    for (const field of ["id", "assetId"] as const) {
      const id = clip[field];
      if (typeof id !== "string" || !id.trim())
        add(
          "clip",
          ["clips", index, field],
          `Timeline clip ${field} is invalid`,
        );
    }
    if (typeof clip.id === "string") {
      if (clipIds.has(clip.id))
        add(
          "duplicate_clip_id",
          ["clips", index, "id"],
          "Timeline clip ids must be unique",
        );
      clipIds.add(clip.id);
    }
    if (typeof clip.assetId === "string")
      sourceIds.add(creativeAssetTimelineSourceKey(clip.assetId));
    if (clip.trackId !== "V1" && clip.trackId !== "V2")
      add(
        "clip",
        ["clips", index, "trackId"],
        "Timeline clip track is invalid",
      );
    for (const field of ["timelineStart", "sourceStart", "duration"] as const) {
      const minimum =
        field === "duration" ? CREATIVE_ASSET_TIMELINE_MIN_CLIP_SECONDS : 0;
      if (!isFiniteNumberAtLeast(clip[field], minimum))
        add(
          "clip",
          ["clips", index, field],
          `Timeline clip ${field} is invalid`,
        );
    }
    if (clip.effect !== undefined && clip.effect !== "chroma_key")
      add(
        "clip",
        ["clips", index, "effect"],
        "Timeline clip effect is invalid",
      );
    if (
      clip.caption !== undefined &&
      !isCreativeAssetTimelineCaption(clip.caption, options)
    )
      add(
        "clip",
        ["clips", index, "caption"],
        "Timeline clip caption is invalid",
      );
    if (
      validDuration &&
      isFiniteNumberAtLeast(clip.timelineStart, 0) &&
      isFiniteNumberAtLeast(
        clip.duration,
        CREATIVE_ASSET_TIMELINE_MIN_CLIP_SECONDS,
      ) &&
      clip.timelineStart + clip.duration >
        (value.duration as number) + tolerance
    )
      add(
        "clip_end",
        ["clips", index, "duration"],
        "Timeline clip exceeds the render duration",
      );
  });
  if (sourceIds.size > CREATIVE_ASSET_TIMELINE_MAX_SOURCES)
    add(
      "source_count",
      ["clips"],
      `Timeline can reference at most ${CREATIVE_ASSET_TIMELINE_MAX_SOURCES} source assets`,
    );
  return issues;
}

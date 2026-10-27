export type TimelineTrackId = "V2" | "V1" | "A1";
export type TimelineClipOrigin = "source" | "bria" | "matte" | "audio" | "user";
export type TimelineClipKind = "image" | "video" | "audio" | "text";
export type TimelineTrimEdge = "start" | "end";

export type TimelineClip = {
  id: string;
  assetId: string;
  trackId: TimelineTrackId;
  label: string;
  start: number;
  sourceStart: number;
  duration: number;
  effect?: "chroma_key";
  kind: TimelineClipKind;
  origin: TimelineClipOrigin;
  operation?: "green" | "remove" | "replace" | "upscale";
  locked?: boolean;
};

export type TimelineRenderClip = {
  id: string;
  assetId: string;
  trackId: "V1" | "V2";
  timelineStart: number;
  sourceStart: number;
  duration: number;
};

export type TimelineRender = {
  duration: number;
  audioTrack: "V1" | "V2";
  clips: TimelineRenderClip[];
};

export type TimelineMutationResult = {
  clips: TimelineClip[];
  selectedClipId: string;
};

export const MIN_TIMELINE_SEGMENT_SECONDS = 0.25;
const SNAP_THRESHOLD_SECONDS = 0.2;

export function shouldPreserveTimelineClips(params: {
  clips: TimelineClip[];
  sourceAssetId: string;
  historyLength: number;
}): boolean {
  return (
    params.historyLength > 0 ||
    params.clips.some(
      clip =>
        clip.origin === "user" ||
        (clip.origin === "bria" && clip.assetId !== params.sourceAssetId)
    )
  );
}

export function bindTimelineAsset(
  clips: TimelineClip[],
  params: {
    sourceAssetId: string;
    outputAssetId: string;
    origin: TimelineClipOrigin;
  }
): TimelineClip[] {
  let changed = false;
  const nextClips = clips.map(clip => {
    if (
      clip.origin !== params.origin ||
      clip.assetId !== params.sourceAssetId
    ) {
      return clip;
    }
    changed = true;
    return { ...clip, assetId: params.outputAssetId };
  });
  return changed ? nextClips : clips;
}

function roundTime(value: number, snapEnabled: boolean): number {
  if (!Number.isFinite(value)) return 0;
  const precision = snapEnabled ? 10 : 100;
  return Math.round(value * precision) / precision;
}

export function isEditableTimelineClip(
  clip: TimelineClip | null | undefined
): clip is TimelineClip {
  return Boolean(
    clip &&
      !clip.locked &&
      clip.kind === "video" &&
      (clip.trackId === "V1" || clip.trackId === "V2")
  );
}

function nearestSnapDelta(params: {
  clips: TimelineClip[];
  clipId: string;
  candidateEdges: number[];
}): number | null {
  const editPoints = params.clips.flatMap(clip =>
    clip.id === params.clipId ? [] : [clip.start, clip.start + clip.duration]
  );
  let closest: number | null = null;
  for (const candidate of params.candidateEdges) {
    for (const editPoint of editPoints) {
      const delta = editPoint - candidate;
      if (Math.abs(delta) > SNAP_THRESHOLD_SECONDS) continue;
      if (closest === null || Math.abs(delta) < Math.abs(closest)) {
        closest = delta;
      }
    }
  }
  return closest;
}

export function splitTimelineClip(params: {
  clips: TimelineClip[];
  selectedClipId: string | null;
  time: number;
  snapEnabled: boolean;
  newClipId: string;
}): TimelineMutationResult | null {
  const splitTime = roundTime(params.time, params.snapEnabled);
  const clipToSplit = findTimelineSplitClip(
    params.clips,
    params.selectedClipId,
    splitTime
  );
  if (!clipToSplit) return null;

  const firstDuration = splitTime - clipToSplit.start;
  const secondClip: TimelineClip = {
    ...clipToSplit,
    id: params.newClipId,
    label: `${clipToSplit.label}.2`,
    start: splitTime,
    sourceStart: clipToSplit.sourceStart + firstDuration,
    duration: clipToSplit.duration - firstDuration,
  };

  return {
    clips: params.clips.flatMap(clip =>
      clip.id === clipToSplit.id
        ? [{ ...clipToSplit, duration: firstDuration }, secondClip]
        : [clip]
    ),
    selectedClipId: secondClip.id,
  };
}

export function findTimelineSplitClip(
  clips: TimelineClip[],
  selectedClipId: string | null,
  time: number
): TimelineClip | null {
  const canSplit = (clip: TimelineClip) =>
    isEditableTimelineClip(clip) &&
    time >= clip.start + MIN_TIMELINE_SEGMENT_SECONDS &&
    time <= clip.start + clip.duration - MIN_TIMELINE_SEGMENT_SECONDS;
  const selected = clips.find(
    clip => clip.id === selectedClipId && canSplit(clip)
  );
  return selected || clips.find(canSplit) || null;
}

export function moveTimelineClip(params: {
  clips: TimelineClip[];
  clipId: string;
  start: number;
  snapEnabled: boolean;
}): TimelineMutationResult | null {
  const clip = params.clips.find(item => item.id === params.clipId);
  if (!isEditableTimelineClip(clip)) return null;

  let start = Math.max(0, roundTime(params.start, params.snapEnabled));
  if (params.snapEnabled) {
    const delta = nearestSnapDelta({
      clips: params.clips,
      clipId: clip.id,
      candidateEdges: [start, start + clip.duration],
    });
    if (delta !== null) start = Math.max(0, roundTime(start + delta, true));
  }
  if (Math.abs(start - clip.start) < 0.005) return null;

  return {
    clips: params.clips.map(item =>
      item.id === clip.id ? { ...item, start } : item
    ),
    selectedClipId: clip.id,
  };
}

export function trimTimelineClip(params: {
  clips: TimelineClip[];
  clipId: string;
  edge: TimelineTrimEdge;
  time: number;
  snapEnabled: boolean;
}): TimelineMutationResult | null {
  const clip = params.clips.find(item => item.id === params.clipId);
  if (!isEditableTimelineClip(clip)) return null;

  const clipEnd = clip.start + clip.duration;
  let edgeTime = roundTime(params.time, params.snapEnabled);
  if (params.snapEnabled) {
    const delta = nearestSnapDelta({
      clips: params.clips,
      clipId: clip.id,
      candidateEdges: [edgeTime],
    });
    if (delta !== null) edgeTime = roundTime(edgeTime + delta, true);
  }

  let updated: TimelineClip;
  if (params.edge === "start") {
    const nextStart = Math.min(
      clipEnd - MIN_TIMELINE_SEGMENT_SECONDS,
      Math.max(clip.start, edgeTime)
    );
    const delta = nextStart - clip.start;
    if (delta < 0.005) return null;
    updated = {
      ...clip,
      start: nextStart,
      sourceStart: clip.sourceStart + delta,
      duration: clip.duration - delta,
    };
  } else {
    const nextEnd = Math.max(
      clip.start + MIN_TIMELINE_SEGMENT_SECONDS,
      Math.min(clipEnd, edgeTime)
    );
    if (clipEnd - nextEnd < 0.005) return null;
    updated = { ...clip, duration: nextEnd - clip.start };
  }

  return {
    clips: params.clips.map(item => (item.id === clip.id ? updated : item)),
    selectedClipId: clip.id,
  };
}

export function getTimelineDuration(
  clips: TimelineClip[],
  minimumDuration = 0
): number {
  const maxEnd = clips.reduce(
    (result, clip) => Math.max(result, clip.start + clip.duration),
    0
  );
  return Math.max(MIN_TIMELINE_SEGMENT_SECONDS, minimumDuration, maxEnd);
}

export function resolveTimelineFrame(
  clips: TimelineClip[],
  timelineTime: number
): { clip: TimelineClip; sourceTime: number } | null {
  const videoClips = clips.filter(
    clip =>
      clip.kind === "video" && (clip.trackId === "V1" || clip.trackId === "V2")
  );
  const editableClips = videoClips.filter(isEditableTimelineClip);
  const programClips = editableClips.length ? editableClips : videoClips;
  const activeClips = programClips.filter(
    clip =>
      timelineTime >= clip.start && timelineTime < clip.start + clip.duration
  );
  if (!activeClips.length) return null;

  const clip = activeClips.reduce((visible, candidate) => {
    const visiblePriority = visible.trackId === "V2" ? 2 : 1;
    const candidatePriority = candidate.trackId === "V2" ? 2 : 1;
    return candidatePriority >= visiblePriority ? candidate : visible;
  });

  return {
    clip,
    sourceTime: clip.sourceStart + (timelineTime - clip.start),
  };
}

export function resolveNextTimelineFrame(
  clips: TimelineClip[],
  afterTime: number
): {
  timelineTime: number;
  clip: TimelineClip;
  sourceTime: number;
} | null {
  const videoClips = clips.filter(
    clip =>
      clip.kind === "video" && (clip.trackId === "V1" || clip.trackId === "V2")
  );
  const editableClips = videoClips.filter(isEditableTimelineClip);
  const programClips = editableClips.length ? editableClips : videoClips;
  const nextStart = programClips
    .map(clip => clip.start)
    .filter(start => start >= afterTime - 0.005)
    .reduce<number | null>(
      (closest, start) =>
        closest === null || start < closest ? start : closest,
      null
    );
  if (nextStart === null) return null;
  const frame = resolveTimelineFrame(programClips, nextStart);
  return frame ? { timelineTime: nextStart, ...frame } : null;
}

export function buildTimelineRender(
  clips: TimelineClip[],
  minimumDuration = 0
): TimelineRender {
  const editable = clips.filter(isEditableTimelineClip);
  const programClips = editable.length
    ? editable
    : clips.filter(
        clip =>
          clip.kind === "video" &&
          (clip.trackId === "V1" || clip.trackId === "V2")
      );
  const duration = getTimelineDuration(programClips, minimumDuration);
  const trackOrder: Record<"V1" | "V2", number> = { V1: 1, V2: 2 };

  return {
    duration,
    audioTrack: programClips.some(clip => clip.trackId === "V2") ? "V2" : "V1",
    clips: programClips
      .map(clip => ({
        id: clip.id,
        assetId: clip.assetId,
        trackId: clip.trackId as "V1" | "V2",
        timelineStart: clip.start,
        sourceStart: clip.sourceStart,
        duration: clip.duration,
        ...(clip.trackId === "V2" &&
        (clip.origin === "bria" || clip.operation === "green")
          ? { effect: "chroma_key" as const }
          : {}),
      }))
      .sort(
        (left, right) =>
          trackOrder[left.trackId] - trackOrder[right.trackId] ||
          left.timelineStart - right.timelineStart ||
          left.id.localeCompare(right.id)
      ),
  };
}

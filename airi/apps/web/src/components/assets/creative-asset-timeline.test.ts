import {
  bindTimelineAsset,
  buildTimelineRender,
  getTimelineDuration,
  moveTimelineClip,
  resolveNextTimelineFrame,
  resolveTimelineFrame,
  shouldPreserveTimelineClips,
  splitTimelineClip,
  trimTimelineClip,
  type TimelineClip,
} from "./creative-asset-timeline";

const sourceClip: TimelineClip = {
  id: "source-1",
  assetId: "asset-1",
  trackId: "V1",
  label: "source",
  start: 0,
  sourceStart: 0,
  duration: 20,
  kind: "video",
  origin: "source",
  locked: true,
};

const editableClip: TimelineClip = {
  id: "clip-1",
  assetId: "asset-1",
  trackId: "V2",
  label: "C1",
  start: 0,
  sourceStart: 5,
  duration: 10,
  kind: "video",
  origin: "bria",
};

describe("creative asset timeline", () => {
  it("preserves timeline clips after edits or generated-output binding", () => {
    expect(
      shouldPreserveTimelineClips({
        clips: [sourceClip, editableClip],
        sourceAssetId: "asset-1",
        historyLength: 1,
      })
    ).toBe(true);
    expect(
      shouldPreserveTimelineClips({
        clips: [sourceClip, { ...editableClip, assetId: "green-1" }],
        sourceAssetId: "asset-1",
        historyLength: 0,
      })
    ).toBe(true);
    expect(
      shouldPreserveTimelineClips({
        clips: [sourceClip, editableClip],
        sourceAssetId: "asset-1",
        historyLength: 0,
      })
    ).toBe(false);
  });

  it("binds generated chunks to their completed derivative", () => {
    expect(
      bindTimelineAsset([sourceClip, editableClip], {
        sourceAssetId: "asset-1",
        outputAssetId: "green-1",
        origin: "bria",
      })
    ).toEqual([sourceClip, { ...editableClip, assetId: "green-1" }]);
  });

  it("splits a clip without losing its source offset", () => {
    const result = splitTimelineClip({
      clips: [sourceClip, editableClip],
      selectedClipId: editableClip.id,
      time: 4,
      snapEnabled: false,
      newClipId: "clip-2",
    });

    expect(result).not.toBeNull();
    expect(result?.selectedClipId).toBe("clip-2");
    expect(result?.clips).toEqual([
      sourceClip,
      { ...editableClip, duration: 4 },
      {
        ...editableClip,
        id: "clip-2",
        label: "C1.2",
        start: 4,
        sourceStart: 9,
        duration: 6,
      },
    ]);
  });

  it("trims clip edges while preserving the source-to-timeline mapping", () => {
    const startTrim = trimTimelineClip({
      clips: [editableClip],
      clipId: editableClip.id,
      edge: "start",
      time: 2.5,
      snapEnabled: false,
    });
    expect(startTrim?.clips[0]).toMatchObject({
      start: 2.5,
      sourceStart: 7.5,
      duration: 7.5,
    });

    const endTrim = trimTimelineClip({
      clips: startTrim?.clips || [],
      clipId: editableClip.id,
      edge: "end",
      time: 8,
      snapEnabled: false,
    });
    expect(endTrim?.clips[0]).toMatchObject({
      start: 2.5,
      sourceStart: 7.5,
      duration: 5.5,
    });
  });

  it("snaps moved clips to nearby edit points and lets the timeline grow", () => {
    const neighbor: TimelineClip = {
      ...editableClip,
      id: "neighbor",
      start: 12,
      sourceStart: 15,
      duration: 4,
    };
    const result = moveTimelineClip({
      clips: [editableClip, neighbor],
      clipId: editableClip.id,
      start: 1.92,
      snapEnabled: true,
    });

    expect(result?.clips[0]?.start).toBe(2);
    expect(getTimelineDuration(result?.clips || [], 20)).toBe(20);

    const extended = moveTimelineClip({
      clips: result?.clips || [],
      clipId: neighbor.id,
      start: 22,
      snapEnabled: false,
    });
    expect(getTimelineDuration(extended?.clips || [], 20)).toBe(26);
  });

  it("resolves the visible top track and corresponding source time", () => {
    const lower: TimelineClip = {
      ...editableClip,
      id: "lower",
      trackId: "V1",
      assetId: "asset-lower",
      start: 2,
      sourceStart: 20,
    };
    const upper: TimelineClip = {
      ...editableClip,
      id: "upper",
      assetId: "asset-upper",
      start: 3,
      sourceStart: 30,
    };

    expect(resolveTimelineFrame([sourceClip, lower, upper], 5)).toEqual({
      clip: upper,
      sourceTime: 32,
    });
    expect(resolveTimelineFrame([sourceClip], 5)).toEqual({
      clip: sourceClip,
      sourceTime: 5,
    });
  });

  it("advances playback across a timeline gap", () => {
    const later: TimelineClip = {
      ...editableClip,
      id: "later",
      start: 12,
      sourceStart: 7,
      duration: 3,
    };

    expect(resolveNextTimelineFrame([editableClip, later], 10)).toEqual({
      timelineTime: 12,
      clip: later,
      sourceTime: 7,
    });
    expect(resolveNextTimelineFrame([editableClip], 10)).toBeNull();
  });

  it("serializes editable video layers for a deterministic render", () => {
    const lower: TimelineClip = {
      ...editableClip,
      id: "lower",
      trackId: "V1",
      assetId: "asset-2",
      start: 10,
      sourceStart: 3,
      duration: 5,
    };

    expect(buildTimelineRender([sourceClip, editableClip, lower], 20)).toEqual({
      duration: 20,
      audioTrack: "V2",
      clips: [
        {
          id: "lower",
          assetId: "asset-2",
          trackId: "V1",
          timelineStart: 10,
          sourceStart: 3,
          duration: 5,
        },
        {
          id: "clip-1",
          assetId: "asset-1",
          trackId: "V2",
          timelineStart: 0,
          sourceStart: 5,
          duration: 10,
          effect: "chroma_key",
        },
      ],
    });
  });

  it("falls back to the locked source when no editable video remains", () => {
    expect(buildTimelineRender([sourceClip], 20)).toEqual({
      duration: 20,
      audioTrack: "V1",
      clips: [
        {
          id: "source-1",
          assetId: "asset-1",
          trackId: "V1",
          timelineStart: 0,
          sourceStart: 0,
          duration: 20,
        },
      ],
    });
  });
});

import { buildReferenceVideoPlanSnapshot } from "./plan";

const input = () => ({
  recipeId: "product-reveal",
  title: "Our new collection",
  scenes: Array.from({ length: 3 }, (_, index) => ({
    assetId: "64c13ab08edf48a008793cab",
    caption: `Scene ${index + 1}`,
    sourceStart: 0,
  })),
});

describe("reference video plans", () => {
  it("compiles reviewed assets and literal captions into a bounded portrait timeline", () => {
    const snapshot = buildReferenceVideoPlanSnapshot(input());
    expect(snapshot.timeline.canvas).toBe("9:16");
    expect(snapshot.timeline.clips.map(clip => clip.caption)).toEqual([
      "Scene 1",
      "Scene 2",
      "Scene 3",
    ]);
    expect(snapshot.timeline.clips.map(clip => clip.timelineStart)).toEqual([
      0, 3, 7,
    ]);
    expect(snapshot.duration).toBe(11);
    expect(snapshot.cost).toEqual({
      amount: 0,
      currency: "USD",
      generatedSeconds: 0,
    });
  });

  it("normalizes trim precision and detaches the snapshot from mutable inputs", () => {
    const value = input();
    value.scenes[0].sourceStart = 1.23456;
    const snapshot = buildReferenceVideoPlanSnapshot(value);
    value.scenes[0].caption = "Changed after review";
    value.scenes.reverse();
    expect(snapshot.scenes[0].sourceStart).toBe(1.235);
    expect(snapshot.timeline.clips[0]).toMatchObject({
      id: "hook",
      sourceStart: 1.235,
      caption: "Scene 1",
      duration: 3,
      timelineStart: 0,
      trackId: "V1",
    });
  });
});

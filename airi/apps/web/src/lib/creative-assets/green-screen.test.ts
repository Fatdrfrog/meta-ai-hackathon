import { isRetryableAiriGreenScreenAsset } from "./green-screen";

describe("green-screen asset classification", () => {
  it("does not classify a timeline render as a green-screen derivative", () => {
    expect(
      isRetryableAiriGreenScreenAsset({
        source: "edited",
        provider: "airi",
        modelId: "airi-timeline-render-v1",
        sourceAssetId: "source-1",
        status: "complete",
      })
    ).toBe(false);
  });
});

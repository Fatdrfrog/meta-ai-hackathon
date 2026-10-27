import {
  readScenarioMediaIdentity,
  resolveScenarioMediaDisplayUrl,
} from "./media-display-url";

describe("resolveScenarioMediaDisplayUrl", () => {
  it.each([
    ["https://storage.googleapis.com/bucket/a.png?X-Goog-Signature=1"],
    ["http://localhost:3000/media/a.png"],
    ["blob:https://app.example/1234"],
    ["data:image/png;base64,AAAA"],
    ["/whatsapp.svg"],
  ])("shows %s", url => {
    expect(resolveScenarioMediaDisplayUrl(url)).toBe(url);
    expect(resolveScenarioMediaDisplayUrl({ url })).toBe(url);
  });

  it.each([
    ["gcs://bucket/workspace/a.png"],
    ["gs://bucket/workspace/a.png"],
    [""],
    ["   "],
  ])("waits for a signed URL for %j", url => {
    expect(resolveScenarioMediaDisplayUrl(url)).toBeNull();
  });

  it("waits for a bucket and path whose URL is not signed yet", () => {
    expect(
      resolveScenarioMediaDisplayUrl({
        url: "gcs://bucket/workspace/a.png",
        bucket: "bucket",
        path: "workspace/a.png",
      } as { url: string })
    ).toBeNull();
    expect(resolveScenarioMediaDisplayUrl({ url: null })).toBeNull();
    expect(resolveScenarioMediaDisplayUrl(undefined)).toBeNull();
  });
});

describe("readScenarioMediaIdentity", () => {
  it("stays the same when a durable ref is shown signed", () => {
    const durable = {
      url: "gcs://bucket/workspace/a.png",
      bucket: "bucket",
      path: "workspace/a.png",
    };
    const signed = {
      ...durable,
      url: "https://storage.googleapis.com/bucket/workspace/a.png?X-Goog-Signature=1",
    };

    expect(readScenarioMediaIdentity(signed)).toBe(
      readScenarioMediaIdentity(durable)
    );
    expect(
      readScenarioMediaIdentity({ ...durable, path: "workspace/b.png" })
    ).not.toBe(readScenarioMediaIdentity(durable));
  });

  it("uses the URL of media without a bucket and path", () => {
    expect(readScenarioMediaIdentity({ url: " https://cdn/a.png " })).toBe(
      "https://cdn/a.png"
    );
    expect(readScenarioMediaIdentity("https://cdn/a.png")).toBe(
      "https://cdn/a.png"
    );
    expect(readScenarioMediaIdentity({ url: "", bucket: "b" })).toBeNull();
    expect(readScenarioMediaIdentity(undefined)).toBeNull();
  });
});

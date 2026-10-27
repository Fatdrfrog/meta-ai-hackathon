import {
  isScenarioGenericActionAttachment,
  normalizeScenarioActionAttachments,
} from "@/lib/scenarios/action-attachments";

describe("scenario action attachments", () => {
  it("skips malformed raw generated assets while retaining valid media", () => {
    expect(
      normalizeScenarioActionAttachments({
        generatedAssets: [
          null,
          7,
          { kind: "image", url: "https://cdn.test/image.jpg" },
        ],
      })
    ).toEqual([{ url: "https://cdn.test/image.jpg", mediaType: "image" }]);
  });

  it("rejects explicit service-only media from generic persisted attachments", () => {
    const attachments = normalizeScenarioActionAttachments({
      attachments: [
        { url: "https://cdn.test/image.jpg", mediaType: "image" },
        { url: "https://cdn.test/audio.ogg", mediaType: "audio" },
      ],
      legacyUrls: ["https://cdn.test/audio.ogg"],
      limit: 2,
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      url: "https://cdn.test/image.jpg",
      mediaType: "image",
    });
    expect(attachments.every(isScenarioGenericActionAttachment)).toBe(true);
    expect(
      isScenarioGenericActionAttachment({
        url: "https://cdn.test/audio.ogg",
        mediaType: "audio",
      })
    ).toBe(false);
  });

  it("accepts durable gcs:// refs and canonicalizes bucket+path", () => {
    const attachments = normalizeScenarioActionAttachments({
      attachments: [
        {
          url: "https://signed.example/temp.jpg",
          mediaType: "image",
          bucket: "icecore-ai-creative-assets-prod",
          path: "workspaces/w1/creative-assets/image/a/file.jpg",
        },
      ],
    });

    expect(attachments).toEqual([
      {
        url: "gcs://icecore-ai-creative-assets-prod/workspaces/w1/creative-assets/image/a/file.jpg",
        mediaType: "image",
        bucket: "icecore-ai-creative-assets-prod",
        path: "workspaces/w1/creative-assets/image/a/file.jpg",
      },
    ]);
  });
});

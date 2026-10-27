import {
  canonicalizeScenarioActionAttachment,
  canonicalizeScenarioAssetUrl,
  canonicalizeScenarioNodeMediaForPersistence,
} from "@/lib/scenarios/scenario-asset-refs";

describe("scenario-asset-refs", () => {
  it("canonicalizes service attachments and rebuilds legacy image URLs from attachments only", () => {
    const owned = {
      url: "https://signed.example/expired",
      mediaType: "image",
      bucket: "media",
      path: "workspaces/w1/creative-assets/image/a/file.jpg",
    };
    const durable = {
      ...owned,
      url: "gcs://media/workspaces/w1/creative-assets/image/a/file.jpg",
    };
    const mediaAsset = {
      id: "asset",
      url: "https://signed.example/asset",
      bucket: "media",
      path: "workspaces/w1/creative-assets/image/a/asset.jpg",
    };
    expect(
      canonicalizeScenarioNodeMediaForPersistence({
        actionAttachments: [owned, { url: "", mediaType: "image" }],
        actionImageUrls: ["https://signed.example/stale"],
        actionMediaAssets: [mediaAsset],
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            attachment: owned,
            header: { kind: "media", attachment: owned },
          },
        },
      })
    ).toEqual({
      actionAttachments: [durable, { url: "", mediaType: "image" }],
      actionImageUrls: [durable.url],
      actionMediaAssets: [mediaAsset],
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          attachment: durable,
          header: { kind: "media", attachment: durable },
        },
      },
    });
  });

  it("persists image-generation references with durable ownership instead of signed preview URLs", () => {
    const next = canonicalizeScenarioNodeMediaForPersistence({
      actionGenerativeAIConfig: {
        version: 1,
        mode: "text_to_image",
        prompt: "Keep medal geometry",
        image: {
          modelId: "gemini-3.1-flash-image",
          referenceImages: [
            {
              url: "https://signed.example/expired",
              mediaType: "image",
              bucket: "media",
              path: "workspaces/w1/creative-assets/image/a/file.jpg",
            },
          ],
        },
      },
    });
    expect(next).toMatchObject({
      actionGenerativeAIConfig: {
        prompt: "Keep medal geometry",
        image: {
          referenceImages: [
            {
              url: "gcs://media/workspaces/w1/creative-assets/image/a/file.jpg",
            },
          ],
        },
      },
    });
  });
  it("canonicalizes bucket+path to gcs://", () => {
    expect(
      canonicalizeScenarioAssetUrl({
        url: "https://signed.example/expired",
        bucket: "icecore-ai-creative-assets-prod",
        path: "workspaces/w1/creative-assets/image/a/file.jpg",
      })
    ).toBe(
      "gcs://icecore-ai-creative-assets-prod/workspaces/w1/creative-assets/image/a/file.jpg"
    );
  });

  it("keeps legacy https urls without bucket/path", () => {
    expect(
      canonicalizeScenarioAssetUrl({
        url: "https://cdn.example.com/legacy.jpg",
      })
    ).toBe("https://cdn.example.com/legacy.jpg");
  });

  it("rewrites service message carousel media on persistence", () => {
    const next = canonicalizeScenarioNodeMediaForPersistence({
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "media_carousel",
          body: { mode: "fixed", text: "hi" },
          cards: [
            {
              id: "c1",
              media: {
                url: "https://signed.example/card.jpg",
                mediaType: "image",
                bucket: "b",
                path: "p/card.jpg",
              },
              interaction: {
                kind: "quick_replies",
                options: [{ id: "o1", label: "Ok" }],
              },
            },
          ],
        },
      },
    });

    expect(
      (
        next.actionWhatsAppServiceMessage as {
          message: { cards: Array<{ media: { url: string } }> };
        }
      ).message.cards[0].media.url
    ).toBe("gcs://b/p/card.jpg");
  });

  it("canonicalizes attachments", () => {
    expect(
      canonicalizeScenarioActionAttachment({
        url: "https://signed.example/x.png",
        mediaType: "image",
        bucket: "bucket",
        path: "workspaces/w/file.png",
      })
    ).toMatchObject({
      url: "gcs://bucket/workspaces/w/file.png",
      bucket: "bucket",
      path: "workspaces/w/file.png",
    });
  });
});

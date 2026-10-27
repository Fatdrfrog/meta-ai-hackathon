import {
  airiChatAttachmentSchema,
  airiChatMessageBodySchema,
} from "./request-schemas";

describe("Airi chat request schemas", () => {
  it("accepts the Meta Ads skill source emitted by the composer", () => {
    expect(
      airiChatMessageBodySchema.safeParse({
        content: "@meta show campaign performance",
        selectedSources: [{ kind: "skill", skillId: "meta", label: "meta" }],
      }).success
    ).toBe(true);
  });

  it("accepts durable Creative Asset references without applying upload size limits", () => {
    expect(
      airiChatAttachmentSchema.safeParse({
        name: "launch.mp4",
        type: "video/mp4",
        size: 80 * 1024 * 1024,
        creativeAssetId: "507f1f77bcf86cd799439011",
      }).success
    ).toBe(true);
  });

  it("still rejects oversized browser file metadata and malformed asset ids", () => {
    expect(
      airiChatAttachmentSchema.safeParse({
        name: "large.mp4",
        type: "video/mp4",
        size: 80 * 1024 * 1024,
      }).success
    ).toBe(false);
    expect(
      airiChatAttachmentSchema.safeParse({
        name: "launch.jpg",
        type: "image/jpeg",
        size: 1200,
        creativeAssetId: "not-an-object-id",
      }).success
    ).toBe(false);
  });
});

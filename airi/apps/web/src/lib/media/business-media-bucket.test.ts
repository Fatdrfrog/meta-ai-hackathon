import {
  BUSINESS_MEDIA_BUCKET,
  BUSINESS_MEDIA_FILE_SIZE_LIMIT_BYTES,
  ensureBusinessMediaBucket,
  resolveBusinessMediaBucket,
  rewriteLegacyBusinessMediaUrls,
} from "./business-media-bucket";

const ORIGIN = "https://project.supabase.co/storage/v1/object/public";

describe("business media bucket", () => {
  it("defaults writers to the business media bucket unless overridden", () => {
    expect(resolveBusinessMediaBucket(undefined)).toBe("business-media");
    expect(resolveBusinessMediaBucket("  ")).toBe("business-media");
    expect(resolveBusinessMediaBucket("custom-bucket")).toBe("custom-bucket");
  });

  it("rewrites every legacy business-asset link and nothing else", () => {
    const header = `${ORIGIN}/conversation-images/whatsapp-template-headers/ws/a.png`;
    const scenario = `${ORIGIN}/conversation-attachments/scenarios/ws/v.mp4`;
    const studio = `${ORIGIN}/conversation-images/studio/instagram/ws/p.jpg`;
    const customer = `${ORIGIN}/conversation-images/whatsapp/ws/c/m.jpg`;
    const text = JSON.stringify({
      header,
      again: header,
      scenario,
      studio,
      customer,
    });

    expect(JSON.parse(rewriteLegacyBusinessMediaUrls(text))).toEqual({
      header: `${ORIGIN}/business-media/whatsapp-template-headers/ws/a.png`,
      again: `${ORIGIN}/business-media/whatsapp-template-headers/ws/a.png`,
      scenario: `${ORIGIN}/business-media/scenarios/ws/v.mp4`,
      studio: `${ORIGIN}/business-media/studio/instagram/ws/p.jpg`,
      customer,
    });
  });

  describe("ensureBusinessMediaBucket", () => {
    function storage(existing: boolean, createMessage?: string) {
      return {
        getBucket: jest.fn(async () =>
          existing
            ? { data: { id: BUSINESS_MEDIA_BUCKET }, error: null }
            : { data: null, error: { message: "Bucket not found" } }
        ),
        createBucket: jest.fn(async () => ({
          error: createMessage ? { message: createMessage } : null,
        })),
      };
    }

    it("creates a public bucket with the chat bucket's size limit once", async () => {
      const client = storage(false);
      await ensureBusinessMediaBucket(client, "bucket-a");
      await ensureBusinessMediaBucket(client, "bucket-a");

      expect(client.getBucket).toHaveBeenCalledTimes(1);
      expect(client.createBucket).toHaveBeenCalledWith("bucket-a", {
        public: true,
        fileSizeLimit: BUSINESS_MEDIA_FILE_SIZE_LIMIT_BYTES,
      });
    });

    it("leaves an existing bucket alone and tolerates a creation race", async () => {
      const existing = storage(true);
      await ensureBusinessMediaBucket(existing, "bucket-b");
      expect(existing.createBucket).not.toHaveBeenCalled();

      const raced = storage(false, "The resource already exists");
      await expect(
        ensureBusinessMediaBucket(raced, "bucket-c")
      ).resolves.toBeUndefined();
    });

    it("retries after a failed attempt", async () => {
      const failing = storage(false, "permission denied");
      await expect(
        ensureBusinessMediaBucket(failing, "bucket-d")
      ).rejects.toThrow("Failed to prepare business media storage");
      const healthy = storage(true);
      await expect(
        ensureBusinessMediaBucket(healthy, "bucket-d")
      ).resolves.toBeUndefined();
      expect(healthy.getBucket).toHaveBeenCalledTimes(1);
    });
  });
});

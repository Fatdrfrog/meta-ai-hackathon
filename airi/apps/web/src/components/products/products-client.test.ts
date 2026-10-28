/** @jest-environment node */
import {
  checkProductVideo,
  ProductVideoUploadError,
  uploadProductVideo,
} from "./products-client";

const video = (size = 2048, type = "video/quicktime") => {
  const file = new File([new Uint8Array(8)], "shelf.mov", { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
};

describe("checkProductVideo", () => {
  it("takes a video the import can read", async () => {
    expect(await checkProductVideo(video(), async () => 120)).toBeNull();
    // A length the browser can't read is the import's to check.
    expect(await checkProductVideo(video(), async () => null)).toBeNull();
  });

  it("refuses what the import couldn't take, before any upload", async () => {
    const length = jest.fn(async () => 60);
    expect(await checkProductVideo(video(2048, "image/png"), length)).toBe(
      "not_a_video"
    );
    expect(await checkProductVideo(video(0), length)).toBe("not_a_video");
    expect(await checkProductVideo(video(1024 ** 3 + 1), length)).toBe(
      "too_big"
    );
    expect(length).not.toHaveBeenCalled();
    expect(await checkProductVideo(video(), async () => 301)).toBe("too_long");
  });
});

describe("uploadProductVideo", () => {
  const upload = () =>
    uploadProductVideo({ workspaceId: "workspace-1", file: video() });
  const failsWith = async (code: string) => {
    const error = await upload().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProductVideoUploadError);
    expect((error as ProductVideoUploadError).code).toBe(code);
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status });

  it("tells a full storage, a refused type and a lost connection apart", async () => {
    global.fetch = jest.fn(async () =>
      json(409, { code: "company_storage_limit_exceeded" })
    ) as typeof fetch;
    await failsWith("storage_full");

    global.fetch = jest.fn(async () =>
      json(400, { error: "Creative video assets must be MP4" })
    ) as typeof fetch;
    await failsWith("not_a_video");

    global.fetch = jest.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    await failsWith("connection");
  });

  it("says the upload failed when storage refuses the bytes", async () => {
    global.fetch = jest.fn(async (url: string) =>
      url.startsWith("https://storage.test")
        ? new Response("denied", { status: 403 })
        : json(200, {
            upload: {
              provider: "gcs",
              assetId: "asset-1",
              uploadUrl: "https://storage.test/session",
              method: "PUT",
            },
          })
    ) as unknown as typeof fetch;
    await failsWith("upload_failed");
  });
});

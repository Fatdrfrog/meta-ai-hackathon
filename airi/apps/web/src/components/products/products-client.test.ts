/** @jest-environment node */
import {
  approveProductsWhatsAppRequest,
  checkProductVideo,
  denyProductsWhatsAppRequest,
  fetchProductsWhatsAppLink,
  openProductsWhatsAppLink,
  ProductDraftError,
  productsWhatsAppLinkUrl,
  ProductVideoUploadError,
  unlinkProductsWhatsAppPhone,
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

describe("the Send from WhatsApp panel", () => {
  const panel = {
    pairing: null,
    requests: [],
    linkedPhones: [],
    businessNumbers: [],
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status });

  it("asks each of the panel's routes, and answers with the panel", async () => {
    global.fetch = jest.fn(async () => json(200, panel)) as typeof fetch;
    const url = productsWhatsAppLinkUrl("workspace 1");

    await expect(fetchProductsWhatsAppLink(url)).resolves.toEqual(panel);
    await expect(openProductsWhatsAppLink("workspace 1")).resolves.toEqual(
      panel
    );
    await approveProductsWhatsAppRequest("workspace 1", "request/1");
    await denyProductsWhatsAppRequest("workspace 1", "request/1");
    await unlinkProductsWhatsAppPhone("workspace 1", "link-1");

    const base = "/api/workspaces/workspace%201/products/whatsapp-link";
    expect(
      (global.fetch as jest.Mock).mock.calls.map(
        ([called, init]) => `${init.method} ${called}`
      )
    ).toEqual([
      `GET ${base}`,
      `POST ${base}`,
      `POST ${base}/requests/request%2F1`,
      `DELETE ${base}/requests/request%2F1`,
      `DELETE ${base}/phones/link-1`,
    ]);
  });

  it("fails with the API's code, or with failed for anything that isn't the panel", async () => {
    const failsWith = async (request: Promise<unknown>, code: string) => {
      const error = await request.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProductDraftError);
      expect((error as ProductDraftError).code).toBe(code);
    };

    global.fetch = jest.fn(async () =>
      json(404, { code: "whatsapp_link_not_found" })
    ) as typeof fetch;
    await failsWith(
      approveProductsWhatsAppRequest("workspace-1", "request-1"),
      "whatsapp_link_not_found"
    );

    // The one-time code's answer, from before phones were confirmed in airi.
    global.fetch = jest.fn(async () =>
      json(201, { url: "https://wa.me/1", expiresAt: "2026-10-28T12:30:00Z" })
    ) as typeof fetch;
    await failsWith(openProductsWhatsAppLink("workspace-1"), "failed");

    global.fetch = jest.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    await failsWith(fetchProductsWhatsAppLink("/panel"), "failed");
  });
});

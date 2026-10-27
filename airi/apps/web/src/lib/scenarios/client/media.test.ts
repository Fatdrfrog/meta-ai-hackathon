import {
  generateWorkspaceCreativeImage,
  uploadScenarioActionImage,
} from "./media";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("uploadScenarioActionImage", () => {
  it("uploads a valid 16 MB video directly to GCS while application requests contain only metadata", async () => {
    const file = new File([new Uint8Array(16_339_444)], "fashion.mp4", {
      type: "video/mp4",
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        if (url === "https://storage.googleapis.com/upload-session") {
          const range = new Headers(init?.headers).get("Content-Range");
          return new Response(null, {
            status: range?.endsWith("16339443/16339444") ? 200 : 308,
          });
        }
        if (typeof init?.body !== "string") {
          return new Response("FUNCTION_PAYLOAD_TOO_LARGE", { status: 413 });
        }
        const body = JSON.parse(init.body);
        if (body.action === "initiate") {
          return jsonResponse({
            upload: {
              provider: "gcs",
              method: "PUT",
              uploadUrl: "https://storage.googleapis.com/upload-session",
              bucket: "bucket",
              path: "workspaces/workspace-1/creative-assets/video/scenario-123/fashion.mp4",
              uploadToken: "server-issued-ticket",
              mimeType: "video/mp4",
              fileName: "fashion.mp4",
              fileSize: file.size,
            },
          });
        }
        return jsonResponse({
          image: {
            url: "https://storage.googleapis.com/signed/fashion.mp4",
            bucket: "bucket",
            path: "workspaces/workspace-1/creative-assets/video/scenario-123/fashion.mp4",
            mediaType: "video",
            mimeType: "video/mp4",
            fileName: "fashion.mp4",
            fileSize: file.size,
          },
        });
      }
    ) as typeof fetch;

    await expect(
      uploadScenarioActionImage({
        workspaceId: "workspace-1",
        file,
        channel: "whatsapp",
      })
    ).resolves.toMatchObject({
      mediaType: "video",
      fileSize: 16_339_444,
    });
    const apiRequests = requests.filter(request =>
      request.url.startsWith("/api/")
    );
    expect(
      apiRequests.map(request => JSON.parse(String(request.init?.body)))
    ).toEqual([
      {
        action: "initiate",
        fileName: "fashion.mp4",
        mimeType: "video/mp4",
        fileSize: 16_339_444,
        channel: "whatsapp",
      },
      { action: "complete", uploadToken: "server-issued-ticket" },
    ]);
    expect(
      requests
        .filter(request =>
          request.url.startsWith("https://storage.googleapis.com/")
        )
        .map(request => new Headers(request.init?.headers).get("Content-Range"))
    ).toEqual(["bytes 0-8388607/16339444", "bytes 8388608-16339443/16339444"]);
  });

  it("preserves a plain-text HTTP 413 as a typed upload failure without a multipart fallback", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response("FUNCTION_PAYLOAD_TOO_LARGE", { status: 413 })
      );
    await expect(
      uploadScenarioActionImage({
        workspaceId: "workspace-1",
        file: new File(["video"], "fashion.mp4", { type: "video/mp4" }),
        channel: "whatsapp",
      })
    ).rejects.toMatchObject({
      name: "ScenarioRequestError",
      status: 413,
      code: "scenario_asset_upload_too_large",
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects videos above the WhatsApp limit before requesting an upload target", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        image: {
          url: "https://storage.example.com/file.mp4",
          bucket: "bucket",
          path: "path/file.mp4",
        },
      })
    );
    await expect(
      uploadScenarioActionImage({
        workspaceId: "workspace-1",
        file: new File([new Uint8Array(16 * 1024 * 1024 + 1)], "fashion.mp4", {
          type: "video/mp4",
        }),
        channel: "whatsapp",
      })
    ).rejects.toMatchObject({
      name: "ScenarioRequestError",
      code: "scenario_asset_upload_too_large",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects unsupported WhatsApp files before requesting an upload target", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        image: {
          url: "https://storage.example.com/file.exe",
          bucket: "bucket",
          path: "path/file.exe",
        },
      })
    );
    await expect(
      uploadScenarioActionImage({
        workspaceId: "workspace-1",
        file: new File(["data"], "file.exe", {
          type: "application/x-msdownload",
        }),
        channel: "whatsapp",
      })
    ).rejects.toMatchObject({
      name: "ScenarioRequestError",
      code: "scenario_asset_upload_unsupported_file",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, "scenario_asset_upload_auth_required"],
    [403, "scenario_asset_upload_forbidden"],
    [503, "scenario_asset_upload_unavailable"],
  ])(
    "classifies application HTTP %s before uploading any bytes",
    async (status, code) => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(jsonResponse({ error: "Request rejected" }, status));
      await expect(
        uploadScenarioActionImage({
          workspaceId: "workspace-1",
          file: new File(["video"], "fashion.mp4", { type: "video/mp4" }),
          channel: "whatsapp",
        })
      ).rejects.toMatchObject({ name: "ScenarioRequestError", status, code });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    [403, "scenario_asset_upload_rejected"],
    [413, "scenario_asset_upload_too_large"],
  ])(
    "classifies storage HTTP %s and never completes a failed upload",
    async (status, code) => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            upload: {
              provider: "gcs",
              method: "PUT",
              uploadUrl: "https://storage.googleapis.com/upload-session",
              uploadToken: "ticket",
              mimeType: "video/mp4",
            },
          })
        )
        .mockResolvedValueOnce(
          new Response("Private provider error body", { status })
        );
      await expect(
        uploadScenarioActionImage({
          workspaceId: "workspace-1",
          file: new File(["video"], "fashion.mp4", { type: "video/mp4" }),
          channel: "whatsapp",
        })
      ).rejects.toMatchObject({
        name: "ScenarioRequestError",
        status,
        code,
        message: "Storage upload failed",
      });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    }
  );

  it("classifies a disconnected upload target request without exposing the browser error", async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new TypeError("Private network detail"));
    await expect(
      uploadScenarioActionImage({
        workspaceId: "workspace-1",
        file: new File(["video"], "fashion.mp4", { type: "video/mp4" }),
        channel: "whatsapp",
      })
    ).rejects.toMatchObject({
      name: "ScenarioRequestError",
      status: 0,
      code: "scenario_asset_upload_network_failed",
      message: "Upload connection failed",
    });
  });
});

describe("generateWorkspaceCreativeImage", () => {
  it("falls back to Higgsfield only when Alibaba is unconfigured", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: "Alibaba image generation is not configured.",
            configured: false,
          },
          503
        )
      )
      .mockResolvedValueOnce(jsonResponse({ asset: { id: "hf-1" } }, 201));

    await expect(
      generateWorkspaceCreativeImage({
        workspaceId: "workspace-1",
        prompt: "A blue bottle",
      })
    ).resolves.toEqual({ asset: { id: "hf-1" } });
    expect(String((global.fetch as jest.Mock).mock.calls[1][0])).toContain(
      "/assets/generate/higgsfield"
    );
  });

  it("does not fall back when Alibaba generation itself fails with 503", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(
        {
          error: "Qwen overloaded",
          asset: { id: "failed-1", status: "failed" },
        },
        503
      )
    );

    await expect(
      generateWorkspaceCreativeImage({
        workspaceId: "workspace-1",
        prompt: "A blue bottle",
      })
    ).rejects.toThrow("Qwen overloaded");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

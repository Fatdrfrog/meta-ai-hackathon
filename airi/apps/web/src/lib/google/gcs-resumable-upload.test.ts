import {
  GcsResumableUploadError,
  uploadGcsResumableAsset,
} from "./gcs-resumable-upload";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe("uploadGcsResumableAsset", () => {
  it("sends a size-bound signed PUT as one body with its signed headers", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const file = new File([new Uint8Array(9 * 1024 * 1024)], "video.mp4", {
      type: "video/mp4",
    });
    const headers = {
      "x-goog-content-length-range": `${file.size},${file.size}`,
      "x-goog-if-generation-match": "0",
    };
    await uploadGcsResumableAsset({
      file,
      upload: {
        uploadUrl: "https://storage.googleapis.com/signed",
        method: "PUT",
        mode: "single",
        headers,
      },
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const init = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    expect(init.body).toBe(file);
    expect(new Headers(init.headers).get("x-goog-content-length-range")).toBe(
      `${file.size},${file.size}`
    );
    expect(new Headers(init.headers).get("Content-Range")).toBeNull();
  });
  it("continues a GCS 308 response and finishes the remaining bytes directly at the upload session", async () => {
    const requests: Array<{
      url: string;
      range: string | null;
      bytes: number;
    }> = [];
    global.fetch = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          range: new Headers(init?.headers).get("Content-Range"),
          bytes: (init?.body as Blob).size,
        });
        return new Response(null, {
          status: requests.length === 1 ? 308 : 200,
        });
      }
    ) as typeof fetch;
    await uploadGcsResumableAsset({
      file: new File([new Uint8Array(9 * 1024 * 1024)], "video.mp4", {
        type: "video/mp4",
      }),
      upload: {
        uploadUrl: "https://storage.googleapis.com/session",
        method: "PUT",
        mimeType: "video/mp4",
      },
    });
    expect(requests).toEqual([
      {
        url: "https://storage.googleapis.com/session",
        range: "bytes 0-8388607/9437184",
        bytes: 8_388_608,
      },
      {
        url: "https://storage.googleapis.com/session",
        range: "bytes 8388608-9437183/9437184",
        bytes: 1_048_576,
      },
    ]);
  });

  it("stops after storage rejects a chunk and keeps its status for the caller", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response("Maximum size exceeded", { status: 413 })
      );
    await expect(
      uploadGcsResumableAsset({
        file: new File([new Uint8Array(9 * 1024 * 1024)], "video.mp4"),
        upload: {
          uploadUrl: "https://storage.googleapis.com/session",
          method: "PUT",
        },
      })
    ).rejects.toMatchObject({ name: "GcsResumableUploadError", status: 413 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not report success when the final chunk is still incomplete", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(new Response(null, { status: 308 }));
    await expect(
      uploadGcsResumableAsset({
        file: new File(["video"], "video.mp4"),
        upload: {
          uploadUrl: "https://storage.googleapis.com/session",
          method: "PUT",
        },
      })
    ).rejects.toBeInstanceOf(GcsResumableUploadError);
  });
});

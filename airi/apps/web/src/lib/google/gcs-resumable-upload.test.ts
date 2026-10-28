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

  it("reports a single PUT's progress, and stops it when cancelled", async () => {
    const sent: Array<{
      method: string;
      url: string;
      headers: Record<string, string>;
      body: unknown;
    }> = [];
    class FakeRequest {
      static last: FakeRequest;
      status = 0;
      responseText = "";
      upload: { onprogress?: (event: { loaded: number }) => void } = {};
      onload?: () => void;
      onerror?: () => void;
      onabort?: () => void;
      onloadend?: () => void;
      private sending = { method: "", url: "", headers: {} };
      constructor() {
        FakeRequest.last = this;
      }
      open(method: string, url: string) {
        this.sending = { method, url, headers: {} };
      }
      setRequestHeader(name: string, value: string) {
        (this.sending.headers as Record<string, string>)[name] = value;
      }
      send(body: unknown) {
        sent.push({ ...this.sending, body });
      }
      abort() {
        this.onabort?.();
        this.onloadend?.();
      }
      finish(status: number) {
        this.status = status;
        this.onload?.();
        this.onloadend?.();
      }
    }
    const scope = globalThis as { XMLHttpRequest?: unknown };
    const originalRequest = scope.XMLHttpRequest;
    scope.XMLHttpRequest = FakeRequest;
    try {
      const file = new File([new Uint8Array(1000)], "shelf.mov", {
        type: "video/quicktime",
      });
      const upload = {
        uploadUrl: "https://storage.googleapis.com/signed",
        method: "PUT" as const,
        mode: "single" as const,
        headers: { "x-goog-if-generation-match": "0" },
      };
      const progress: number[] = [];
      const done = uploadGcsResumableAsset({
        file,
        upload,
        onProgress: bytes => progress.push(bytes),
      });
      FakeRequest.last.upload.onprogress?.({ loaded: 400 });
      FakeRequest.last.finish(200);
      await done;
      expect(progress).toEqual([400, 1000]);
      expect(sent).toEqual([
        {
          method: "PUT",
          url: "https://storage.googleapis.com/signed",
          headers: {
            "Content-Type": "video/quicktime",
            "x-goog-if-generation-match": "0",
          },
          body: file,
        },
      ]);

      const refused = uploadGcsResumableAsset({
        file,
        upload,
        onProgress: () => undefined,
      });
      FakeRequest.last.finish(403);
      await expect(refused).rejects.toMatchObject({
        name: "GcsResumableUploadError",
        status: 403,
      });

      const controller = new AbortController();
      const cancelled = uploadGcsResumableAsset({
        file,
        upload,
        onProgress: () => undefined,
        signal: controller.signal,
      });
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      scope.XMLHttpRequest = originalRequest;
    }
  });

  it("reports a chunked upload's progress after each chunk", async () => {
    let calls = 0;
    global.fetch = jest.fn(
      async () => new Response(null, { status: ++calls === 1 ? 308 : 200 })
    ) as typeof fetch;
    const progress: number[] = [];
    await uploadGcsResumableAsset({
      file: new File([new Uint8Array(9 * 1024 * 1024)], "video.mp4"),
      upload: {
        uploadUrl: "https://storage.googleapis.com/session",
        method: "PUT",
      },
      onProgress: bytes => progress.push(bytes),
    });
    expect(progress).toEqual([8_388_608, 9_437_184]);
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

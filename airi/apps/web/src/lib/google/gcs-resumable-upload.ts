import { CREATIVE_ASSET_UPLOAD_CHUNK_BYTES } from "@icecore/airi-runtime/media-api";

export type GcsResumableUploadTarget = {
  uploadUrl: string;
  method: "PUT";
  mimeType?: string;
  mode?: "single";
  headers?: Record<string, string>;
};

export class GcsResumableUploadError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "GcsResumableUploadError";
  }
}

/** Upload file bytes directly to the existing GCS session, outside application functions. */
export async function uploadGcsResumableAsset(params: {
  file: File;
  upload: GcsResumableUploadTarget;
  /**
   * Bytes sent so far, as the upload goes. With it, a single signed PUT is
   * sent through XMLHttpRequest, the browser API that reports upload
   * progress; a chunked upload reports after each chunk.
   */
  onProgress?: (sentBytes: number) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const totalBytes = params.file.size;
  const contentType =
    params.upload.mimeType || params.file.type || "application/octet-stream";
  if (params.upload.mode === "single") {
    const headers = { "Content-Type": contentType, ...params.upload.headers };
    if (params.onProgress) {
      return putWithProgress({
        url: params.upload.uploadUrl,
        method: params.upload.method,
        headers,
        body: params.file,
        onProgress: params.onProgress,
        signal: params.signal,
      });
    }
    const response = await fetch(params.upload.uploadUrl, {
      method: params.upload.method,
      headers,
      body: params.file,
      signal: params.signal,
    });
    if (response.ok) return;
    throw new GcsResumableUploadError(
      response.status,
      `Upload failed with ${response.status}: ${(await response.text()).slice(0, 500)}`
    );
  }
  let start = 0;
  while (start < totalBytes) {
    const end = Math.min(start + CREATIVE_ASSET_UPLOAD_CHUNK_BYTES, totalBytes);
    const response = await fetch(params.upload.uploadUrl, {
      method: params.upload.method,
      headers: {
        "Content-Type": contentType,
        "Content-Range": `bytes ${start}-${end - 1}/${totalBytes}`,
      },
      body: params.file.slice(start, end),
      signal: params.signal,
    });
    const isFinalChunk = end >= totalBytes;
    if (!isFinalChunk && response.status === 308) {
      start = end;
      params.onProgress?.(start);
      continue;
    }
    if (isFinalChunk && response.ok) {
      params.onProgress?.(totalBytes);
      return;
    }
    const responseText = await response.text().catch(() => "");
    throw new GcsResumableUploadError(
      response.status,
      `Upload failed with ${response.status}: ${responseText.slice(0, 500)}`
    );
  }
}

/**
 * One signed PUT that reports its progress. It fails the way fetch does: a
 * GcsResumableUploadError for a refusal, a TypeError for a lost connection,
 * and an AbortError when `signal` cancels it.
 */
function putWithProgress(params: {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  body: File;
  onProgress: (sentBytes: number) => void;
  signal?: AbortSignal;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelled = () =>
      new DOMException("The upload was cancelled", "AbortError");
    if (params.signal?.aborted) {
      reject(cancelled());
      return;
    }
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    params.signal?.addEventListener("abort", abort, { once: true });
    request.open(params.method, params.url);
    for (const [name, value] of Object.entries(params.headers))
      request.setRequestHeader(name, value);
    request.upload.onprogress = event => params.onProgress(event.loaded);
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        params.onProgress(params.body.size);
        resolve();
        return;
      }
      reject(
        new GcsResumableUploadError(
          request.status,
          `Upload failed with ${request.status}: ${String(request.responseText ?? "").slice(0, 500)}`
        )
      );
    };
    request.onerror = () => reject(new TypeError("Upload connection failed"));
    request.onabort = () => reject(cancelled());
    request.onloadend = () =>
      params.signal?.removeEventListener("abort", abort);
    request.send(params.body);
  });
}

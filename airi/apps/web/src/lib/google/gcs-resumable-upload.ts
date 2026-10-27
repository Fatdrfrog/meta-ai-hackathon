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
}): Promise<void> {
  const totalBytes = params.file.size;
  if (params.upload.mode === "single") {
    const response = await fetch(params.upload.uploadUrl, {
      method: params.upload.method,
      headers: {
        "Content-Type":
          params.upload.mimeType ||
          params.file.type ||
          "application/octet-stream",
        ...params.upload.headers,
      },
      body: params.file,
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
        "Content-Type":
          params.upload.mimeType ||
          params.file.type ||
          "application/octet-stream",
        "Content-Range": `bytes ${start}-${end - 1}/${totalBytes}`,
      },
      body: params.file.slice(start, end),
    });
    const isFinalChunk = end >= totalBytes;
    if (!isFinalChunk && response.status === 308) {
      start = end;
      continue;
    }
    if (isFinalChunk && response.ok) return;
    const responseText = await response.text().catch(() => "");
    throw new GcsResumableUploadError(
      response.status,
      `Upload failed with ${response.status}: ${responseText.slice(0, 500)}`
    );
  }
}

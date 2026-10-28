import {
  GcsResumableUploadError,
  uploadGcsResumableAsset,
  type GcsResumableUploadTarget,
} from "@/lib/google/gcs-resumable-upload";
import {
  PRODUCT_VIDEO_MAX_BYTES,
  PRODUCT_VIDEO_MAX_SECONDS,
  type ProductsAccessResponse,
  type ProductsListResponse,
  type ProductVideoImportResponse,
  type ProductVideoImportsResponse,
} from "@/lib/products/types";

// Requests the Products page and its menu entry make.

/** The Products API of one workspace. */
export function productsApiUrl(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/products`;
}

export function productsAccessUrl(workspaceId: string): string {
  return `${productsApiUrl(workspaceId)}/access`;
}

export function productImportsUrl(workspaceId: string): string {
  return `${productsApiUrl(workspaceId)}/imports`;
}

export function productImportUrl(workspaceId: string, importId: string) {
  return `${productImportsUrl(workspaceId)}/${encodeURIComponent(importId)}`;
}

export async function fetchProductImports(
  url: string
): Promise<ProductVideoImportsResponse> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as ProductVideoImportsResponse | null;
  if (!Array.isArray(data?.imports)) throw new Error("Unexpected response");
  return data;
}

export async function fetchProductImport(
  url: string
): Promise<ProductVideoImportResponse> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as ProductVideoImportResponse | null;
  if (!data?.import || !Array.isArray(data.products))
    throw new Error("Unexpected response");
  return data;
}

/** Why a video didn't reach the import, as the page explains it. */
export type ProductVideoUploadErrorCode =
  | "not_a_video"
  | "too_big"
  | "too_long"
  | "storage_full"
  | "upload_failed"
  | "connection"
  | "import_failed"
  | "cancelled";

export class ProductVideoUploadError extends Error {
  constructor(
    readonly code: ProductVideoUploadErrorCode,
    /** The uploaded video, when only starting its import failed. */
    readonly assetId: string | null = null
  ) {
    super(`Product video upload failed: ${code}`);
    this.name = "ProductVideoUploadError";
  }
}

// How long the page waits for the browser to read a video's length. Some
// videos it can't read at all (HEVC in Chrome on Windows); the import checks
// those itself.
const DURATION_TIMEOUT_MS = 4000;

/** The video's length in seconds, as the browser reads it, or null when it can't. */
export function readVideoDuration(file: File): Promise<number | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    const done = (seconds: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      URL.revokeObjectURL(url);
      resolve(seconds);
    };
    const timer = setTimeout(() => done(null), DURATION_TIMEOUT_MS);
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () =>
      done(Number.isFinite(video.duration) ? video.duration : null);
    video.onerror = () => done(null);
    video.src = url;
  });
}

/**
 * Checks a chosen file before it's uploaded, against what the import takes,
 * so the owner doesn't wait for a long upload only to see it refused. The
 * exact video types are the media storage's to check.
 */
export async function checkProductVideo(
  file: File,
  readDuration: (file: File) => Promise<number | null> = readVideoDuration
): Promise<ProductVideoUploadErrorCode | null> {
  if (file.type && !file.type.startsWith("video/")) return "not_a_video";
  if (file.size <= 0) return "not_a_video";
  if (file.size > PRODUCT_VIDEO_MAX_BYTES) return "too_big";
  const seconds = await readDuration(file);
  return seconds !== null && seconds > PRODUCT_VIDEO_MAX_SECONDS
    ? "too_long"
    : null;
}

type UploadTarget = GcsResumableUploadTarget & {
  provider?: string;
  assetId?: string;
  bucket?: string;
  path?: string;
  kind?: string;
  fileName?: string;
  fileSize?: number;
};

const isAbort = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

type Refusal = { status: number; code: unknown };

/** A JSON POST to one of the upload's APIs; its failures as upload error codes. */
async function postJson<T>(
  url: string,
  body: unknown,
  failure: (refusal: Refusal) => ProductVideoUploadErrorCode,
  signal?: AbortSignal
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw new ProductVideoUploadError(
      isAbort(error) ? "cancelled" : "connection"
    );
  }
  const data = (await response.json().catch(() => null)) as
    | (T & { code?: unknown })
    | null;
  if (!response.ok || !data)
    throw new ProductVideoUploadError(
      failure({ status: response.status, code: data?.code })
    );
  return data;
}

const storageFailure = ({ code }: Refusal): ProductVideoUploadErrorCode =>
  code === "company_storage_limit_exceeded" ? "storage_full" : "upload_failed";

/** Starts importing products from a video already in the workspace's media. */
export async function startProductVideoImport(params: {
  workspaceId: string;
  assetId: string;
  signal?: AbortSignal;
}): Promise<{ importId: string }> {
  try {
    const { importId } = await postJson<{ importId?: unknown }>(
      productImportsUrl(params.workspaceId),
      { assetId: params.assetId },
      () => "import_failed",
      params.signal
    );
    if (typeof importId !== "string" || !importId)
      throw new ProductVideoUploadError("import_failed");
    return { importId };
  } catch (error) {
    // Kept with the error, so starting it again doesn't upload it again.
    if (error instanceof ProductVideoUploadError && error.code !== "cancelled")
      throw new ProductVideoUploadError(error.code, params.assetId);
    throw error;
  }
}

/**
 * Uploads a shelf video into the workspace's media, the way the Assets page
 * does (a signed upload straight to storage), then starts importing its
 * products. `onProgress` hears the bytes sent.
 */
export async function uploadProductVideo(params: {
  workspaceId: string;
  file: File;
  onProgress?: (sentBytes: number) => void;
  signal?: AbortSignal;
}): Promise<{ importId: string; assetId: string }> {
  const { file, signal } = params;
  const endpoint = `/api/workspaces/${encodeURIComponent(params.workspaceId)}/assets/upload`;
  const { upload } = await postJson<{ upload?: UploadTarget }>(
    endpoint,
    {
      action: "initiate",
      fileName: file.name,
      mimeType: file.type,
      fileSize: file.size,
    },
    // The size was checked, so storage refusing it means its type.
    refusal =>
      refusal.status === 400 ? "not_a_video" : storageFailure(refusal),
    signal
  );
  if (
    upload?.provider !== "gcs" ||
    upload.method !== "PUT" ||
    !upload.uploadUrl ||
    !upload.assetId
  )
    throw new ProductVideoUploadError("upload_failed");
  try {
    await uploadGcsResumableAsset({
      file,
      upload,
      onProgress: params.onProgress,
      signal,
    });
  } catch (error) {
    if (isAbort(error)) throw new ProductVideoUploadError("cancelled");
    throw new ProductVideoUploadError(
      error instanceof GcsResumableUploadError ? "upload_failed" : "connection"
    );
  }
  await postJson(
    endpoint,
    {
      action: "complete",
      provider: upload.provider,
      assetId: upload.assetId,
      bucket: upload.bucket,
      path: upload.path,
      kind: upload.kind,
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      fileSize: upload.fileSize,
    },
    storageFailure,
    signal
  );
  const { importId } = await startProductVideoImport({
    workspaceId: params.workspaceId,
    assetId: upload.assetId,
    signal,
  });
  return { importId, assetId: upload.assetId };
}

export async function fetchProducts(
  url: string
): Promise<ProductsListResponse> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as ProductsListResponse | null;
  if (!Array.isArray(data?.products)) throw new Error("Unexpected response");
  return data;
}

/** Whether this user sees Products; any failure hides it. */
export async function fetchProductsAccess(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return false;
    const data = (await response.json()) as Partial<ProductsAccessResponse>;
    return data?.available === true;
  } catch {
    return false;
  }
}

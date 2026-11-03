"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkProductVideo,
  ProductVideoUploadError,
  startProductVideoImport,
  uploadProductVideo,
  type ProductVideoUploadErrorCode,
} from "./products-client";

/**
 * A video on its way from this device to the import. `preview` is a local
 * link to the file, for its first frame.
 */
export type ProductVideoUploadState =
  | { phase: "idle" }
  | {
      phase: "checking" | "uploading" | "starting";
      file: File;
      preview: string;
      sentBytes: number;
    }
  | {
      phase: "failed";
      file: File;
      preview: string;
      code: Exclude<ProductVideoUploadErrorCode, "cancelled">;
      /** The uploaded video, when only starting its import failed. */
      assetId: string | null;
    };

const IDLE: ProductVideoUploadState = { phase: "idle" };

/** The file a local preview link was made from, as the stage captions it. */
export type PreviewFile = { name: string; size: number };

// The files behind the preview links made on this page, so the stage that
// gets only a link once the import starts can still name its file. A few at
// most: one per video uploaded since the page opened.
const PREVIEW_FILES_KEPT = 12;
const previewFiles = new Map<string, PreviewFile>();

function rememberPreview(preview: string, file: File) {
  previewFiles.set(preview, { name: file.name, size: file.size });
  for (const old of previewFiles.keys()) {
    if (previewFiles.size <= PREVIEW_FILES_KEPT) break;
    previewFiles.delete(old);
  }
}

/** The file a preview link from this page shows, or null for any other. */
export function previewFile(preview: string | null): PreviewFile | null {
  return preview ? (previewFiles.get(preview) ?? null) : null;
}

/**
 * Uploads a chosen video and starts its import. Once the import has
 * started, `onStarted` gets it with the local preview, which is then the
 * caller's to revoke.
 */
export function useProductVideoUpload(
  workspaceId: string,
  onStarted: (importId: string, preview: string) => void
) {
  const [state, setState] = useState<ProductVideoUploadState>(IDLE);
  const controller = useRef<AbortController | null>(null);
  // The preview this hook still owns: until its import starts.
  const ownPreview = useRef<string | null>(null);
  const dropPreview = useCallback(() => {
    if (ownPreview.current) {
      URL.revokeObjectURL(ownPreview.current);
      previewFiles.delete(ownPreview.current);
    }
    ownPreview.current = null;
  }, []);

  const run = useCallback(
    async (file: File, preview: string, assetId: string | null) => {
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      const fail = (code: ProductVideoUploadErrorCode, uploaded = assetId) => {
        if (code !== "cancelled")
          return setState({
            phase: "failed",
            file,
            preview,
            code,
            assetId: uploaded,
          });
        dropPreview();
        setState(IDLE);
      };
      try {
        let importId: string;
        if (assetId) {
          setState({ phase: "starting", file, preview, sentBytes: file.size });
          ({ importId } = await startProductVideoImport({
            workspaceId,
            assetId,
            signal: abort.signal,
          }));
        } else {
          setState({ phase: "checking", file, preview, sentBytes: 0 });
          const problem = await checkProductVideo(file);
          if (abort.signal.aborted) return;
          if (problem) return fail(problem);
          setState({ phase: "uploading", file, preview, sentBytes: 0 });
          ({ importId } = await uploadProductVideo({
            workspaceId,
            file,
            signal: abort.signal,
            onProgress: sentBytes =>
              setState(current =>
                current.phase === "uploading" && current.file === file
                  ? {
                      ...current,
                      sentBytes,
                      phase: sentBytes >= file.size ? "starting" : "uploading",
                    }
                  : current
              ),
          }));
        }
        if (abort.signal.aborted) return;
        controller.current = null;
        ownPreview.current = null;
        onStarted(importId, preview);
        setState(IDLE);
      } catch (error) {
        if (abort.signal.aborted) return;
        controller.current = null;
        if (error instanceof ProductVideoUploadError)
          return fail(error.code, error.assetId ?? assetId);
        fail("upload_failed");
      }
    },
    [workspaceId, onStarted, dropPreview]
  );

  const start = useCallback(
    (file: File) => {
      dropPreview();
      const preview = URL.createObjectURL(file);
      ownPreview.current = preview;
      rememberPreview(preview, file);
      void run(file, preview, null);
    },
    [run, dropPreview]
  );

  /** Stops the upload, or forgets one that failed. */
  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    dropPreview();
    setState(IDLE);
  }, [dropPreview]);

  /** Tries a failed upload again, without uploading a video that arrived. */
  const retry = useCallback(() => {
    if (state.phase === "failed")
      void run(state.file, state.preview, state.assetId);
  }, [run, state]);

  // Leaving the page stops an upload, so the browser asks first.
  const sending = state.phase === "uploading" || state.phase === "starting";
  useEffect(() => {
    if (!sending) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [sending]);

  useEffect(
    () => () => {
      controller.current?.abort();
      dropPreview();
    },
    [dropPreview]
  );

  return { state, start, cancel, retry };
}

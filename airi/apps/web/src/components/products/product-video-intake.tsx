"use client";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import type {
  ProductVideoImportRecord,
  ProductVideoImportResponse,
  ProductVideoImportStage,
} from "@/lib/products/types";
import { Film } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import useSWR from "swr";
import { ProductShelf } from "./product-shelf";
import { fetchProductImport, productImportUrl } from "./products-client";
import { isImportRunning, PRODUCT_IMPORT_POLL_MS } from "./use-product-imports";
import type { ProductVideoUploadState } from "./use-product-video-upload";

// A video's way to the shelf: uploaded from this device, then read by the
// import job, whose products land on a dashed shelf as their photos are made.

/** The video's first frame from the local file, or a film mark without one. */
function VideoFrame({ preview }: { preview: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <div
      aria-hidden="true"
      className="relative h-24 w-14 shrink-0 overflow-hidden rounded-lg bg-foreground/[0.06]"
    >
      {preview && !failed ? (
        <video
          // The first frame, without playing: some phones paint none otherwise.
          src={`${preview}#t=0.1`}
          muted
          playsInline
          preload="metadata"
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      ) : (
        <Film className="absolute inset-0 m-auto size-5 text-foreground/30" />
      )}
    </div>
  );
}

/** One line of what is happening to a video, with its progress and what can be done. */
function VideoStatus({
  preview,
  label,
  detail = null,
  percent = null,
  alert = false,
  actions = null,
}: {
  preview: string | null;
  label: string;
  detail?: string | null;
  percent?: number | null;
  alert?: boolean;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <VideoFrame preview={preview} />
      <div className="min-w-0 flex-1 basis-52">
        <p
          role={alert ? "alert" : undefined}
          aria-live={alert ? undefined : "polite"}
          className="text-[15px] font-medium text-balance"
        >
          {label}
        </p>
        {detail ? (
          <p className="mt-0.5 text-sm text-muted-foreground tabular-nums">
            {detail}
          </p>
        ) : null}
        {percent !== null ? (
          <Progress
            value={percent}
            aria-label={label}
            className="mt-3 h-1 max-w-md"
          />
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  );
}

/** The video on its way up from this device. */
export function UploadProgress({
  state,
  onCancel,
  onRetry,
}: {
  state: Exclude<ProductVideoUploadState, { phase: "idle" }>;
  onCancel: () => void;
  onRetry: () => void;
}) {
  // The button that started this is gone while it runs, so its first action
  // takes the keyboard's focus.
  if (state.phase === "failed") {
    // A video the import can't take needs another video, which the page's
    // upload button chooses, not another try.
    const retry =
      state.code !== "not_a_video" &&
      state.code !== "too_big" &&
      state.code !== "too_long";
    return (
      <VideoStatus
        preview={state.preview}
        label={PRODUCTS_COPY.uploadErrors[state.code]}
        alert
        actions={
          <>
            {retry ? (
              <Button size="sm" variant="outline" onClick={onRetry} autoFocus>
                {PRODUCTS_COPY.tryAgain}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={onCancel}
              autoFocus={!retry}
            >
              {PRODUCTS_COPY.dismiss}
            </Button>
          </>
        }
      />
    );
  }
  const percent =
    state.phase === "checking"
      ? 0
      : Math.min(
          100,
          Math.round((state.sentBytes / Math.max(1, state.file.size)) * 100)
        );
  return (
    <VideoStatus
      preview={state.preview}
      label={PRODUCTS_COPY.uploading}
      detail={`${percent}%`}
      percent={percent}
      actions={
        state.phase === "starting" ? null : (
          <Button size="sm" variant="ghost" onClick={onCancel} autoFocus>
            {PRODUCTS_COPY.cancel}
          </Button>
        )
      }
    />
  );
}

// Where each stage sits on an import's progress bar: on the test videos,
// making the photos took about four fifths of the time.
const STAGE_SPAN: Record<ProductVideoImportStage, [number, number]> = {
  preparing: [2, 6],
  listening: [6, 12],
  watching: [12, 22],
  cutting: [22, 100],
};

/** How far an import has got, 0-100. */
export function importPercent(
  record: Pick<
    ProductVideoImportRecord,
    "status" | "stage" | "photoDone" | "photoTotal"
  >
): number {
  if (record.status === "queued") return 1;
  if (record.status !== "processing") return 100;
  const [from, to] = STAGE_SPAN[record.stage ?? "preparing"];
  if (record.stage !== "cutting" || record.photoTotal <= 0) return from;
  const done = Math.min(record.photoDone, record.photoTotal);
  return Math.round(from + ((to - from) * done) / record.photoTotal);
}

/**
 * One import: where it is, and the products it found, which stand on a
 * dashed shelf until the owner checks them.
 */
export function ImportProgress({
  workspaceId,
  record,
  preview,
}: {
  workspaceId: string;
  record: ProductVideoImportRecord;
  /** The local file's link, when it was uploaded from this page. */
  preview: string | null;
}) {
  const running = isImportRunning(record);
  const { data } = useSWR<ProductVideoImportResponse>(
    productImportUrl(workspaceId, record.id),
    fetchProductImport,
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      refreshInterval: running ? PRODUCT_IMPORT_POLL_MS : 0,
    }
  );
  const drafts = useMemo(
    () => (data?.products ?? []).filter(product => product.status === "draft"),
    [data]
  );
  const pendingIds = useMemo(
    () =>
      new Set(
        drafts
          .filter(
            product =>
              product.options[product.featuredOption]?.photoMethod === "pending"
          )
          .map(product => product.id)
      ),
    [drafts]
  );

  let status: ReactNode;
  if (record.status === "queued") {
    status = (
      <VideoStatus
        preview={preview}
        label={PRODUCTS_COPY.queued}
        percent={importPercent(record)}
      />
    );
  } else if (record.status === "processing") {
    const stage = record.stage ?? "preparing";
    status = (
      <VideoStatus
        preview={preview}
        label={PRODUCTS_COPY.stages[stage]}
        detail={
          stage === "cutting" && record.photoTotal > 0
            ? PRODUCTS_COPY.photosMade(record.photoDone, record.photoTotal)
            : null
        }
        percent={importPercent(record)}
      />
    );
  } else if (record.status === "failed") {
    status = (
      <VideoStatus
        preview={preview}
        label={PRODUCTS_COPY.importErrors[record.errorCode ?? "failed"]}
        alert
      />
    );
  } else if (record.productTotal === 0) {
    status = (
      <VideoStatus preview={preview} label={PRODUCTS_COPY.nothingFound} />
    );
  } else {
    status = (
      <VideoStatus
        preview={preview}
        label={PRODUCTS_COPY.readyToCheck(
          data ? drafts.length : record.productTotal
        )}
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {status}
      {drafts.length > 0 ? (
        <ProductShelf
          products={drafts}
          label={PRODUCTS_COPY.found}
          draft
          pendingIds={pendingIds}
        />
      ) : null}
    </div>
  );
}

"use client";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import type {
  ProductVideoImportRecord,
  ProductVideoImportResponse,
} from "@/lib/products/types";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import useSWR from "swr";
import { ProductShelf, ShelfHeading } from "./product-shelf";
import { CreationStage, MiniStage } from "./product-stage";
import {
  draftShelfInfo,
  importPercent,
  importPhase,
  latestMade,
  railState,
  stagePhotos,
  stageText,
} from "./product-stage-model";
import { StageRail } from "./product-stage-rail";
import { fetchProductImport, productImportUrl } from "./products-client";
import { isImportRunning, PRODUCT_IMPORT_POLL_MS } from "./use-product-imports";
import type { ProductVideoUploadState } from "./use-product-video-upload";

// A video's way to the shelf: uploaded from this device, then read by the
// import job. The page plays one of them on its stage, beside the steps it
// goes through, with the products it found on a dashed shelf below; any
// others are rows.

const HERO = "grid gap-4 lg:grid-cols-[minmax(0,1fr)_15rem] lg:gap-6";

/** One line of what is happening to a video, with its progress and what can be done. */
function VideoStatus({
  thumb,
  label,
  labelId,
  detail = null,
  percent = null,
  alert = false,
  actions = null,
}: {
  thumb: ReactNode;
  label: string;
  labelId?: string;
  detail?: string | null;
  percent?: number | null;
  alert?: boolean;
  actions?: ReactNode;
}) {
  return (
    // When its actions wrap below, they line up under the words, not the still.
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
      {thumb}
      <div className="min-w-0">
        <p
          id={labelId}
          role={alert ? "alert" : undefined}
          aria-live={alert ? undefined : "polite"}
          className="text-[15px] font-medium text-balance"
        >
          {label}
        </p>
        {detail ? (
          <p className="mt-0.5 text-sm text-pretty text-muted-foreground tabular-nums">
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
      {actions ? (
        // A push button's face rides 4 px above its box: beside the
        // sentence, it's lowered to sit level with it.
        <div className="col-start-2 flex gap-2 justify-self-start sm:col-start-3 sm:translate-y-1 sm:justify-self-end">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/** The video on its way up from this device, playing on the stage. */
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
      <div className={HERO}>
        <CreationStage
          mode="upload"
          phase="failed"
          label={PRODUCTS_COPY.uploadErrors[state.code]}
          alert
          percent={null}
          preview={state.preview}
          photos={null}
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
        <StageRail current="prepare" stopped="prepare" />
      </div>
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
    <div className={HERO}>
      <CreationStage
        mode="upload"
        phase="uploading"
        label={PRODUCTS_COPY.uploading}
        helper={PRODUCTS_COPY.stage.keepOpen}
        percent={percent}
        fill={percent}
        preview={state.preview}
        photos={null}
        actions={
          state.phase === "starting" ? null : (
            <Button size="sm" variant="ghost" onClick={onCancel} autoFocus>
              {PRODUCTS_COPY.cancel}
            </Button>
          )
        }
      />
      <StageRail current="prepare" busy counts={{ prepare: `${percent}%` }} />
    </div>
  );
}

/**
 * One import. On the stage: where it is, each photo as it's made, and the
 * products it found, which stand on a dashed shelf until the owner checks
 * them. As a row: one line, with a still of its latest photo.
 */
export function ImportProgress({
  workspaceId,
  record,
  preview,
  variant,
  onReview,
}: {
  workspaceId: string;
  record: ProductVideoImportRecord;
  /** The local file's link, when it was uploaded from this page. */
  preview: string | null;
  variant: "stage" | "row";
  /** Opens the review of the products it found. */
  onReview: (importId: string) => void;
}) {
  const running = isImportRunning(record);
  const { data, mutate } = useSWR<ProductVideoImportResponse>(
    productImportUrl(workspaceId, record.id),
    fetchProductImport,
    {
      // Photos come as signed links; refetching on focus would download
      // every photo again.
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      refreshInterval: running ? PRODUCT_IMPORT_POLL_MS : 0,
    }
  );
  // The list can learn that an import finished or failed before a realtime
  // event, or with none: its poll stops then, so ask for the products again.
  const detailStatus = data?.import.status;
  useEffect(() => {
    if (detailStatus && detailStatus !== record.status) void mutate();
  }, [detailStatus, record.status, mutate]);

  // A failure clears the stage; the step it failed at is the last one seen.
  const [lastStage, setLastStage] = useState(record.stage);
  if (record.stage && record.stage !== lastStage) setLastStage(record.stage);

  const products = data?.products;
  const drafts = useMemo(
    () => (products ?? []).filter(product => product.status === "draft"),
    [products]
  );
  const photos = useMemo(
    () => (products ? stagePhotos(products, record) : null),
    [products, record]
  );
  const shelf = useMemo(
    () => draftShelfInfo(products ?? [], record),
    [products, record]
  );
  const labelId = useId();
  const shelfId = useId();

  const text = stageText(record, products ? drafts.length : null);
  const check = text.check ? (
    <Button
      size={variant === "stage" ? "default" : "sm"}
      aria-describedby={labelId}
      onClick={() => onReview(record.id)}
    >
      {text.check === "found"
        ? PRODUCTS_COPY.stage.checkFound
        : PRODUCTS_COPY.checkProducts}
    </Button>
  ) : null;
  const photosMade =
    record.photoTotal > 0
      ? PRODUCTS_COPY.photosMade(record.photoDone, record.photoTotal)
      : null;

  if (variant === "row") {
    const phase = importPhase(record);
    return (
      <div data-import={record.id} data-variant="row">
        <VideoStatus
          thumb={
            <MiniStage
              imageUrl={
                (photos && latestMade(photos)?.imageUrl) ??
                record.presenter?.imageUrl ??
                null
              }
              alert={phase === "failed"}
            />
          }
          label={text.label}
          labelId={labelId}
          detail={
            phase === "cutting" || phase === "resuming"
              ? photosMade
              : running
                ? null
                : text.helper
          }
          percent={running ? importPercent(record) : null}
          alert={text.alert}
          actions={check}
        />
      </div>
    );
  }

  const rail = railState(
    record,
    lastStage,
    products ? drafts.length > 0 : record.draftsLeft
  );
  return (
    <div
      data-import={record.id}
      data-variant="stage"
      className="flex min-w-0 flex-col gap-10"
    >
      <div className={HERO}>
        <CreationStage
          mode="import"
          phase={importPhase(record)}
          label={text.label}
          labelId={labelId}
          helper={text.helper}
          alert={text.alert}
          percent={running ? importPercent(record) : null}
          preview={preview}
          photos={photos}
          presenter={record.presenter?.imageUrl ?? null}
          startedAt={record.createdAt}
          actions={check}
        />
        <StageRail
          current={rail.current}
          stopped={rail.stopped}
          busy={running}
          counts={photosMade ? { photos: photosMade } : undefined}
        />
      </div>
      {drafts.length > 0 ? (
        <div className="min-w-0">
          <ShelfHeading
            id={shelfId}
            title={PRODUCTS_COPY.found}
            note={PRODUCTS_COPY.foundNote}
          />
          <ProductShelf products={drafts} labelledBy={shelfId} drafts={shelf} />
        </div>
      ) : null}
    </div>
  );
}

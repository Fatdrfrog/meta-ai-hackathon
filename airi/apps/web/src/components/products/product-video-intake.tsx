"use client";

import { Button } from "@/components/ui/button";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import type {
  ProductVideoImportErrorCode,
  ProductVideoImportRecord,
  ProductVideoImportResponse,
} from "@/lib/products/types";
import { CircleAlert } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import useSWR from "swr";
import { ProductShelf, ShelfHeading } from "./product-shelf";
import { CreationStage, StageFilm, type StageThumb } from "./product-stage";
import { StageLedger } from "./product-stage-ledger";
import {
  draftShelfInfo,
  importPhase,
  latestMade,
  ledgerRows,
  railNotes,
  railState,
  splitSentences,
  stageHead,
  stagePhotos,
} from "./product-stage-model";
import { StageSteps } from "./product-stage-steps";
import styles from "./product-stage.module.css";
import { fetchProductImport, productImportUrl } from "./products-client";
import { isImportRunning, PRODUCT_IMPORT_POLL_MS } from "./use-product-imports";
import {
  previewFile,
  type ProductVideoUploadState,
} from "./use-product-video-upload";

// A video's way to the shelf: uploaded from this device, then read by the
// import job. The page puts one of them on its stage, a sheet with the
// video's first frame, the steps and what the owner said, with the products
// it found on a dashed shelf below; any others are rows.

// Failures that only another video can mend, once nothing was found.
const NEEDS_ANOTHER_VIDEO: ReadonlyArray<ProductVideoImportErrorCode> = [
  "video_too_long",
  "video_unreadable",
  "video_missing",
  "failed",
];

/** The video on its way up from this device, on the stage. */
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
    // What went wrong as the title, what to do as the line under it.
    const [title, rest] = splitSentences(
      PRODUCTS_COPY.uploadErrors[state.code]
    );
    return (
      <CreationStage
        mode="upload"
        phase="failed"
        label={title}
        helper={rest}
        alert
        percent={null}
        file={state.file}
        preview={state.preview}
        photos={null}
        steps={<StageSteps current="prepare" stopped="prepare" />}
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
  const sent = state.phase === "checking" ? 0 : state.sentBytes;
  const percent = Math.min(
    100,
    Math.round((sent / Math.max(1, state.file.size)) * 100)
  );
  return (
    <CreationStage
      mode="upload"
      phase="uploading"
      label={PRODUCTS_COPY.uploading}
      helper={PRODUCTS_COPY.stage.keepOpen}
      percent={null}
      fill={percent}
      sentBytes={sent}
      file={state.file}
      preview={state.preview}
      photos={null}
      steps={<StageSteps current="prepare" />}
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

/**
 * One import. On the stage: where it is, what the owner said as the
 * products are listed, each photo as it's made, and the products it found,
 * which stand on a dashed shelf until the owner checks them. As a row: a
 * card with a thumb of the video, a line on where it is, and what can be
 * done next.
 */
export function ImportProgress({
  workspaceId,
  record,
  preview,
  variant,
  onReview,
  onUploadAgain,
  onDismiss,
}: {
  workspaceId: string;
  record: ProductVideoImportRecord;
  /** The local file's link, when it was uploaded from this page. */
  preview: string | null;
  variant: "stage" | "row";
  /** Opens the review of the products it found. */
  onReview: (importId: string) => void;
  /** Chooses another video, for a row whose video gave no products. */
  onUploadAgain?: () => void;
  /** Puts a finished row with nothing left to check away. */
  onDismiss?: (importId: string) => void;
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
  const ledger = useMemo(
    () => (products && photos ? ledgerRows(products, photos) : null),
    [products, photos]
  );
  const labelId = useId();
  const shelfId = useId();

  const phase = importPhase(record);
  const head = stageHead(record, products ? drafts.length : null);
  const check = head.check ? (
    <Button
      size={variant === "stage" ? "default" : "sm"}
      // A finished import's check is the stage's one push. Products kept
      // after a failure are offered quietly, and so is a row's check: rose
      // is for one action on the page.
      variant={
        head.check === "found" || variant === "row" ? "outline" : "default"
      }
      aria-describedby={labelId}
      onClick={() => onReview(record.id)}
    >
      {head.check === "found"
        ? PRODUCTS_COPY.stage.checkFound
        : PRODUCTS_COPY.checkProducts}
    </Button>
  ) : null;
  // Photos made of all, while they're being made.
  const rail = railState(
    record,
    lastStage,
    products ? drafts.length > 0 : record.draftsLeft
  );
  const percent =
    running && rail.current === "photos" && record.photoTotal > 0
      ? (100 * Math.min(record.photoDone, record.photoTotal)) /
        record.photoTotal
      : null;
  const frame = record.presenter?.originalUrl ?? null;
  const presenter = record.presenter?.imageUrl ?? null;

  if (variant === "row") {
    const finished = !running && !head.check;
    const anotherVideo =
      finished &&
      record.productTotal === 0 &&
      (phase === "nothing" ||
        NEEDS_ANOTHER_VIDEO.includes(record.errorCode ?? "failed"));
    return (
      <ImportRow
        importId={record.id}
        thumb={
          <StageFilm
            size="row"
            preview={preview}
            frame={frame}
            still={photos ? latestMade(photos) : null}
            presenter={presenter}
          />
        }
        title={head.title}
        titleId={labelId}
        lines={head.lines}
        alert={head.alert}
        percent={percent}
        actions={
          check ||
          (anotherVideo && onUploadAgain) ||
          (finished && onDismiss) ? (
            <>
              {check}
              {anotherVideo && onUploadAgain ? (
                <Button size="sm" variant="outline" onClick={onUploadAgain}>
                  {PRODUCTS_COPY.stage.uploadAgain}
                </Button>
              ) : null}
              {finished && onDismiss ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onDismiss(record.id)}
                >
                  {PRODUCTS_COPY.dismiss}
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
    );
  }

  const notes = railNotes(record, rail);
  // Once it's ready, the photos of what's left to check, as filmed.
  const thumbs: StageThumb[] | null =
    phase === "ready"
      ? drafts.flatMap(product =>
          product.imageUrl
            ? [
                {
                  key: product.id,
                  url: product.imageUrl,
                  print:
                    product.options[product.featuredOption]?.photoMethod ===
                    "none",
                },
              ]
            : []
        )
      : null;
  return (
    <div
      data-import={record.id}
      data-variant="stage"
      className="flex min-w-0 flex-col gap-9 sm:gap-12"
    >
      <CreationStage
        mode="import"
        phase={phase}
        label={head.title}
        labelId={labelId}
        helper={head.lines}
        alert={head.alert}
        percent={percent}
        file={previewFile(preview)}
        preview={preview}
        frame={frame}
        photos={photos}
        presenter={presenter}
        startedAt={record.createdAt}
        finishedAt={record.finishedAt}
        thumbs={thumbs}
        steps={
          <StageSteps
            current={rail.current}
            stopped={rail.stopped}
            counts={notes.counts}
            results={notes.results}
          />
        }
        // Once Muse Spark has listed the products: before, there's only
        // what each step is doing.
        ledger={
          ledger && ledger.length > 0 ? <StageLedger rows={ledger} /> : null
        }
        actions={check}
      />
      {drafts.length > 0 ? (
        <div className="min-w-0">
          <ShelfHeading
            id={shelfId}
            title={PRODUCTS_COPY.found}
            note={PRODUCTS_COPY.foundNote}
            count={drafts.length}
          />
          <ProductShelf products={drafts} labelledBy={shelfId} drafts={shelf} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A video that isn't on the stage, as a card: a thumb of it, a line on
 * where it is (a failure marked in red ink), and what can be done next.
 * Rows never move; only the stage does.
 */
function ImportRow({
  importId,
  thumb,
  title,
  titleId,
  lines,
  alert,
  percent,
  actions,
}: {
  importId: string;
  thumb: ReactNode;
  title: string;
  titleId: string;
  lines: readonly string[];
  alert: boolean;
  percent: number | null;
  actions: ReactNode;
}) {
  return (
    <div data-import={importId} data-variant="row" className={styles.row}>
      <div className={styles.rowLayout}>
        {thumb}
        <div
          role={alert ? "alert" : undefined}
          aria-live={alert ? undefined : "polite"}
          className={styles.rowText}
        >
          <p id={titleId} className={styles.rowTitle}>
            {alert ? <CircleAlert aria-hidden="true" /> : null}
            <span>{title}</span>
          </p>
          {lines.length > 0 ? (
            <p className={styles.rowHelper}>{lines.join(" ")}</p>
          ) : null}
        </div>
        {actions ? <div className={styles.rowActions}>{actions}</div> : null}
      </div>
      {percent !== null ? (
        // The line under it says the same in words.
        <div aria-hidden="true" className={styles.line}>
          <span style={{ width: `${percent}%` }} />
        </div>
      ) : null}
    </div>
  );
}

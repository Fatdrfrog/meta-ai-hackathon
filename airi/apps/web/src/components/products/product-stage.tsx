"use client";

import { PRODUCTS_COPY } from "@/lib/products/copy";
import { cn } from "@/lib/utils";
import { CircleAlert, Film } from "lucide-react";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import {
  formatElapsed,
  formatSentOf,
  formatVideoSize,
  latestMade,
  madeKeys,
  newestLanded,
  type ImportPhase,
  type StagePhoto,
} from "./product-stage-model";
import styles from "./product-stage.module.css";
import theme from "./product-theme.module.css";

const COPY = PRODUCTS_COPY.stage;

export type StagePhase = ImportPhase | "uploading";

const RUNNING: ReadonlySet<StagePhase> = new Set<StagePhase>([
  "uploading",
  "queued",
  "preparing",
  "resuming",
  "listening",
  "watching",
  "cutting",
]);

/** A found product's photo, in the ready stage's strip. */
export type StageThumb = {
  key: string;
  url: string;
  /** A whole frame, as there was no clear view of it. */
  print: boolean;
};

// The ready stage's strip of found photos; the rest are counted at its end.
const THUMBS_SHOWN = 8;

const NO_PHOTOS: readonly StagePhoto[] = [];

/**
 * The newest photo made while the stage was on screen. Photos made before
 * it first saw the import's products never count, so a reload doesn't
 * replay them.
 */
function useLanded(photos: readonly StagePhoto[] | null): StagePhoto | null {
  const made = photos ? madeKeys(photos) : null;
  const [seen, setSeen] = useState<{
    made: string | null;
    landed: string | null;
  }>({ made, landed: null });
  if (photos && made !== null && made !== seen.made) {
    const landed =
      seen.made === null
        ? null
        : newestLanded(new Set(seen.made.split("\n")), photos);
    setSeen({ made, landed: landed?.key ?? seen.landed });
  }
  return (
    photos?.find(
      photo =>
        photo.key === seen.landed && photo.state === "made" && photo.imageUrl
    ) ?? null
  );
}

// A clock that ticks once a second while a stage shows how long it's taken.
const clock = {
  now: 0,
  timer: null as ReturnType<typeof setInterval> | null,
  listeners: new Set<() => void>(),
};
function subscribeClock(listener: () => void) {
  clock.listeners.add(listener);
  if (!clock.timer) {
    clock.now = Date.now();
    clock.timer = setInterval(() => {
      clock.now = Date.now();
      for (const notify of clock.listeners) notify();
    }, 1000);
  }
  return () => {
    clock.listeners.delete(listener);
    if (clock.listeners.size === 0 && clock.timer) {
      clearInterval(clock.timer);
      clock.timer = null;
    }
  };
}
const NO_CLOCK = () => () => undefined;

/** The seconds since `from`, while `active`; null on the server. */
function useElapsed(from: string | null, active: boolean): number | null {
  const now = useSyncExternalStore(
    active && from ? subscribeClock : NO_CLOCK,
    () => clock.now,
    () => 0
  );
  const start = from ? Date.parse(from) : Number.NaN;
  if (!active || now === 0 || !Number.isFinite(start)) return null;
  return Math.max(0, (now - start) / 1000);
}

/** How long a finished import took, or null without both times. */
function tookSeconds(from: string | null, to: string | null): number | null {
  const start = from ? Date.parse(from) : Number.NaN;
  const end = to ? Date.parse(to) : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return null;
  return (end - start) / 1000;
}

/**
 * A video's way to products, on a sheet of the page's own paper. On the
 * left, the video's real first frame; beside it, what's happening in words,
 * the five steps with the model doing each, and the ledger of what the owner
 * said as Muse Spark lists the products. It only ever shows what's real, and
 * nothing on it moves on its own: the time ticks, counts change, and photos
 * land. In a narrow column the frame shrinks to a thumb beside the title and
 * the rest stacks under them.
 */
export function CreationStage({
  mode,
  phase,
  label,
  labelId,
  helper = null,
  alert = false,
  percent,
  fill = null,
  sentBytes = null,
  file = null,
  preview,
  frame = null,
  photos,
  presenter = null,
  startedAt = null,
  finishedAt = null,
  thumbs = null,
  steps = null,
  ledger = null,
  actions = null,
}: {
  mode: "upload" | "import";
  phase: StagePhase;
  /** The stage's title. */
  label: string;
  labelId?: string;
  /** The lines under the title: what it's doing, or what to do next. */
  helper?: string | readonly string[] | null;
  alert?: boolean;
  /** Photos made of all, for the line along the bottom; null hides it. */
  percent: number | null;
  /** The share of the video sent, while it uploads. */
  fill?: number | null;
  /** The bytes sent so far, beside the share. */
  sentBytes?: number | null;
  /** The file uploaded from this page, for the caption under its frame. */
  file?: { name: string; size: number } | null;
  /** The local video, when it was uploaded from this page. */
  preview: string | null;
  /** A frame as filmed, for a video that wasn't uploaded from this page. */
  frame?: string | null;
  /** The import's photos, or null before its products load. */
  photos: readonly StagePhoto[] | null;
  /** The person who presented the products, cut out. */
  presenter?: string | null;
  /** When the import was created, for the time it has taken so far. */
  startedAt?: string | null;
  /** When it finished, for the time it took. */
  finishedAt?: string | null;
  /** The photos of the products it found, once it's ready to check. */
  thumbs?: readonly StageThumb[] | null;
  /** The steps (StageSteps), under the title. */
  steps?: ReactNode;
  /** What the owner said (StageLedger), under the steps. */
  ledger?: ReactNode;
  actions?: ReactNode;
}) {
  const running = RUNNING.has(phase);
  const list = photos ?? NO_PHOTOS;
  const landed = useLanded(photos);
  const elapsed = useElapsed(startedAt, mode === "import" && running);
  const took =
    mode === "import" && !running ? tookSeconds(startedAt, finishedAt) : null;
  const time =
    elapsed !== null
      ? COPY.soFar(formatElapsed(elapsed))
      : took !== null
        ? COPY.took(formatElapsed(took))
        : null;
  // A running import goes on without the page: the owner needn't wait.
  const lines = [
    ...(typeof helper === "string" ? [helper] : (helper ?? [])),
    ...(mode === "import" && running ? [COPY.leave] : []),
  ];
  const uploading = mode === "upload" && phase === "uploading";
  const still = landed ?? latestMade(list);

  return (
    <section
      aria-labelledby={labelId}
      data-canvas={mode}
      data-phase={phase}
      className={cn(styles.stage, theme.sheet)}
    >
      <div className={styles.layout}>
        <StageFilm
          preview={preview}
          frame={frame}
          still={still}
          presenter={presenter}
          file={file}
        />
        <div
          role={alert ? "alert" : undefined}
          aria-live={alert ? undefined : "polite"}
          className={styles.head}
        >
          <div className={styles.titleRow}>
            <h2
              id={labelId}
              data-alert={alert ? "" : undefined}
              className={styles.title}
            >
              {alert ? (
                <CircleAlert aria-hidden="true" className={styles.alertIcon} />
              ) : null}
              <span>{label}</span>
            </h2>
            {time ? (
              // Not announced: it changes every second.
              <span aria-hidden="true" className={styles.time}>
                {time}
              </span>
            ) : null}
          </div>
          {lines.length > 0 ? (
            <p className={styles.doing}>
              {lines.map((line, index) => (
                <span key={index}>
                  {index > 0 ? " " : null}
                  {line}
                </span>
              ))}
            </p>
          ) : null}
        </div>
        <div className={styles.rest}>
          {uploading ? (
            <UploadLine
              label={label}
              fill={fill ?? 0}
              sentBytes={sentBytes}
              size={file?.size ?? null}
              actions={actions}
            />
          ) : null}
          {thumbs && thumbs.length > 0 ? <ThumbStrip thumbs={thumbs} /> : null}
          {actions && !uploading ? (
            <div className={styles.actions}>{actions}</div>
          ) : null}
          {steps}
          {ledger}
        </div>
      </div>
      {percent !== null ? (
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          className={styles.line}
        >
          <span style={{ width: `${clampPercent(percent)}%` }} />
        </div>
      ) : null}
    </section>
  );
}

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

/** The video on its way up: a bar, how much is sent, and what can be done. */
function UploadLine({
  label,
  fill,
  sentBytes,
  size,
  actions,
}: {
  label: string;
  fill: number;
  sentBytes: number | null;
  size: number | null;
  actions: ReactNode;
}) {
  const percent = Math.round(clampPercent(fill));
  const text =
    size !== null
      ? COPY.sent(percent, formatSentOf(sentBytes ?? 0, size))
      : `${percent}%`;
  return (
    <div className={styles.upload}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={text}
        className={styles.uploadTrack}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <span className={styles.uploadText}>{text}</span>
      {actions ? <div className={styles.uploadActions}>{actions}</div> : null}
    </div>
  );
}

/** The photos of the products a ready import found, on wall tiles. */
function ThumbStrip({ thumbs }: { thumbs: readonly StageThumb[] }) {
  const more = thumbs.length - THUMBS_SHOWN;
  return (
    // The ledger and the shelf below name them; these only show them.
    <ul aria-hidden="true" className={styles.thumbs}>
      {thumbs.slice(0, THUMBS_SHOWN).map(thumb => (
        <ThumbTile key={thumb.key} thumb={thumb} />
      ))}
      {more > 0 ? (
        <li className={styles.thumbMore}>{COPY.morePhotos(more)}</li>
      ) : null}
    </ul>
  );
}

function ThumbTile({ thumb }: { thumb: StageThumb }) {
  const [broken, setBroken] = useState<string | null>(null);
  return (
    <li data-print={thumb.print ? "" : undefined}>
      {thumb.url !== broken ? (
        // Signed storage URLs; next/image would need every bucket host configured.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumb.url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setBroken(thumb.url)}
        />
      ) : null}
    </li>
  );
}

type FilmPicture =
  | { kind: "video"; url: string }
  | { kind: "frame"; url: string }
  | { kind: "still"; url: string; print: boolean }
  | { kind: "none" };

/**
 * A video's own picture, sharp: the local file's first frame; for a video
 * sent another way, the frame its presenter was cut from; or else the newest
 * photo made, standing on a wall tile; or paper with a film mark. On a phone
 * and in a row it's a thumb; on the wide stage it carries the video's length
 * and its file's name and size.
 */
export function StageFilm({
  preview,
  frame = null,
  still = null,
  presenter = null,
  file = null,
  size = "stage",
}: {
  preview: string | null;
  frame?: string | null;
  still?: Pick<StagePhoto, "imageUrl" | "method"> | null;
  presenter?: string | null;
  file?: { name: string; size: number } | null;
  size?: "stage" | "row";
}) {
  // Links that failed to load, so the next picture stands in for them: a
  // file the browser can't play, such as HEVC in Chrome on Windows, or an
  // expired signed link.
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  const [length, setLength] = useState<{ url: string; seconds: number } | null>(
    null
  );
  const usable = (url: string | null | undefined): url is string =>
    !!url && !broken.has(url);
  const breaks = (url: string) => () =>
    setBroken(current => new Set(current).add(url));

  const stillUrl = still?.imageUrl ?? null;
  const picture: FilmPicture = usable(preview)
    ? { kind: "video", url: preview }
    : usable(frame)
      ? { kind: "frame", url: frame }
      : usable(stillUrl)
        ? { kind: "still", url: stillUrl, print: still?.method === "none" }
        : usable(presenter)
          ? { kind: "still", url: presenter, print: false }
          : { kind: "none" };
  const seconds =
    picture.kind === "video" && length?.url === picture.url
      ? length.seconds
      : null;

  return (
    <figure data-size={size} data-film={picture.kind} className={styles.film}>
      <div aria-hidden="true" className={styles.filmFrame}>
        {picture.kind === "video" ? (
          // Paused on its first frame: nothing on the stage plays by itself.
          <video
            key={picture.url}
            src={`${picture.url}#t=0.1`}
            muted
            playsInline
            preload="metadata"
            tabIndex={-1}
            onLoadedMetadata={event => {
              const { duration } = event.currentTarget;
              if (Number.isFinite(duration))
                setLength({ url: picture.url, seconds: duration });
            }}
            onError={breaks(picture.url)}
            className={styles.arrive}
          />
        ) : picture.kind === "frame" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={picture.url}
            src={picture.url}
            alt=""
            decoding="async"
            draggable={false}
            onError={breaks(picture.url)}
            className={styles.arrive}
          />
        ) : picture.kind === "still" ? (
          <span
            key={picture.url}
            data-print={picture.print ? "" : undefined}
            className={cn(styles.filmWall, styles.arrive)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={picture.url}
              alt=""
              decoding="async"
              draggable={false}
              onError={breaks(picture.url)}
            />
          </span>
        ) : (
          <span className={styles.filmEmpty}>
            <Film strokeWidth={1.5} />
          </span>
        )}
        {seconds !== null ? (
          <span className={styles.filmTime}>{formatElapsed(seconds)}</span>
        ) : null}
      </div>
      {file && size === "stage" ? (
        <figcaption className={styles.filmCaption}>
          <span dir="auto" title={file.name} className={styles.filmName}>
            {file.name}
          </span>
          <span className={styles.filmSize}>
            {` · ${formatVideoSize(file.size)}`}
          </span>
        </figcaption>
      ) : null}
    </figure>
  );
}

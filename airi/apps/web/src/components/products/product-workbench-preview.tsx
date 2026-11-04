"use client";

import { PRODUCTS_COPY } from "@/lib/products/copy";
import type { ProductTemplate } from "@/lib/products/templates";
import type { ProductAdRecord } from "@/lib/products/types";
import { cn } from "@/lib/utils";
import {
  ChevronLeft,
  ChevronRight,
  Heart,
  MessageCircle,
  RefreshCw,
  Send,
} from "lucide-react";
import { useState } from "react";
import styles from "./product-workbench.module.css";

// The workbench's preview: the result in the frame it will appear in. An
// Instagram Reel or Story (the ad's video, or a 9:16 picture), an Instagram
// feed post (4:5) or carousel with its dots, or a Facebook feed ad with the
// WhatsApp button. On a Reel or a video Story the opening sticker carries a
// small cycle badge: a tap moves to Muse Spark's next opening (and the
// ending, on its own pill, the same way). The frames are pictures of the
// output, so they keep the platforms' own light look in both themes.

const COPY = PRODUCTS_COPY.workbench;

/** One picture shown in a frame. */
export type WorkbenchPicture = { url: string; alt: string };

/** A sticker the preview cycles: the words shown now, and Muse Spark's options. */
export type WorkbenchCycle = {
  text: string;
  index: number;
  count: number;
  onNext: () => void;
  disabled: boolean;
};

export type WorkbenchPreviewProps = {
  template: Pick<ProductTemplate, "frame" | "format" | "renderer">;
  ad: Pick<ProductAdRecord, "video" | "post" | "ctwa">;
  /** The pictures the tile shows: one for a post or a picture Story, 2 to 4 for a carousel. */
  pictures: readonly WorkbenchPicture[];
  /** The Instagram @name, or the Facebook Page's name for the ad. */
  account: string;
  caption: string | null;
  opening?: WorkbenchCycle | null;
  ending?: WorkbenchCycle | null;
};

/** The first letter of an account, for its round avatar. */
const initial = (name: string) =>
  (name.replace(/^@/, "").trim()[0] ?? "A").toUpperCase();

function CycleSticker({
  cycle,
  label,
  className,
}: {
  cycle: WorkbenchCycle;
  label: (index: number, count: number) => string;
  className: string;
}) {
  const interactive = cycle.count > 1;
  if (!interactive)
    return (
      <span className={className}>
        <span className={styles.stickerText}>{cycle.text}</span>
      </span>
    );
  return (
    <button
      type="button"
      className={className}
      onClick={cycle.onNext}
      disabled={cycle.disabled}
      aria-label={`${cycle.text}. ${label(cycle.index, cycle.count)}`}
    >
      <span className={styles.stickerText}>{cycle.text}</span>
      <span className={styles.cycleBadge} aria-hidden="true">
        <RefreshCw />
      </span>
    </button>
  );
}

/** The ad's video in its frame, never looping; the browser's controls play it. */
function FrameVideo({
  video,
}: {
  video: NonNullable<ProductAdRecord["video"]> | null;
}) {
  if (!video) return <p className={styles.frameNote}>{COPY.frames.noVideo}</p>;
  return (
    <video
      className={styles.frameMedia}
      src={video.url}
      poster={video.posterUrl ?? undefined}
      controls
      playsInline
      preload="metadata"
      aria-label={PRODUCTS_COPY.ad.player}
    />
  );
}

function FramePicture({ picture }: { picture: WorkbenchPicture | undefined }) {
  if (!picture)
    return <p className={styles.frameNote}>{COPY.frames.noPicture}</p>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={styles.frameMedia}
      src={picture.url}
      alt={picture.alt}
      decoding="async"
    />
  );
}

/** The result as it will appear on Meta. */
export function WorkbenchPreview({
  template,
  ad,
  pictures,
  account,
  caption,
  opening = null,
  ending = null,
}: WorkbenchPreviewProps) {
  const [slide, setSlide] = useState(0);
  const count = pictures.length;
  const shown = Math.min(slide, Math.max(0, count - 1));
  const video = template.format === "video";
  const firstLine = caption?.split("\n").find(line => line.trim()) ?? null;

  if (template.frame === "ig_reel" || template.frame === "ig_story") {
    const story = template.frame === "ig_story";
    return (
      <div className={styles.videoPreview}>
        <div className={styles.phone} data-frame={template.frame}>
          {video ? (
            <FrameVideo video={ad.video} />
          ) : (
            <FramePicture picture={pictures[0]} />
          )}
          <div className={styles.phoneTop} aria-hidden="true">
            {story ? (
              <span className={styles.storyBar} />
            ) : (
              <span className={styles.frameLabel}>{COPY.frames.reels}</span>
            )}
          </div>
          <div className={styles.phoneFoot} aria-hidden="true">
            <span className={styles.phoneAccount}>
              <span className={styles.avatar}>{initial(account)}</span>
              <span className={styles.accountName}>{account}</span>
              {story ? null : (
                <span className={styles.follow}>{COPY.frames.follow}</span>
              )}
            </span>
            {!story && firstLine ? (
              <span className={styles.phoneCaption}>{firstLine}</span>
            ) : null}
          </div>
          {story ? null : (
            <div className={styles.phoneRail} aria-hidden="true">
              <Heart />
              <MessageCircle />
              <Send />
            </div>
          )}
        </div>
        {video && (opening || ending) ? (
          <div className={styles.videoCycles}>
            {opening ? (
              <CycleSticker
                cycle={opening}
                label={COPY.cycle.opening}
                className={styles.openingSticker}
              />
            ) : null}
            {ending ? (
              <CycleSticker
                cycle={ending}
                label={COPY.cycle.ending}
                className={styles.endingSticker}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  if (template.frame === "fb_ad") {
    const ctwa = ad.ctwa;
    return (
      <article className={styles.fbAd}>
        <header className={styles.feedHead}>
          <span className={styles.avatar}>{initial(account)}</span>
          <span className={styles.feedWho}>
            <span className={styles.accountName}>{account}</span>
            <span className={styles.sponsored}>{COPY.frames.sponsored}</span>
          </span>
        </header>
        {ctwa?.primaryText ? (
          <p className={styles.fbText}>{ctwa.primaryText}</p>
        ) : null}
        <div className={styles.fbMedia}>
          {video ? (
            <FrameVideo video={ad.video} />
          ) : (
            <FramePicture picture={pictures[0]} />
          )}
        </div>
        <footer className={styles.fbFoot}>
          <span className={styles.fbHeadline}>{ctwa?.headline ?? ""}</span>
          <span className={styles.fbButton}>{COPY.frames.whatsapp}</span>
        </footer>
      </article>
    );
  }

  // Instagram feed: one 4:5 picture, or a carousel of them.
  const carousel = template.frame === "ig_carousel" && count > 1;
  return (
    <article className={styles.feed}>
      <header className={styles.feedHead}>
        <span className={styles.avatar}>{initial(account)}</span>
        <span className={styles.feedWho}>
          <span className={styles.accountName}>{account}</span>
        </span>
      </header>
      <div className={styles.feedMedia}>
        <FramePicture picture={pictures[shown]} />
        {carousel ? (
          <>
            <button
              type="button"
              className={cn(styles.slideNav, styles.slidePrev)}
              aria-label={COPY.frames.previous}
              disabled={shown === 0}
              onClick={() => setSlide(Math.max(0, shown - 1))}
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <button
              type="button"
              className={cn(styles.slideNav, styles.slideNext)}
              aria-label={COPY.frames.next}
              disabled={shown >= count - 1}
              onClick={() => setSlide(Math.min(count - 1, shown + 1))}
            >
              <ChevronRight aria-hidden="true" />
            </button>
            <span className={styles.slideCount} aria-live="polite">
              {COPY.frames.slide(shown, count)}
            </span>
          </>
        ) : null}
      </div>
      {carousel ? (
        <div className={styles.dots} aria-hidden="true">
          {pictures.map((picture, index) => (
            <span
              key={`${index}-${picture.url}`}
              className={styles.dot}
              data-on={index === shown || undefined}
            />
          ))}
        </div>
      ) : null}
      {caption ? (
        <p className={styles.feedCaption}>
          <span className={styles.accountName}>{account}</span> {caption}
        </p>
      ) : null}
    </article>
  );
}

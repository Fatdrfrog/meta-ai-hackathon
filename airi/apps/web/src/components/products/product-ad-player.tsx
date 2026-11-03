"use client";

import { PRODUCTS_COPY } from "@/lib/products/copy";
import type { ProductAdRecord } from "@/lib/products/types";
import { useEffect, useRef, useState } from "react";
import { AdToggle } from "./product-ad-parts";
import styles from "./product-ad-studio.module.css";

// The finished ad in a 9:16 frame with the browser's own controls (the
// keyboard plays, pauses and seeks it), letterboxed in paper rather than
// black. "Reels safe zones" lays Meta's guides over it: the top 14% under
// the Reels header and the bottom 35% under the caption and buttons, 6% at
// the sides, where the ad keeps its words out of.

const COPY = PRODUCTS_COPY.ad;

export function AdPlayer({
  video,
}: {
  video: NonNullable<ProductAdRecord["video"]> | null;
}) {
  const [safe, setSafe] = useState(false);
  const [sound, setSound] = useState(true);
  const element = useRef<HTMLVideoElement>(null);
  // React sets `muted` only once; the switch sets it on the element.
  useEffect(() => {
    if (element.current) element.current.muted = !sound;
  }, [sound]);
  return (
    <figure className={styles.player}>
      <div className={styles.frame}>
        {video ? (
          <video
            ref={element}
            src={video.url}
            poster={video.posterUrl ?? undefined}
            controls
            playsInline
            preload="metadata"
            aria-label={COPY.player}
            // The controls' own mute button keeps the switch in step.
            onVolumeChange={event => setSound(!event.currentTarget.muted)}
          />
        ) : (
          <p className={styles.frameNote}>{COPY.videoMissing}</p>
        )}
        {safe ? (
          <div className={styles.safe} aria-hidden="true">
            <div className={styles.safeTop}>
              <span>{COPY.safeTop}</span>
            </div>
            <div className={styles.safeLeft} />
            <div className={styles.safeRight} />
            <div className={styles.safeBottom}>
              <span>{COPY.safeBottom}</span>
            </div>
          </div>
        ) : null}
      </div>
      <div className={styles.toggles}>
        <AdToggle checked={safe} onChange={setSafe}>
          {COPY.safeZones}
        </AdToggle>
        <AdToggle checked={sound} onChange={setSound} disabled={!video}>
          {COPY.sound}
        </AdToggle>
      </div>
    </figure>
  );
}

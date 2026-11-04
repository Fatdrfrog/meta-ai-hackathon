"use client";

import { PRODUCTS_COPY } from "@/lib/products/copy";
import type { ProductTemplate } from "@/lib/products/templates";
import {
  formatProductPrice,
  productPriceLength,
  PRODUCT_AD_STUDIO_COLOURWAYS,
  PRODUCT_AD_STUDIO_SWEEPS,
  type WorkspaceProductRecord,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import { useState, type CSSProperties, type ReactNode } from "react";
import { initialOf } from "./product-shelf";
import styles from "./product-gallery.module.css";

const ART = PRODUCTS_COPY.gallery.art;

// The template tiles' preview art (studio v3), drawn in CSS from the owner's
// own picks: their cut-outs, code-drawn price tags, Paper backdrops and the
// frames they were filmed in. It costs nothing, asks for nothing, and redraws
// at once when the picks change. Once the ad for these picks exists, a tile
// shows its real poster or still instead (`real`). Every text on it is the
// owner's own (names, prices drawn by code) or Meta's chrome, never words
// made up for them.

/** A product's price as a tag reads it; an empty string without one. */
export function tagText(product: WorkspaceProductRecord): string {
  return product.price === null
    ? ""
    : formatProductPrice(product.price, {
        from: product.priceIsFrom,
        currency: product.currency,
      });
}

/** A cut-out (or the whole frame it was found in), or its first letter. */
function Cut({
  product,
  className,
}: {
  product: WorkspaceProductRecord;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const url = product.imageUrl;
  if (!url || failed === url)
    return (
      <span aria-hidden="true" className={cn(styles.artInitial, className)}>
        {initialOf(product.name)}
      </span>
    );
  return (
    // Signed storage URLs; next/image would need every bucket host configured.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(url)}
      data-print={product.hasCutout === false || undefined}
      className={cn(styles.artCut, className)}
    />
  );
}

function Tag({
  product,
  className,
}: {
  product: WorkspaceProductRecord;
  className?: string;
}) {
  const text = tagText(product);
  return text ? (
    <span
      data-price-length={productPriceLength(text)}
      className={cn(styles.artTag, className)}
    >
      {text}
    </span>
  ) : null;
}

/** The frame the result appears in: its shape, and Meta's chrome around it. */
function Frame({
  template,
  children,
  shots = 1,
}: {
  template: ProductTemplate;
  children: ReactNode;
  /** How many shots a video has, for its progress marks. */
  shots?: number;
}) {
  const marks = Array.from({ length: Math.max(1, Math.min(shots, 10)) });
  return (
    <span
      aria-hidden="true"
      data-frame={template.frame}
      className={styles.artFrame}
    >
      {children}
      {template.frame === "ig_story" ? (
        <span className={styles.artBars}>
          {marks.map((_, index) => (
            <span key={index} data-first={index === 0 || undefined} />
          ))}
        </span>
      ) : null}
      {template.frame === "ig_reel" ? (
        <span className={styles.artDots}>
          {marks.map((_, index) => (
            <span key={index} data-first={index === 0 || undefined} />
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** A Facebook feed ad with its WhatsApp button, around the picture or video. */
function FacebookAd({
  children,
  video,
}: {
  children: ReactNode;
  video: boolean;
}) {
  return (
    <span className={styles.fbAd}>
      <span className={styles.fbHead}>
        <span className={styles.fbAvatar} />
        <span className={styles.fbLines}>
          <span />
          <span />
        </span>
      </span>
      <span className={styles.fbMedia}>
        {children}
        {video ? <span className={styles.artPlay} /> : null}
      </span>
      <span className={styles.fbFoot}>
        <span className={styles.fbLine} />
        <span className={styles.fbButton}>{ART.whatsapp}</span>
      </span>
    </span>
  );
}

/** A real picture of the result, filling its place. */
function Real({ url }: { url: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      className={styles.artReal}
    />
  );
}

/** The studio sweep a pick stands on: the colourways in turn, from white. */
function sweepOf(rotation: number): CSSProperties {
  const colourway =
    PRODUCT_AD_STUDIO_COLOURWAYS[
      rotation % PRODUCT_AD_STUDIO_COLOURWAYS.length
    ] ?? "white";
  const sweep = PRODUCT_AD_STUDIO_SWEEPS[colourway];
  return {
    "--sweep-top": sweep.top,
    "--sweep-bottom": sweep.bottom,
    "--sweep-ink": sweep.ink,
  } as CSSProperties;
}

/**
 * A tile's art. `picks` are the picks the tile uses, in pick order; a
 * single-product tile shows pick `rotation` mod their count, so the gallery
 * shows variety. `frames` are the frames the picks were filmed in, by id.
 */
export function TileArt({
  template,
  picks,
  rotation,
  frames,
  real = null,
}: {
  template: ProductTemplate;
  picks: readonly WorkspaceProductRecord[];
  rotation: number;
  frames: ReadonlyMap<string, string>;
  real?: string | null;
}) {
  const one = picks.length > 0 ? picks[rotation % picks.length]! : null;
  const first = picks[0] ?? null;
  const shots = picks.length;

  if (!one || !first)
    return (
      <Frame template={template}>
        <span className={styles.artEmpty} />
      </Frame>
    );

  if (real) {
    if (template.frame === "fb_ad")
      return (
        <Frame template={template}>
          <FacebookAd video={template.format === "video"}>
            <Real url={real} />
          </FacebookAd>
        </Frame>
      );
    return (
      <Frame template={template} shots={shots}>
        <Real url={real} />
        {template.format === "video" ? (
          <span className={styles.artPlay} />
        ) : null}
      </Frame>
    );
  }

  switch (template.id) {
    case "reel_shelf":
      return (
        <Frame template={template} shots={shots}>
          <span className={styles.artScene}>
            <span className={cn(styles.artStand, styles.artPush)}>
              <Cut product={first} />
            </span>
            <span className={styles.artPlank} />
            <Tag product={first} className={styles.artTagCorner} />
          </span>
        </Frame>
      );
    case "reel_filmed_sold": {
      const frame = frames.get(first.id) ?? null;
      return (
        <Frame template={template} shots={shots}>
          <span className={styles.artScene}>
            <span className={cn(styles.artStand, styles.artPush)}>
              <Cut product={first} />
            </span>
            <span className={styles.artPlank} />
            <Tag product={first} className={styles.artTagCorner} />
          </span>
          <span className={cn(styles.artFilmed, styles.artWipe)}>
            {frame ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={frame} alt="" loading="lazy" draggable={false} />
            ) : (
              <span className={styles.artFilmedBlur}>
                <Cut product={first} />
              </span>
            )}
            <span className={styles.artRec}>{ART.rec}</span>
          </span>
        </Frame>
      );
    }
    case "reel_float":
      return (
        <Frame template={template} shots={shots}>
          <span className={styles.artWall}>
            <span className={cn(styles.artStand, styles.artBob)}>
              <Cut product={first} />
            </span>
            <span className={styles.artShadow} />
            <Tag product={first} className={styles.artTagLow} />
          </span>
        </Frame>
      );
    case "reel_pop":
      return (
        <Frame template={template} shots={shots}>
          <span className={styles.artBlurred}>
            <Cut product={first} />
          </span>
          <span className={cn(styles.artStand, styles.artPop)}>
            <Cut product={first} />
          </span>
          <Tag product={first} className={styles.artTagCorner} />
        </Frame>
      );
    case "story_video":
      return (
        <Frame template={template} shots={shots}>
          <span className={styles.artScene}>
            <span className={cn(styles.artStand, styles.artPush)}>
              <Cut product={first} />
            </span>
            <span className={styles.artPlank} />
            <Tag product={first} className={styles.artTagCorner} />
          </span>
          <span className={styles.artPlay} />
        </Frame>
      );
    case "story_price_list":
      return (
        <Frame template={template} shots={1}>
          <span className={styles.artList}>
            {picks.slice(0, 5).map(product => (
              <span key={product.id} className={styles.artListRow}>
                <span className={styles.artListCut}>
                  <Cut product={product} />
                </span>
                <span className={styles.artListName} dir="auto">
                  {product.name}
                </span>
                <span className={styles.artListLeader} />
                <span className={styles.artListPrice}>
                  {tagText(product) || "—"}
                </span>
              </span>
            ))}
          </span>
        </Frame>
      );
    case "story_big_price":
    case "post_big_price":
      return (
        <Frame template={template} shots={1}>
          <span className={styles.artBig}>
            <span
              data-price-length={productPriceLength(tagText(one))}
              className={styles.artBigPrice}
            >
              {tagText(one) || "—"}
            </span>
            <span className={styles.artStand}>
              <Cut product={one} />
            </span>
          </span>
        </Frame>
      );
    case "post_room":
      return (
        <Frame template={template}>
          <span className={styles.artRoom}>
            <span className={styles.artStand}>
              <Cut product={one} />
            </span>
            <span className={styles.artRoomLabel}>
              <span dir="auto">{one.name}</span>
              <Tag product={one} />
            </span>
          </span>
        </Frame>
      );
    case "post_studio":
      return (
        <Frame template={template}>
          <span className={styles.artStudio} style={sweepOf(rotation)}>
            <span className={styles.artStand}>
              <Cut product={one} />
            </span>
            <span className={styles.artStudioLabel}>
              <span dir="auto">{one.name}</span>
              <span>{tagText(one)}</span>
            </span>
          </span>
        </Frame>
      );
    case "post_collection":
      return (
        <Frame template={template}>
          <span className={styles.artCollection}>
            <span className={styles.artCollectionRow}>
              {picks.slice(0, 3).map(product => (
                <span key={product.id} className={styles.artCollectionBay}>
                  <span className={styles.artStand}>
                    <Cut product={product} />
                  </span>
                  <Tag product={product} className={styles.artTagSmall} />
                </span>
              ))}
            </span>
            <span className={styles.artPlank} />
          </span>
        </Frame>
      );
    case "post_carousel":
      return (
        <Frame template={template}>
          <span className={styles.artCarousel}>
            {picks
              .slice(0, 3)
              .reverse()
              .map((product, index, list) => (
                <span
                  key={product.id}
                  className={styles.artCard}
                  style={
                    {
                      "--card": list.length - 1 - index,
                    } as CSSProperties
                  }
                >
                  <span className={styles.artStand}>
                    <Cut product={product} />
                  </span>
                  <Tag product={product} className={styles.artTagSmall} />
                </span>
              ))}
          </span>
          <span className={styles.artCarouselDots}>
            {picks.slice(0, 4).map((product, index) => (
              <span key={product.id} data-first={index === 0 || undefined} />
            ))}
          </span>
        </Frame>
      );
    case "ctwa_video":
    case "ctwa_picture":
      return (
        <Frame template={template}>
          <FacebookAd video={template.id === "ctwa_video"}>
            <span className={styles.artRoom}>
              <span className={styles.artStand}>
                <Cut product={template.id === "ctwa_video" ? first : one} />
              </span>
              <Tag
                product={template.id === "ctwa_video" ? first : one}
                className={styles.artTagCorner}
              />
            </span>
          </FacebookAd>
        </Frame>
      );
    case "chat_kit":
      return (
        <Frame template={template}>
          <span className={styles.chat}>
            <span className={styles.chatBubble}>
              <span />
              <span />
            </span>
            <span className={styles.chatCards}>
              {picks.slice(0, 3).map(product => (
                <span key={product.id} className={styles.chatCard}>
                  <span className={styles.chatCardPhoto}>
                    <Cut product={product} />
                  </span>
                  <span className={styles.chatCardPrice}>
                    {tagText(product) || "—"}
                  </span>
                  <span className={styles.chatCardButton} />
                </span>
              ))}
            </span>
          </span>
        </Frame>
      );
  }
}

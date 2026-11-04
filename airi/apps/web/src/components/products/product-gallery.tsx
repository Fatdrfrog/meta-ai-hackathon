"use client";

import { useDroppable } from "@dnd-kit/core";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  productTemplateAvailable,
  productTemplateGroups,
  productTemplatePicks,
  type ProductTemplate,
  type ProductTemplateGroup,
  type ProductTemplateId,
  type ProductTemplateStamp,
} from "@/lib/products/templates";
import type {
  ProductAdRecord,
  WorkspaceProductRecord,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import {
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Hand,
  Images,
  Instagram,
  Megaphone,
  MessageCircle,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import styles from "./product-gallery.module.css";
import { TileArt } from "./product-tile-art";

// Studio v3's gallery: the template tiles, grouped by the Meta destination
// each ends in, every one drawn from the owner's own picks. A tap on a tile
// (or Enter, or dropping the picks on it) makes it; its workbench opens under
// the tile's group row, with a notch pointing at the tile.

const COPY = PRODUCTS_COPY.gallery;

const GROUP_ICONS: Record<ProductTemplateGroup, typeof Instagram> = {
  reel: Clapperboard,
  story: Instagram,
  post: Images,
  whatsapp_ad: Megaphone,
  whatsapp_chat: MessageCircle,
};

/** The DOM id of a tile, for the workbench's label and the focus's return. */
export const galleryTileId = (prefix: string, id: ProductTemplateId) =>
  `${prefix}-tile-${id}`;

/** What a drop on a tile carries: the template it makes. */
export type GalleryDropData = { templateId: ProductTemplateId };

export type ProductGalleryProps = {
  /** Prefix of the tiles' DOM ids (galleryTileId). */
  idPrefix: string;
  /** Every pick on the shelf, in pick order. */
  picks: readonly WorkspaceProductRecord[];
  /** The picks a video ad would show: the first that can go in one. */
  adPicks: readonly WorkspaceProductRecord[];
  /** The frames the picks were filmed in, by product id. */
  frames: ReadonlyMap<string, string>;
  /** The ad these picks already made, if any: its real pictures and its stills. */
  ad: ProductAdRecord | null;
  /**
   * Whether `ad` is the ad's own read, which carries its stills. The made
   * list's read leaves them out, so it never hides a still tile. True when
   * left out.
   */
  adStillsRead?: boolean;
  /** Each tile's stamp, once something from it is out on Meta. */
  stamps: ReadonlyMap<ProductTemplateId, ProductTemplateStamp>;
  /** Why a tile that needs a new ad can't make one now (AI off); null when it can. */
  locked: string | null;
  /** The picks changed since the ad open last: tiles mark "new". */
  newPicks: boolean;
  /** The tile whose workbench is open. */
  openId: ProductTemplateId | null;
  /** The open tile's workbench, put under its group row. */
  workbench: ReactNode;
  /** The picks are being carried: tiles that take them show it. */
  carrying: boolean;
  onMake: (template: ProductTemplate) => void;
};

/** The real picture a tile can show for the ad these picks made. */
function realPicture(
  template: ProductTemplate,
  ad: ProductAdRecord | null,
  one: WorkspaceProductRecord | null
): string | null {
  if (!ad || template.makes !== "ad") return null;
  const poster = ad.video?.posterUrl ?? null;
  if (template.renderer === "motion")
    return template.motion === ad.motion ? poster : null;
  if (template.renderer === "video") return poster;
  const stills = ad.stills.templates ?? [];
  if (template.renderer === "carousel")
    return (
      stills.find(
        still => still.kind === "collection" && still.format === "feed"
      )?.url ?? null
    );
  if (!template.stillKind || !template.stillFormat) return null;
  const match = stills.find(
    still =>
      still.kind === template.stillKind &&
      still.format === template.stillFormat &&
      (still.productId === null || still.productId === one?.id)
  );
  if (match) return match.url;
  return template.stillKind === "room" && one?.id === ad.products[0]?.productId
    ? ad.stills.feedUrl
    : null;
}

export function ProductGallery({
  idPrefix,
  picks,
  adPicks,
  frames,
  ad,
  adStillsRead = true,
  stamps,
  locked,
  newPicks,
  openId,
  workbench,
  carrying,
  onMake,
}: ProductGalleryProps) {
  // A still tile hides only once a render of the ad landed without that
  // still (a worker from before v3): never while the first video is made,
  // which would empty the Post row for a minute, nor from the made list's
  // read, which leaves the stills out.
  const drawn = ad && ad.video && adStillsRead ? ad : null;
  const groups = productTemplateGroups()
    .map(entry => ({
      ...entry,
      // The open tile stays, whatever the ad drew: its workbench says why.
      templates: entry.templates.filter(
        template =>
          template.id === openId || productTemplateAvailable(template, drawn)
      ),
    }))
    .filter(entry => entry.templates.length > 0);

  // The workbench starts on the first pick too. A tile must show the same
  // product it opens; other products are chosen in the workbench's rail.
  return (
    <div
      role="region"
      aria-label={COPY.label}
      data-carrying={carrying || undefined}
      className={styles.groups}
    >
      {groups.map(entry => {
        const open = entry.templates.some(template => template.id === openId);
        const tiles = entry.templates.map(template => {
          const tilePicks =
            template.makes === "ad"
              ? productTemplatePicks(template, adPicks)
              : productTemplatePicks(template, picks);
          const one = tilePicks[0] ?? null;
          const reason =
            picks.length === 0
              ? COPY.pickFirst
              : template.makes === "ad" && adPicks.length === 0
                ? COPY.needsPhotoAndPrice
                : template.makes === "ad" && !ad && locked
                  ? locked
                  : null;
          return {
            template,
            picks: tilePicks,
            rotation: 0,
            real: realPicture(template, ad, one),
            reason,
            more:
              template.makes === "ad" && picks.length > template.maxPicks
                ? picks.length - template.maxPicks
                : 0,
          };
        });
        return (
          <GalleryGroup
            key={entry.group}
            group={entry.group}
            label={entry.label}
            open={open}
            workbench={open ? workbench : null}
            openTileId={open && openId ? galleryTileId(idPrefix, openId) : null}
          >
            {tiles.map(tile => (
              <GalleryTile
                key={tile.template.id}
                id={galleryTileId(idPrefix, tile.template.id)}
                template={tile.template}
                picks={tile.picks}
                rotation={tile.rotation}
                frames={frames}
                real={tile.real}
                stamp={stamps.get(tile.template.id) ?? null}
                reason={tile.reason}
                more={tile.more}
                fresh={newPicks && tile.template.makes === "ad"}
                open={tile.template.id === openId}
                carrying={carrying}
                onMake={onMake}
              />
            ))}
          </GalleryGroup>
        );
      })}
    </div>
  );
}

/** One destination's tiles, as a row that scrolls sideways when they don't fit. */
function GalleryGroup({
  group,
  label,
  open,
  workbench,
  openTileId,
  children,
}: {
  group: ProductTemplateGroup;
  label: string;
  open: boolean;
  workbench: ReactNode;
  openTileId: string | null;
  children: ReactNode;
}) {
  const Icon = GROUP_ICONS[group];
  const place = COPY.groupPlaces[group];
  const scroller = useRef<HTMLUListElement>(null);
  const [ends, setEnds] = useState({ start: true, end: true });
  const [seen, setSeen] = useState(false);

  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const start = element.scrollLeft <= 1;
    const end =
      element.scrollLeft + element.clientWidth >= element.scrollWidth - 1;
    setEnds(current =>
      current.start === start && current.end === end ? current : { start, end }
    );
  }, []);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    measure();
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => measure());
    resize?.observe(element);
    // The tiles' motion hints play once, when the row first comes into view.
    const view =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) {
              setSeen(true);
              view?.disconnect();
            }
          });
    view?.observe(element);
    return () => {
      resize?.disconnect();
      view?.disconnect();
    };
  }, [measure]);

  const scrollBy = (direction: 1 | -1) => {
    const element = scroller.current;
    if (!element) return;
    element.scrollBy({
      left: direction * Math.max(160, element.clientWidth * 0.8),
      behavior: "smooth",
    });
  };

  // The workbench's notch points at the open tile, wherever the row scrolled.
  const bench = useRef<HTMLDivElement>(null);
  const [notch, setNotch] = useState<number | null>(null);
  const placeNotch = useCallback(() => {
    if (!openTileId || !bench.current) return;
    const tile = document.getElementById(openTileId);
    if (!tile) return;
    const tileBox = tile.getBoundingClientRect();
    const benchBox = bench.current.getBoundingClientRect();
    const x = tileBox.left + tileBox.width / 2 - benchBox.left;
    setNotch(Math.max(20, Math.min(benchBox.width - 20, x)));
  }, [openTileId]);
  useLayoutEffect(() => {
    placeNotch();
  }, [placeNotch, open]);
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", placeNotch);
    return () => window.removeEventListener("resize", placeNotch);
  }, [open, placeNotch]);

  return (
    <>
      <section
        aria-label={COPY.groupLabel(label, place)}
        data-group={group}
        data-open={open || undefined}
        data-seen={seen || undefined}
        className={styles.group}
      >
        <h3 className={styles.groupHead}>
          <Icon aria-hidden="true" />
          <span>{label}</span>
          <span className={styles.groupPlace}>{place}</span>
        </h3>
        <div className={styles.groupBody}>
          <ul
            ref={scroller}
            onScroll={() => {
              measure();
              if (open) placeNotch();
            }}
            className={styles.tiles}
          >
            {children}
          </ul>
          {!ends.start ? (
            <button
              type="button"
              aria-label={COPY.earlier}
              onClick={() => scrollBy(-1)}
              className={cn(styles.arrow, styles.arrowStart)}
            >
              <ChevronLeft aria-hidden="true" />
            </button>
          ) : null}
          {!ends.end ? (
            <button
              type="button"
              aria-label={COPY.later}
              onClick={() => scrollBy(1)}
              className={cn(styles.arrow, styles.arrowEnd)}
            >
              <ChevronRight aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </section>
      {open && workbench ? (
        <div
          ref={bench}
          data-bench={group}
          className={styles.bench}
          style={
            notch === null
              ? undefined
              : ({ "--notch-x": `${notch}px` } as CSSProperties)
          }
        >
          {workbench}
        </div>
      ) : null}
    </>
  );
}

function GalleryTile({
  id,
  template,
  picks,
  rotation,
  frames,
  real,
  stamp,
  reason,
  more,
  fresh,
  open,
  carrying,
  onMake,
}: {
  id: string;
  template: ProductTemplate;
  picks: readonly WorkspaceProductRecord[];
  rotation: number;
  frames: ReadonlyMap<string, string>;
  real: string | null;
  stamp: ProductTemplateStamp | null;
  reason: string | null;
  more: number;
  fresh: boolean;
  open: boolean;
  carrying: boolean;
  onMake: (template: ProductTemplate) => void;
}) {
  const data: GalleryDropData = { templateId: template.id };
  const { setNodeRef, isOver } = useDroppable({
    id: `tile:${template.id}`,
    data,
    disabled: reason !== null,
  });
  return (
    <li className={styles.tileItem}>
      <button
        ref={setNodeRef}
        id={id}
        type="button"
        aria-disabled={reason !== null || undefined}
        aria-expanded={open}
        data-template={template.id}
        data-frame={template.frame}
        data-open={open || undefined}
        data-over={(isOver && reason === null) || undefined}
        data-takes={(carrying && reason === null) || undefined}
        onClick={() => {
          if (reason === null) onMake(template);
        }}
        className={styles.tile}
      >
        <span className={styles.tileArt}>
          <TileArt
            template={template}
            picks={picks}
            rotation={rotation}
            frames={frames}
            real={real}
          />
          {stamp ? (
            <span data-stamp={stamp} className={styles.stamp}>
              {COPY.stamps[stamp]}
            </span>
          ) : null}
          {more > 0 ? (
            <span className={styles.more}>{COPY.morePicks(more)}</span>
          ) : null}
          {fresh ? (
            <span className={styles.fresh}>
              <span className="sr-only">{COPY.newPicks}</span>
            </span>
          ) : null}
        </span>
        <span className={styles.tileName}>
          <span>
            {template.label}
            {template.museImage ? (
              <span className="sr-only">{`, ${COPY.museImage}`}</span>
            ) : null}
          </span>
          {template.museImage ? (
            <span aria-hidden="true" className={styles.spark}>
              ✦
            </span>
          ) : null}
        </span>
        {reason ? <span className={styles.tileReason}>{reason}</span> : null}
      </button>
    </li>
  );
}

/** The picks carried to a tile, as one stack with their count. */
export function CarriedStack({
  products,
}: {
  products: readonly WorkspaceProductRecord[];
}) {
  const shown = products.slice(0, 3).reverse();
  return (
    <div aria-hidden="true" className={styles.stack}>
      {shown.map((product, index) => (
        <span
          key={product.id}
          className={styles.stackCard}
          style={{ "--i": shown.length - 1 - index } as CSSProperties}
        >
          {product.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.imageUrl}
              alt=""
              draggable={false}
              className={styles.artCut}
            />
          ) : null}
        </span>
      ))}
      <span className={styles.stackCount}>{products.length}</span>
    </div>
  );
}

/** The first-visit hint under the gallery: how a tile is made. */
export function GalleryHint({ tapOnly = false }: { tapOnly?: boolean }) {
  return (
    <p className={styles.hint}>
      <Hand aria-hidden="true" />
      <span>{tapOnly ? COPY.hintTapOnly : COPY.hint}</span>
    </p>
  );
}

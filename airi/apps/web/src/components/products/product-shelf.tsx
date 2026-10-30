"use client";

import { PRODUCTS_COPY } from "@/lib/products/copy";
import { cn } from "@/lib/utils";
import {
  formatProductPrice,
  type WorkspaceProductRecord,
} from "@/lib/products/types";
import { CircleAlert, Sparkles } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import type { DraftShelfInfo } from "./product-stage-model";
import styles from "./product-shelf.module.css";

// Products stand on a real shelf, the way the owner filmed them, instead of
// sitting in cards: each bay is a lit wall, a plank with a price tag clipped
// to its lip, and the shadow it casts. Columns touch, so a row is one board;
// the wall runs on from row to row.
const SHELF_GRID =
  "grid grid-cols-2 overflow-hidden rounded-lg sm:grid-cols-3 lg:grid-cols-4";
// Every bay keeps this height, so the boards of a row line up.
const WALL = "relative h-40 sm:h-44";

// Each product is set down on the shelf once its photo has loaded. The first
// two rows go one after another; further down, a product scrolled into view
// shouldn't wait for its place in the queue.
const SET_DOWN_STEP_MS = 60;
const SET_DOWN_STAGGERED = 8;
const SET_DOWN =
  "fill-mode-both duration-500 ease-out fade-in slide-in-from-top-4 motion-safe:animate-in";
// A photo that was being made resolves out of its glow instead.
const DEVELOP =
  "fill-mode-both duration-700 ease-out fade-in zoom-in-95 blur-in-md motion-safe:animate-in";

/** The words over a shelf: what it holds, and a line about it. */
export function ShelfHeading({
  id,
  title,
  note = null,
}: {
  id: string;
  title: string;
  note?: string | null;
}) {
  return (
    <div className="mb-3 flex flex-col gap-0.5">
      <h2 id={id} className="text-[15px] leading-snug font-semibold">
        {title}
      </h2>
      {note ? (
        <p className="text-[13px] leading-snug text-muted-foreground">{note}</p>
      ) : null}
    </div>
  );
}

export function ProductShelf({
  products,
  label = PRODUCTS_COPY.title,
  labelledBy,
  drafts,
}: {
  products: WorkspaceProductRecord[];
  label?: string;
  /** The heading that names the shelf, when it has one. */
  labelledBy?: string;
  /**
   * Products found in a video but not on the shelf yet, with where each
   * one's photo is: their shelf gets a dashed edge.
   */
  drafts?: ReadonlyMap<string, DraftShelfInfo>;
}) {
  return (
    <ul
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      className={cn(styles.unit, SHELF_GRID)}
    >
      {products.map((product, index) => (
        <ShelfItem
          key={product.id}
          product={product}
          index={index}
          draft={drafts !== undefined}
          info={drafts?.get(product.id) ?? null}
        />
      ))}
      <ShelfFillers count={products.length} draft={drafts !== undefined} />
    </ul>
  );
}

function ShelfItem({
  product,
  index,
  draft,
  info,
}: {
  product: WorkspaceProductRecord;
  index: number;
  draft: boolean;
  info: DraftShelfInfo | null;
}) {
  const photo = info?.photo ?? (product.imageUrl ? "photo" : "initial");
  // A photo being made when the shelf appeared develops out of its glow.
  const [developing] = useState(
    () => photo === "making" || photo === "waiting"
  );
  const url = product.imageUrl;

  let content: ReactNode;
  if ((photo === "photo" || photo === "print") && url) {
    content = (
      // Keyed by URL: a refreshed signed link is tried again even after the
      // old one expired and failed.
      <ShelfPhoto
        key={url}
        url={url}
        name={product.name}
        index={index}
        arrival={developing ? "develop" : "set-down"}
        print={photo === "print"}
        placeholder={
          developing ? (
            <DevelopingPhoto state="making" prompt={info?.prompt ?? null} />
          ) : null
        }
      />
    );
  } else if (photo === "making" || photo === "waiting") {
    content = <DevelopingPhoto state={photo} prompt={info?.prompt ?? null} />;
  } else {
    content = <TentCard name={product.name} />;
  }

  return (
    <li
      data-photo={photo}
      data-published={draft ? undefined : ""}
      className={cn(
        styles.bay,
        draft && styles.draft,
        "relative flex min-w-0 flex-col"
      )}
      style={
        {
          "--i": index,
          "--aura-1": info?.aura[0],
          "--aura-2": info?.aura[1],
        } as CSSProperties
      }
    >
      {/* First, so the name is heard before the price; shown under the shelf.
          Spaced by margin: a clamp clips at the padding box, so bottom padding
          would show a third line. */}
      <p
        title={product.name}
        className="order-last mb-4 line-clamp-2 px-3 pt-1 text-center text-[13px] leading-snug break-words text-foreground/60"
      >
        {product.name}
      </p>
      <div className={cn(styles.wall, WALL)}>
        {/* The product sinks 5 px into the plank's top, so it stands on it. */}
        <div className="absolute inset-x-[18px] top-4 -bottom-[5px] z-[1] flex items-end justify-center">
          {content}
        </div>
      </div>
      <div aria-hidden="true" className={cn(styles.plank, "h-2.5")} />
      <div className={cn(styles.lip, "relative h-3")}>
        <PriceTag
          price={product.price}
          from={product.priceIsFrom}
          doubt={info?.priceDoubt ?? false}
        />
      </div>
      <div aria-hidden="true" className={cn(styles.under, "h-7")} />
      {/* Not made says so on its card; these say it to screen readers. */}
      {photo === "making" || photo === "waiting" ? (
        <span className="sr-only">{PRODUCTS_COPY.stage.photo[photo]}</span>
      ) : null}
    </li>
  );
}

function PriceTag({
  price,
  from,
  doubt,
}: {
  price: number | null;
  from: boolean;
  /** Airi isn't sure of it: a ring the owner checks. */
  doubt: boolean;
}) {
  return (
    <span
      className={cn(
        styles.tag,
        price === null && styles.tagEmpty,
        doubt && styles.tagDoubt,
        "absolute top-[3px] left-1/2 z-[2] inline-flex -translate-x-1/2 items-center gap-1 rounded-[3px] px-[7px] py-[5px] text-[13px] leading-[1.25] tracking-tight whitespace-nowrap tabular-nums",
        price === null ? "font-medium" : "font-semibold"
      )}
    >
      {doubt ? (
        <>
          <CircleAlert
            aria-hidden="true"
            className="size-3"
            strokeWidth={2.4}
          />
          <span className="sr-only">{PRODUCTS_COPY.stage.checkPrice}</span>
        </>
      ) : null}
      <span>
        {price === null
          ? PRODUCTS_COPY.noPrice
          : formatProductPrice(price, { from })}
      </span>
    </span>
  );
}

function ShelfPhoto({
  url,
  name,
  index,
  arrival,
  print,
  placeholder,
}: {
  url: string;
  name: string;
  index: number;
  arrival: "set-down" | "develop";
  /** A whole video frame, not a cut-out. */
  print: boolean;
  /** Shown until the photo has decoded, so its place is never blank. */
  placeholder: ReactNode;
}) {
  const [image, setImage] = useState<"loading" | "loaded" | "failed">(
    "loading"
  );
  if (image === "failed") return <TentCard name={name} />;

  return (
    <div className="relative flex h-full w-full items-end justify-center">
      {image === "loading" && placeholder ? (
        <div className="absolute inset-0 flex items-end justify-center">
          {placeholder}
        </div>
      ) : null}
      <div
        className={cn(
          "relative flex h-full max-w-full items-end justify-center",
          image === "loaded"
            ? arrival === "develop"
              ? DEVELOP
              : SET_DOWN
            : "opacity-0"
        )}
        style={{
          animationDelay: `${arrival === "set-down" && index < SET_DOWN_STAGGERED ? index * SET_DOWN_STEP_MS : 0}ms`,
        }}
      >
        <span
          aria-hidden="true"
          className="absolute inset-x-[10%] bottom-0 h-3 translate-y-1/2 rounded-[50%] bg-black/25 blur-md dark:bg-black/70"
        />
        {/* Signed storage URLs; next/image would need every bucket host configured. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          // Decoded first, so the shadow never lands before the product.
          onLoad={event => {
            void Promise.resolve(event.currentTarget.decode?.())
              .catch(() => undefined)
              .finally(() => setImage("loaded"));
          }}
          onError={() => setImage("failed")}
          className={cn(
            print ? styles.print : styles.cutout,
            "relative max-h-full max-w-full object-contain select-none",
            print && "mb-1 max-h-[78%]"
          )}
        />
      </div>
    </div>
  );
}

/** A name's first letter, for a product without a photo. */
export const initialOf = (name: string) =>
  Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "";

export function NameInitial({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="pb-2 text-7xl leading-none font-extralight text-foreground/20 select-none"
    >
      {initialOf(name)}
    </span>
  );
}

/**
 * A product without a photo: a paper tent card standing on the shelf, with
 * its first letter and what's missing. It stays merchandise, not a gap.
 */
function TentCard({ name }: { name: string }) {
  return (
    <span
      className={cn(
        styles.tent,
        "flex h-[84px] w-16 flex-col items-center justify-center gap-1.5 rounded-[10px] px-1 text-center sm:h-[100px] sm:w-[76px]"
      )}
    >
      <span
        aria-hidden="true"
        className="text-[28px] leading-none font-medium text-foreground/45 select-none"
      >
        {initialOf(name)}
      </span>
      <span className="text-[11px] leading-tight text-muted-foreground">
        {PRODUCTS_COPY.stage.photo.unmade}
      </span>
    </span>
  );
}

/**
 * Where a photo is being made, or waits its turn: a glow in the item's own
 * colours, with the words the models were given for it.
 */
function DevelopingPhoto({
  state,
  prompt,
}: {
  state: "making" | "waiting";
  prompt: string | null;
}) {
  return (
    <>
      <div
        aria-hidden="true"
        data-state={state}
        className={cn(
          styles.aura,
          "relative aspect-[.74] h-[78%] max-w-full overflow-hidden"
        )}
      >
        {state === "making" ? (
          <>
            <span className={cn(styles.develop, "absolute inset-0")} />
            <span className={cn(styles.scrim, "absolute inset-0")} />
            <Sparkles
              className={cn(styles.twinkle, "absolute top-3 left-3 size-4")}
              strokeWidth={1.8}
            />
          </>
        ) : null}
        {prompt ? (
          <span
            className={cn(
              styles.prompt,
              "absolute inset-x-2.5 bottom-3.5 line-clamp-3 text-center font-mono text-[11px] leading-tight"
            )}
          >
            {prompt}
          </span>
        ) : null}
      </div>
      <span
        aria-hidden="true"
        className={cn(
          styles.auraShadow,
          "absolute inset-x-[18%] bottom-0 h-2.5 translate-y-1/2 rounded-[50%] blur-md"
        )}
      />
    </>
  );
}

/** The plank, its lip and its shadow: the shelf under every bay. */
function Board({ children = null }: { children?: ReactNode }) {
  return (
    <>
      <div aria-hidden="true" className={cn(styles.plank, "h-2.5")} />
      <div aria-hidden="true" className={cn(styles.lip, "relative h-3")}>
        {children}
      </div>
      <div aria-hidden="true" className={cn(styles.under, "h-7")} />
    </>
  );
}

/**
 * Empty bays that finish the last row as a whole shelf at 2, 3 and 4
 * columns, worked out from the count alone, so the server's markup matches.
 */
function ShelfFillers({ count, draft }: { count: number; draft: boolean }) {
  const need = (columns: number) => (columns - (count % columns)) % columns;
  return Array.from(
    { length: Math.max(need(2), need(3), need(4)) },
    (_, index) => (
      <li
        key={index}
        aria-hidden="true"
        data-spot="filler"
        className={cn(
          styles.bay,
          draft && styles.draft,
          index < need(2) ? "block" : "hidden",
          index < need(3) ? "sm:block" : "sm:hidden",
          index < need(4) ? "lg:block" : "lg:hidden"
        )}
      >
        <div className={cn(styles.wall, WALL)} />
        <Board />
      </li>
    )
  );
}

// One shelf row at every width: the third bay shows from three columns up,
// the fourth from four.
const SKELETON_BAYS = ["flex", "flex", "hidden sm:flex", "hidden lg:flex"];

/** The shelf while products load: dimmed bays with blank tags. */
export function ProductShelfSkeleton() {
  return (
    <div aria-hidden="true" className={cn(styles.unit, SHELF_GRID)}>
      {SKELETON_BAYS.map((visibility, index) => (
        <div
          key={index}
          data-light="dim"
          className={cn(styles.bay, visibility, "flex-col")}
        >
          <div className={cn(styles.wall, WALL)} />
          <Board>
            <span
              className={cn(
                styles.tag,
                "absolute top-[3px] left-1/2 h-[26px] w-14 -translate-x-1/2 rounded-[3px] opacity-60 motion-safe:animate-pulse"
              )}
            />
          </Board>
          <div className="mx-auto mt-1 mb-4 h-3 w-20 rounded bg-foreground/[0.06] motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
  );
}

/** A message standing on an empty shelf, where products will be. */
export function EmptyShelf({
  children,
  lit = true,
}: {
  children: ReactNode;
  /** Off when the shelf couldn't load. */
  lit?: boolean;
}) {
  return (
    <div className={cn(styles.unit, "overflow-hidden rounded-lg")}>
      <div
        data-light={lit ? "half" : "off"}
        className={cn(styles.bay, "flex flex-col")}
      >
        <div
          className={cn(
            styles.wall,
            "relative flex min-h-56 flex-col items-center justify-end gap-1.5 px-4 pt-8 pb-6 text-center"
          )}
        >
          {children}
        </div>
        <Board />
        <div className="h-4" />
      </div>
    </div>
  );
}

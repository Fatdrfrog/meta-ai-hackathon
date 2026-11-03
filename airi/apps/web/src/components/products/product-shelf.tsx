"use client";

import { PRODUCTS_COPY } from "@/lib/products/copy";
import { cn } from "@/lib/utils";
import {
  formatProductPrice,
  productPriceLength,
  productPriceParts,
  type WorkspaceProductRecord,
} from "@/lib/products/types";
import { CircleAlert } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import { ProductCheck } from "./product-controls";
import type { DraftShelfInfo } from "./product-stage-model";
import styles from "./product-shelf.module.css";
import theme from "./product-theme.module.css";

const COPY = PRODUCTS_COPY.page;

// Products stand on a real shelf, the way the owner filmed them, instead of
// sitting in cards: each bay is a lit plaster wall, a birch plank with a
// paper price label clipped to its edge, and the shade the plank throws.
// Bays touch, so a row is one board; the wall runs on from row to row.

// Each product is set down once its photo has decoded; the first 8 one
// after another, the rest as they scroll into view.
const SET_DOWN_STEP_MS = 40;
const SET_DOWN_STAGGERED = 8;

/** The words over a shelf: what it holds, how many, a line about it, and a control. */
export function ShelfHeading({
  id,
  title,
  note = null,
  count,
  action = null,
}: {
  /** On the title alone, so a shelf it names is named by the title. */
  id: string;
  title: string;
  note?: string | null;
  /** How many it holds, beside the title. */
  count?: number;
  /** A control at the heading's end, such as "Choose products". */
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4 max-sm:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 className={theme.displayM}>
          <span id={id}>{title}</span>
          {count !== undefined ? (
            <>
              {" "}
              <span className="ml-0.5 font-sans text-[15px] font-medium tracking-normal text-(--p-ink-2) tabular-nums">
                {count}
              </span>
            </>
          ) : null}
        </h2>
        {note ? (
          <p className="text-[13px] leading-[18px] text-(--p-ink-2)">{note}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/** Choose mode: every bay is a checkbox for making something with it. */
export type ShelfChoosing = {
  chosen: ReadonlySet<string>;
  onToggle: (productId: string) => void;
};

export function ProductShelf({
  products,
  label = PRODUCTS_COPY.title,
  labelledBy,
  drafts,
  choose = null,
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
  /** Set while the owner chooses products on the shelf. */
  choose?: ShelfChoosing | null;
}) {
  return (
    <ul
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      className={styles.unit}
    >
      {products.map((product, index) => (
        <ShelfItem
          key={product.id}
          product={product}
          index={index}
          draft={drafts !== undefined}
          info={drafts?.get(product.id) ?? null}
          choose={choose}
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
  choose,
}: {
  product: WorkspaceProductRecord;
  index: number;
  draft: boolean;
  info: DraftShelfInfo | null;
  choose: ShelfChoosing | null;
}) {
  const photo = info?.photo ?? (product.imageUrl ? "photo" : "initial");
  // A photo being made when the shelf appeared keeps its tent card standing
  // until the photo has decoded, so its place is never blank.
  const [wasMaking] = useState(() => photo === "making" || photo === "waiting");
  const url = product.imageUrl;
  const chosen = choose?.chosen.has(product.id) ?? false;

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
        print={photo === "print"}
        placeholder={
          wasMaking ? (
            <TentCard name={product.name} words={COPY.makingPhoto} />
          ) : null
        }
      />
    );
  } else if (photo === "making") {
    content = <TentCard name={product.name} words={COPY.makingPhoto} />;
  } else if (photo === "waiting") {
    content = <TentCard name={product.name} words={COPY.nextInLine} />;
  } else {
    content = <TentCard name={product.name} words={COPY.noPhoto} />;
  }

  return (
    <li
      data-photo={photo}
      data-published={draft ? undefined : ""}
      data-chosen={chosen || undefined}
      className={cn(styles.bay, draft && styles.draft, "flex flex-col")}
    >
      {/* First, so the name is heard before the price; shown under the shelf. */}
      <p title={product.name} dir="auto" className={styles.name}>
        {product.name}
      </p>
      <div className={styles.wall}>
        <div className={styles.stand}>{content}</div>
      </div>
      <div aria-hidden="true" className={styles.top} />
      <div className={styles.lip}>
        <PriceTag
          price={product.price}
          currency={product.currency}
          from={product.priceIsFrom}
          doubt={info?.priceDoubt ?? false}
        />
      </div>
      <div aria-hidden="true" className={styles.under} />
      {choose ? (
        <>
          <input
            type="checkbox"
            aria-label={product.name}
            checked={chosen}
            onChange={() => choose.onToggle(product.id)}
            className={styles.pick}
          />
          <ProductCheck checked={chosen} className={styles.check} />
        </>
      ) : null}
    </li>
  );
}

/**
 * A price as formatProductPrice writes it, which a line may break after its
 * "from" but never inside its amount or before its code.
 */
export function PriceText({
  price,
  currency,
  from,
}: {
  price: number;
  currency: string | null;
  from: boolean;
}) {
  const [lead, amount] = productPriceParts(price, { from, currency });
  return (
    <>
      {lead}
      {lead ? <wbr /> : null}
      {amount}
    </>
  );
}

// A long price is lettered smaller, so its label fits a phone's bay.
const TAG_SIZE = {
  short: "text-[13px]",
  long: "text-[11px]",
  longest: "text-[10px]",
} as const;

function PriceTag({
  price,
  currency,
  from,
  doubt,
}: {
  price: number | null;
  currency: string | null;
  from: boolean;
  /** Airi isn't sure of it: a ring the owner checks. */
  doubt: boolean;
}) {
  if (price === null)
    return (
      <span className={cn(styles.tag, styles.tagEmpty)}>
        {PRODUCTS_COPY.noPrice}
      </span>
    );
  const [lead, amount] = productPriceParts(price, { from, currency });
  return (
    <span
      className={cn(
        styles.tag,
        doubt && styles.tagDoubt,
        TAG_SIZE[
          productPriceLength(formatProductPrice(price, { from, currency }))
        ]
      )}
    >
      {doubt ? (
        <>
          <CircleAlert aria-hidden="true" strokeWidth={2.4} />
          <span className="sr-only">{COPY.checkPrice}</span>
        </>
      ) : null}
      {lead ? (
        <>
          {/* "from" is lettered lighter than the amount, and may sit on a
              line of its own; it's read as one price. */}
          <span aria-hidden="true" className="min-w-0 text-center">
            <span className={styles.from}>{lead}</span>
            <wbr />
            {amount}
          </span>
          <span className="sr-only">{`${lead}${amount}`}</span>
        </>
      ) : (
        <span className="min-w-0 text-center">{amount}</span>
      )}
    </span>
  );
}

function ShelfPhoto({
  url,
  name,
  index,
  print,
  placeholder,
}: {
  url: string;
  name: string;
  index: number;
  /** A whole video frame, not a cut-out. */
  print: boolean;
  /** Shown until the photo has decoded, so its place is never blank. */
  placeholder: ReactNode;
}) {
  const [image, setImage] = useState<"loading" | "loaded" | "failed">(
    "loading"
  );
  if (image === "failed") return <TentCard name={name} words={COPY.noPhoto} />;

  return (
    <>
      {image === "loading" && placeholder ? (
        <div className="absolute inset-0 flex items-end justify-center">
          {placeholder}
        </div>
      ) : null}
      <div
        data-state={image}
        data-print={print || undefined}
        className={styles.product}
        style={
          {
            "--delay": `${index < SET_DOWN_STAGGERED ? index * SET_DOWN_STEP_MS : 0}ms`,
          } as CSSProperties
        }
      >
        {/* Signed storage URLs; next/image would need every bucket host configured. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          // Decoded first, so the shadows never land before the product.
          onLoad={event => {
            void Promise.resolve(event.currentTarget.decode?.())
              .catch(() => undefined)
              .finally(() => setImage("loaded"));
          }}
          onError={() => setImage("failed")}
          className={print ? styles.print : styles.cutout}
        />
      </div>
    </>
  );
}

/** A name's first letter, for a product without a photo. */
export const initialOf = (name: string) =>
  Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "";

/** A name's first letter, large and quiet, where a photo would stand. */
export function NameInitial({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="pb-2 font-(family-name:--p-font-display) text-7xl leading-none font-medium text-(--p-ink-3) select-none"
    >
      {initialOf(name)}
    </span>
  );
}

/**
 * A product without its photo: a paper tent card standing on the shelf, with
 * its first letter and what's happening to the photo. It stays merchandise,
 * not a gap.
 */
function TentCard({ name, words }: { name: string; words: string }) {
  return (
    <span className={styles.tent}>
      <b aria-hidden="true">{initialOf(name)}</b>
      <span>{words}</span>
    </span>
  );
}

/** The plank, its edge and its shade: the shelf under every bay. */
function Board({ children = null }: { children?: ReactNode }) {
  return (
    <>
      <div aria-hidden="true" className={styles.top} />
      <div aria-hidden="true" className={styles.lip}>
        {children}
      </div>
      <div aria-hidden="true" className={styles.under} />
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
        <div className={styles.wall} />
        <Board />
      </li>
    )
  );
}

// One shelf row at every width: the third bay shows from three columns up,
// the fourth from four.
const SKELETON_BAYS = ["flex", "flex", "hidden sm:flex", "hidden lg:flex"];

/** The shelf while products load: a still, dim row with blank labels. */
export function ProductShelfSkeleton() {
  return (
    <div
      role="status"
      aria-label={PRODUCTS_COPY.loading}
      className={styles.unit}
    >
      {SKELETON_BAYS.map((visibility, index) => (
        <div
          key={index}
          aria-hidden="true"
          data-light="dim"
          className={cn(styles.bay, visibility, "flex-col")}
        >
          <div className={styles.wall} />
          <Board>
            <span className={cn(styles.tag, styles.tagBlank)} />
          </Board>
          <span className={styles.nameBar} />
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
    <div className={styles.empty} data-light={lit ? undefined : "off"}>
      <div className={styles.emptyWall}>{children}</div>
      <Board>
        <div className={styles.ghostTags}>
          <span />
          <span />
          <span />
          <span />
        </div>
      </Board>
    </div>
  );
}

"use client";

import { PRODUCTS_COPY } from "@/lib/products/copy";
import { cn } from "@/lib/utils";
import {
  formatProductPrice,
  productPriceLength,
  productPriceParts,
  type WorkspaceProductRecord,
} from "@/lib/products/types";
import { useDraggable } from "@dnd-kit/core";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CircleAlert, Ellipsis, Plus } from "lucide-react";
import { useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { ProductCheck } from "./product-controls";
import type { DraftShelfInfo } from "./product-stage-model";
import styles from "./product-shelf.module.css";
import theme from "./product-theme.module.css";

const COPY = PRODUCTS_COPY.page;
const ROWS = PRODUCTS_COPY.rows;

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

// What stands on the empty shelf, one to a bay: a bottle, a box, a jar and a
// carton, drawn as dashed outlines. Two show on a phone, three from 640px and
// four from 1024px, as many as the shelf's bays.
const GHOSTS = ["bottle", "box", "jar", "carton"] as const;

/**
 * An empty wall shelf: the message on the wall, ghost products standing on
 * the plank where products will be, each with a blank label on its edge, and
 * the brackets that hold it.
 */
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
      <div className={styles.emptyWall}>
        <div className={styles.emptyMessage}>{children}</div>
        <div aria-hidden="true" className={styles.ghostRow}>
          {GHOSTS.map(shape => (
            <span key={shape} className={styles.ghostBay}>
              <span data-shape={shape} className={styles.ghost} />
            </span>
          ))}
        </div>
      </div>
      <div aria-hidden="true" className={styles.top} />
      <div aria-hidden="true" className={styles.lip}>
        <div className={styles.ghostTags}>
          {GHOSTS.map(shape => (
            <span key={shape} className={styles.ghostBay}>
              <span className={styles.ghostTag} />
            </span>
          ))}
        </div>
      </div>
      <div aria-hidden="true" className={styles.emptyBelow} />
    </div>
  );
}

// ------------------------------------------------------------ studio v3 rows

/** A product on a row: on the shelf, or still a draft of the row's video. */
export type ShelfRowBay = {
  product: WorkspaceProductRecord;
  /** Found in the row's video and not on the shelf yet. */
  draft: boolean;
  /** A draft's photo state and price doubt; null for a shelf product. */
  info: DraftShelfInfo | null;
};

/** One row of the shelf: a video's products, headed by its print. */
export type ShelfRowModel = {
  key: string;
  /** The video the products came from; null for the last, plain row. */
  importId: string | null;
  /** When the video was sent, for the row's name; null when unknown. */
  when: string | null;
  /** The video's print: a frame of it, or the file sent from this page. */
  print: { frame: string | null; video: string | null } | null;
  bays: ShelfRowBay[];
  /** Whether products here are still drafts: "Check one by one" is offered. */
  draftsLeft: boolean;
};

/**
 * Studio v3's shelf: one row per video, newest first, each headed by the
 * video's print, with products from no video on a last plain row. A tap on
 * a product picks it, with its number in pick order; another lets it go.
 * Each product can also be carried (dnd-kit's draggable) onto a tile.
 */
export function ShelfRows({
  rows,
  numbers,
  labelledBy,
  addBay = null,
  onToggle,
  onCheckOneByOne,
  onFixPrice,
}: {
  rows: readonly ShelfRowModel[];
  /** Each picked product's number, from 1, in pick order. */
  numbers: ReadonlyMap<string, number>;
  /** The heading that names the shelf. */
  labelledBy?: string;
  /** The "+" bay at the end of the newest row. */
  addBay?: ReactNode;
  onToggle: (productId: string) => void;
  /** The print's ⋯ "Check one by one": the swipe review of that video. */
  onCheckOneByOne?: (importId: string) => void;
  /** A draft's red tag: where its price is put right. */
  onFixPrice?: (bay: ShelfRowBay, importId: string | null) => void;
}) {
  // Where each row's products start in the shelf's order, so the first 8
  // are set down one after another.
  const starts = rows.map((_, index) =>
    rows.slice(0, index).reduce((sum, row) => sum + row.bays.length, 0)
  );
  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : ROWS.label}
      className={styles.rows}
    >
      {rows.map((row, index) => {
        return (
          <ShelfRowView
            key={row.key}
            row={row}
            numbers={numbers}
            firstIndex={starts[index] ?? 0}
            add={index === 0 ? addBay : null}
            onToggle={onToggle}
            onCheckOneByOne={onCheckOneByOne}
            onFixPrice={onFixPrice}
          />
        );
      })}
      {rows.length === 0 && addBay ? (
        <div className={styles.row}>
          <div className={styles.rowTrack}>
            {addBay}
            <RowRest />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ShelfRowView({
  row,
  numbers,
  firstIndex,
  add,
  onToggle,
  onCheckOneByOne,
  onFixPrice,
}: {
  row: ShelfRowModel;
  numbers: ReadonlyMap<string, number>;
  firstIndex: number;
  add: ReactNode;
  onToggle: (productId: string) => void;
  onCheckOneByOne?: (importId: string) => void;
  onFixPrice?: (bay: ShelfRowBay, importId: string | null) => void;
}) {
  return (
    <section
      aria-label={row.importId ? ROWS.video(row.when) : ROWS.plainLabel}
      data-row={row.importId ?? "shelf"}
      className={styles.row}
    >
      <div className={styles.rowTrack}>
        {row.importId ? (
          <VideoPrint
            importId={row.importId}
            print={row.print}
            draftsLeft={row.draftsLeft}
            onCheckOneByOne={onCheckOneByOne}
          />
        ) : (
          <div className={styles.slot} data-slot="plain">
            <div className={styles.cWall}>
              <span aria-hidden="true" className={styles.plainLabel}>
                {ROWS.plain}
              </span>
            </div>
            <RowBoard />
          </div>
        )}
        <ul className={styles.rowBays}>
          {row.bays.map((bay, index) => (
            <RowBay
              key={bay.product.id}
              bay={bay}
              index={firstIndex + index}
              number={numbers.get(bay.product.id) ?? null}
              onToggle={onToggle}
              onFixPrice={
                onFixPrice ? () => onFixPrice(bay, row.importId) : undefined
              }
            />
          ))}
        </ul>
        {add}
        <RowRest />
      </div>
    </section>
  );
}

/** The plank under a slot of a row: its top and its ply edge. */
function RowBoard({ children = null }: { children?: ReactNode }) {
  return (
    <>
      <span aria-hidden="true" className={styles.cTop} />
      <span aria-hidden={children ? undefined : true} className={styles.cLip}>
        {children}
      </span>
    </>
  );
}

/** The plank running on to the row's end. */
function RowRest() {
  return (
    <div aria-hidden="true" className={cn(styles.slot, styles.rest)}>
      <div className={styles.cWall} />
      <RowBoard />
    </div>
  );
}

/** m:ss, for a print's length. */
function formatPrintTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** A video's print at the head of its row: 9:16, with its length when known. */
function VideoPrint({
  importId,
  print,
  draftsLeft,
  onCheckOneByOne,
}: {
  importId: string;
  print: ShelfRowModel["print"];
  draftsLeft: boolean;
  onCheckOneByOne?: (importId: string) => void;
}) {
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const [length, setLength] = useState<number | null>(null);
  const breaks = (url: string) => () =>
    setBroken(current => new Set(current).add(url));
  const video = print?.video && !broken.has(print.video) ? print.video : null;
  const frame =
    !video && print?.frame && !broken.has(print.frame) ? print.frame : null;
  return (
    <div className={styles.slot} data-slot="print">
      <div className={styles.cWall}>
        <figure className={styles.print}>
          {video ? (
            // Paused on its first frame: nothing on the shelf plays by itself.
            <video
              key={video}
              src={`${video}#t=0.1`}
              muted
              playsInline
              preload="metadata"
              tabIndex={-1}
              aria-hidden="true"
              onLoadedMetadata={event => {
                const { duration } = event.currentTarget;
                if (Number.isFinite(duration)) setLength(duration);
              }}
              onError={breaks(video)}
            />
          ) : frame ? (
            // Signed storage URLs; next/image would need every bucket host configured.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={frame}
              src={frame}
              alt=""
              decoding="async"
              draggable={false}
              onError={breaks(frame)}
            />
          ) : null}
          <span aria-hidden="true" className={styles.printPlay} />
          <figcaption className="sr-only">
            {length !== null
              ? `${ROWS.print}, ${ROWS.printLength(formatPrintTime(length))}`
              : ROWS.print}
          </figcaption>
          {length !== null ? (
            <span aria-hidden="true" className={styles.printTime}>
              {formatPrintTime(length)}
            </span>
          ) : null}
        </figure>
        {draftsLeft && onCheckOneByOne ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={ROWS.more}
                className={styles.printMore}
              >
                <Ellipsis aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className={cn(theme.theme, theme.popover)}
            >
              <DropdownMenuItem onSelect={() => onCheckOneByOne(importId)}>
                {ROWS.checkOneByOne}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <RowBoard />
    </div>
  );
}

function RowBay({
  bay,
  index,
  number,
  onToggle,
  onFixPrice,
}: {
  bay: ShelfRowBay;
  index: number;
  number: number | null;
  onToggle: (productId: string) => void;
  onFixPrice?: () => void;
}) {
  const { product, draft, info } = bay;
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: product.id,
    data: { productId: product.id },
  });
  const doubt = info?.priceDoubt ?? false;
  const price =
    product.price === null
      ? PRODUCTS_COPY.noPrice
      : formatProductPrice(product.price, {
          from: product.priceIsFrom,
          currency: product.currency,
        });
  const label = [
    ROWS.bay(product.name, price, number),
    doubt ? COPY.checkPrice : null,
    draft ? ROWS.draft : null,
  ]
    .filter(Boolean)
    .join(", ");

  const photo = info?.photo ?? (product.imageUrl ? "photo" : "initial");
  const url = product.imageUrl;
  let content: ReactNode;
  if ((photo === "photo" || photo === "print") && url) {
    content = (
      <ShelfPhoto
        key={url}
        url={url}
        name={product.name}
        index={index}
        print={photo === "print" || product.hasCutout === false}
        placeholder={null}
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
      data-picked={number !== null || undefined}
      data-draft={draft || undefined}
      data-dragging={isDragging || undefined}
      data-price-length={productPriceLength(price)}
      className={cn(styles.slot, styles.rowBay, draft && styles.draft)}
    >
      <button
        ref={setNodeRef}
        type="button"
        aria-pressed={number !== null}
        aria-label={label}
        data-product={product.id}
        {...listeners}
        onClick={() => onToggle(product.id)}
        className={styles.bayButton}
      >
        <span className={styles.cWall}>
          <span className={styles.cStand}>{content}</span>
        </span>
        <RowBoard>
          <PriceTag
            price={product.price}
            currency={product.currency}
            from={product.priceIsFrom}
            doubt={doubt}
          />
        </RowBoard>
        <span dir="auto" title={product.name} className={styles.cName}>
          {product.name}
        </span>
        {number !== null ? (
          <span aria-hidden="true" className={styles.pickNo}>
            {number}
          </span>
        ) : null}
      </button>
      {doubt && onFixPrice ? (
        <button
          type="button"
          aria-label={ROWS.fixPrice(product.name)}
          title={COPY.checkPrice}
          onClick={onFixPrice}
          className={styles.tagFix}
        />
      ) : null}
    </li>
  );
}

/** The "+" bay that ends the newest row: another video, from here or WhatsApp. */
export function AddVideoBay({
  onChoose,
  buttonRef,
  disabled = false,
  extra = null,
}: {
  onChoose: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
  disabled?: boolean;
  /** Under the "+": the WhatsApp intake link, when it's set up. */
  extra?: ReactNode;
}) {
  return (
    <div className={cn(styles.slot, styles.addSlot)} data-slot="add">
      <div className={styles.cWall}>
        <div className={styles.addBox}>
          <button
            ref={buttonRef}
            type="button"
            disabled={disabled}
            onClick={onChoose}
            className={styles.addButton}
          >
            <Plus aria-hidden="true" />
            <span>{PRODUCTS_COPY.uploadVideo}</span>
          </button>
          {extra}
        </div>
      </div>
      <RowBoard />
    </div>
  );
}

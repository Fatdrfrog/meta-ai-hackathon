"use client";

import { PRODUCTS_COPY } from "@/lib/products/copy";
import { cn } from "@/lib/utils";
import {
  formatProductPrice,
  type WorkspaceProductRecord,
} from "@/lib/products/types";
import { useState, type ReactNode } from "react";

// Products stand on shelf rails, the way the owner filmed them, instead of
// sitting in cards. Columns touch, so the rails of one row join into a shelf.
const SHELF_GRID = "grid grid-cols-2 gap-y-12 sm:grid-cols-3 lg:grid-cols-4";
const STAGE = "flex h-36 items-end justify-center px-5 sm:h-44";

// Each product is set down on the shelf once its photo has loaded. The first
// two rows go one after another; further down, a product scrolled into view
// shouldn't wait for its place in the queue.
const SET_DOWN_STEP_MS = 60;
const SET_DOWN_STAGGERED = 8;

export function ProductShelf({
  products,
  label = PRODUCTS_COPY.title,
  draft = false,
  pendingIds,
}: {
  products: WorkspaceProductRecord[];
  label?: string;
  /** Products found in a video but not on the shelf yet: a dashed rail. */
  draft?: boolean;
  /** Products whose photo is still being made. */
  pendingIds?: ReadonlySet<string>;
}) {
  return (
    <ul className={SHELF_GRID} aria-label={label}>
      {products.map((product, index) => (
        <ShelfItem
          key={product.id}
          product={product}
          index={index}
          draft={draft}
          pending={pendingIds?.has(product.id) ?? false}
        />
      ))}
    </ul>
  );
}

function ShelfItem({
  product,
  index,
  draft,
  pending,
}: {
  product: WorkspaceProductRecord;
  index: number;
  draft: boolean;
  pending: boolean;
}) {
  return (
    <li className="flex min-w-0 flex-col">
      <div className={STAGE}>
        {pending ? (
          <PendingPhoto />
        ) : product.imageUrl ? (
          // Keyed by URL: a refreshed signed link is tried again even after
          // the old one expired and failed.
          <ShelfPhoto
            key={product.imageUrl}
            url={product.imageUrl}
            name={product.name}
            index={index}
          />
        ) : (
          <NameInitial name={product.name} />
        )}
      </div>
      <ShelfRail dashed={draft} />
      <div className="flex flex-col px-3 pt-3 text-center">
        <p
          className="order-last mt-0.5 line-clamp-2 text-[13px] leading-snug break-words text-muted-foreground"
          title={product.name}
        >
          {product.name}
        </p>
        {product.price === null ? (
          <p className="text-sm text-muted-foreground">
            {PRODUCTS_COPY.noPrice}
          </p>
        ) : (
          <p className="text-[15px] font-semibold tracking-tight tabular-nums">
            {formatProductPrice(product.price, { from: product.priceIsFrom })}
          </p>
        )}
      </div>
    </li>
  );
}

function ShelfPhoto({
  url,
  name,
  index,
}: {
  url: string;
  name: string;
  index: number;
}) {
  const [image, setImage] = useState<"loading" | "loaded" | "failed">(
    "loading"
  );
  if (image === "failed") return <NameInitial name={name} />;

  return (
    <div
      className={cn(
        "relative flex h-full max-w-full items-end justify-center",
        image === "loaded"
          ? "fill-mode-both duration-500 ease-out fade-in slide-in-from-top-4 motion-safe:animate-in"
          : "opacity-0"
      )}
      style={{
        animationDelay: `${index < SET_DOWN_STAGGERED ? index * SET_DOWN_STEP_MS : 0}ms`,
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
        className="relative max-h-full max-w-full object-contain select-none"
      />
    </div>
  );
}

function NameInitial({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="pb-2 text-7xl leading-none font-extralight text-foreground/20 select-none"
    >
      {Array.from(name.trim())[0]?.toLocaleUpperCase() ?? ""}
    </span>
  );
}

/** Where a product's photo lands once it's made. */
function PendingPhoto() {
  return (
    <div
      aria-hidden="true"
      className="h-24 w-2/5 animate-pulse rounded-xl bg-foreground/[0.06]"
    />
  );
}

function ShelfRail({ dashed = false }: { dashed?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "h-3 border-t border-foreground/20 bg-linear-to-b from-foreground/[0.07] to-transparent",
        dashed && "border-dashed"
      )}
    />
  );
}

// One shelf row at every width: the third shape shows from three columns up,
// the fourth from four.
const SKELETON_SHAPES = [
  { height: "h-24", visibility: "" },
  { height: "h-32", visibility: "" },
  { height: "h-20", visibility: "hidden sm:block" },
  { height: "h-28", visibility: "hidden lg:block" },
];

/** The shelf while products load: rails with soft shapes where products go. */
export function ProductShelfSkeleton() {
  return (
    <div className={SHELF_GRID} aria-hidden="true">
      {SKELETON_SHAPES.map(({ height, visibility }) => (
        <div key={height} className={visibility}>
          <div className={STAGE}>
            <div
              className={`w-2/5 animate-pulse rounded-xl bg-foreground/[0.06] ${height}`}
            />
          </div>
          <ShelfRail />
          <div className="mx-auto mt-3 h-3.5 w-14 animate-pulse rounded bg-foreground/[0.06]" />
          <div className="mx-auto mt-2 h-3 w-24 animate-pulse rounded bg-foreground/[0.06]" />
        </div>
      ))}
    </div>
  );
}

/** A message standing on an empty shelf, where products will be. */
export function EmptyShelf({ children }: { children: ReactNode }) {
  return (
    <div>
      <div className="flex min-h-36 flex-col items-center justify-end gap-1.5 px-4 pb-6 text-center sm:min-h-44">
        {children}
      </div>
      <ShelfRail />
    </div>
  );
}

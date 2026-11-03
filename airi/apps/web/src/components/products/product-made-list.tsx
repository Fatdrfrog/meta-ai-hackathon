"use client";

// "Made from your shelf": every kit and video ad the owner made, newest
// first, with Meta's status and each one's next step. It sits above the
// shelf, and shows nothing until something has been made.

import { Button } from "@/components/ui/button";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import type {
  ProductAdRecord,
  ProductKitPart,
  ProductKitRecord,
  ProductsListResponse,
  ProductsMadeResponse,
  WorkspaceProductRecord,
} from "@/lib/products/types";
import { Clapperboard, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { retryProductKitPart } from "./kits-client";
import { ProductChip } from "./product-controls";
import {
  kitPartViews,
  kitRequestErrorLine,
  kitTitle,
  retryBusy,
} from "./product-kit-status";
import styles from "./product-made-list.module.css";
import theme from "./product-theme.module.css";
import {
  fetchProducts,
  ProductDraftError,
  productsApiUrl,
} from "./products-client";
import {
  formatElapsed,
  madeWhen,
  useNow,
  useProductsMade,
} from "./use-product-kits";
import { AD_MAX_PRODUCTS, canGoInAd } from "./use-product-selection";

const COPY = PRODUCTS_COPY.made;
/** Rows shown before "Show all". */
const FIRST_ROWS = 3;

/** What the page gives the list. */
export type MadeListProps = {
  workspaceId: string;
  /** An ad row's Open: the ad's studio (?ad=<adId>). */
  onOpenAd: (adId: string) => void;
  /** A kit row's "Make a video ad with these": the ad's brief with its products. */
  onMakeAd: (productIds: string[]) => void;
};

type MadeRow =
  | { kind: "kit"; at: number; kit: ProductKitRecord }
  | { kind: "ad"; at: number; ad: ProductAdRecord };

/** Kits and ads together, newest first. */
export function madeRows(made: ProductsMadeResponse): MadeRow[] {
  return [
    ...made.kits.map(kit => ({
      kind: "kit" as const,
      at: Date.parse(kit.createdAt),
      kit,
    })),
    ...made.ads.map(ad => ({
      kind: "ad" as const,
      at: Date.parse(ad.createdAt),
      ad,
    })),
  ].sort((a, b) => b.at - a.at);
}

/** The list. It shows nothing while nothing has been made. */
export function MadeList({ workspaceId, onOpenAd, onMakeAd }: MadeListProps) {
  const titleId = useId();
  const made = useProductsMade(workspaceId);
  // The shelf the page already lists, for each kit's pictures and prices.
  const shelf = useSWR<ProductsListResponse>(
    made.data?.kits.length ? productsApiUrl(workspaceId) : null,
    fetchProducts,
    { revalidateOnFocus: false }
  );
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(
    () => (made.data ? madeRows(made.data) : []),
    [made.data]
  );
  const now = useNow(
    made.data?.ads.some(ad => ad.status === "making") ?? false
  );
  const products = useMemo(
    () =>
      new Map(
        (shelf.data?.products ?? []).map(product => [product.id, product])
      ),
    [shelf.data]
  );

  if (!made.data) {
    if (!made.error) return null;
    return (
      <div role="alert" className={styles.error}>
        <span>{COPY.loadError}</span>
        <Button size="sm" variant="outline" onClick={() => void made.mutate()}>
          {COPY.retry}
        </Button>
      </div>
    );
  }
  if (rows.length === 0) return null;

  const visible = showAll ? rows : rows.slice(0, FIRST_ROWS);
  return (
    <section aria-labelledby={titleId} className={styles.made}>
      <header className={styles.head}>
        <h2 id={titleId} className={theme.displayM}>
          {COPY.title}
        </h2>
        <p className={styles.about}>{COPY.about}</p>
      </header>
      <ul className={styles.rows}>
        {visible.map(row =>
          row.kind === "kit" ? (
            <KitRow
              key={`kit-${row.kit.id}`}
              workspaceId={workspaceId}
              kit={row.kit}
              products={products}
              onMakeAd={onMakeAd}
              onChanged={next =>
                void made.mutate(
                  current =>
                    current && {
                      ...current,
                      kits: current.kits.map(kit =>
                        kit.id === next.id ? next : kit
                      ),
                    },
                  { revalidate: true }
                )
              }
            />
          ) : (
            <AdRow
              key={`ad-${row.ad.id}`}
              ad={row.ad}
              now={now}
              onOpenAd={onOpenAd}
            />
          )
        )}
      </ul>
      {rows.length > FIRST_ROWS ? (
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={showAll}
          onClick={() => setShowAll(current => !current)}
        >
          {showAll ? COPY.showFewer : COPY.showAll(rows.length)}
        </Button>
      ) : null}
    </section>
  );
}

/** A picture of a product as its card shows it: the cut-out on white. */
function WhiteCard({ product }: { product: WorkspaceProductRecord }) {
  return (
    <span className={styles.whiteCard}>
      {product.imageUrl ? (
        // Signed storage links; next/image would need every bucket host.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={product.imageUrl} alt="" draggable={false} />
      ) : null}
    </span>
  );
}

/** A kit: its products, what each part is, and each part's next step. */
function KitRow({
  workspaceId,
  kit,
  products,
  onMakeAd,
  onChanged,
}: {
  workspaceId: string;
  kit: ProductKitRecord;
  products: ReadonlyMap<string, WorkspaceProductRecord>;
  onMakeAd: (productIds: string[]) => void;
  /** The kit as making a part again left it. */
  onChanged: (kit: ProductKitRecord) => void;
}) {
  const [remaking, setRemaking] = useState<ProductKitPart | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const views = kitPartViews(workspaceId, kit, remaking);
  // A part made again may take its Try again, and the focus, away: the
  // row's title takes the focus that fell to the page.
  const titleRef = useRef<HTMLParagraphElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    if (!settled.current || remaking !== null) return;
    settled.current = false;
    const active = document.activeElement;
    if (!active || active === document.body)
      titleRef.current?.focus({ preventScroll: true });
  });
  const onShelf = kit.productIds.flatMap(id => {
    const product = products.get(id);
    return product ? [product] : [];
  });
  const forAd = onShelf.filter(canGoInAd).slice(0, AD_MAX_PRODUCTS);
  const attention =
    kit.status === "needs_attention" &&
    !views.some(view => view.listChip.tone === "danger");

  const remake = async (part: ProductKitPart) => {
    setRemaking(part);
    setRefusal(null);
    try {
      onChanged(await retryProductKitPart(workspaceId, kit.id, part));
    } catch (error) {
      setRefusal(
        kitRequestErrorLine(
          error instanceof ProductDraftError ? error.code : "failed"
        )
      );
    } finally {
      settled.current = true;
      setRemaking(null);
    }
  };

  return (
    <li className={styles.row}>
      <span aria-hidden="true" className={styles.stack}>
        {onShelf.slice(0, 3).map(product => (
          <WhiteCard key={product.id} product={product} />
        ))}
      </span>
      <div className={styles.rowBody}>
        <p ref={titleRef} tabIndex={-1} className={styles.rowTitle}>
          {kitTitle(kit)}
        </p>
        <p className={styles.rowMeta}>
          {COPY.kitMeta(
            kit.productIds.length,
            madeWhen(kit.createdAt, new Date(), COPY)
          )}
        </p>
        <p className={styles.chips} aria-live="polite">
          {views.map(view => (
            <ProductChip key={view.part} tone={view.listChip.tone}>
              {view.listChip.label}
            </ProductChip>
          ))}
          {attention ? (
            <ProductChip tone="danger">{COPY.chips.needsAttention}</ProductChip>
          ) : null}
          {kit.pricesChanged ? (
            <ProductChip>{COPY.chips.pricesChanged}</ProductChip>
          ) : null}
        </p>
        {refusal ? (
          <p role="alert" className={styles.refusal}>
            {refusal}
          </p>
        ) : null}
      </div>
      <div className={styles.rowActions}>
        {views.flatMap(view =>
          view.actions.map(action =>
            action.kind === "link" ? (
              <Button
                key={`${view.part}-${action.label}`}
                asChild
                size="sm"
                variant="outline"
              >
                <Link href={action.href}>{action.label}</Link>
              </Button>
            ) : (
              <Button
                key={`${view.part}-${action.label}`}
                size="sm"
                variant="outline"
                {...retryBusy(remaking !== null)}
                onClick={() => {
                  if (remaking === null) void remake(action.part);
                }}
              >
                <RotateCcw aria-hidden="true" />
                {COPY.remake[action.part]}
              </Button>
            )
          )
        )}
        {forAd.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onMakeAd(forAd.map(product => product.id))}
          >
            {COPY.makeAd}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** A video ad: its poster, products and length, and Open. */
function AdRow({
  ad,
  now,
  onOpenAd,
}: {
  ad: ProductAdRecord;
  now: number;
  onOpenAd: (adId: string) => void;
}) {
  const poster =
    ad.video?.posterUrl ?? ad.stills.statusUrl ?? ad.products[0]?.imageUrl;
  const first = ad.products[0]?.name ?? COPY.adTitle;
  const products = COPY.adProducts(first, Math.max(0, ad.products.length - 1));
  const length = ad.video ? formatElapsed(ad.video.seconds * 1_000) : null;
  return (
    <li className={styles.row}>
      <span aria-hidden="true" className={styles.poster}>
        {poster ? (
          // Signed storage links; next/image would need every bucket host.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster} alt="" draggable={false} />
        ) : (
          <Clapperboard />
        )}
      </span>
      <div className={styles.rowBody}>
        <p className={styles.rowTitle}>{COPY.adTitle}</p>
        <p className={styles.rowMeta}>
          {length ? `${products} · ${length}` : products}
        </p>
        <p className={styles.chips}>
          {ad.status === "making" ? (
            <ProductChip tone="accent">
              {/* The current run's time, as the studio counts it: an edit
                  or a retry starts the clock again. */}
              {COPY.chips.adMaking(
                formatElapsed(now - Date.parse(ad.requestedAt))
              )}
            </ProductChip>
          ) : ad.status === "ready" ? (
            <ProductChip tone="ok">{COPY.chips.adReady}</ProductChip>
          ) : (
            <ProductChip tone="danger">{COPY.chips.adFailed}</ProductChip>
          )}
        </p>
      </div>
      <div className={styles.rowActions}>
        <Button size="sm" variant="outline" onClick={() => onOpenAd(ad.id)}>
          {COPY.open}
        </Button>
      </div>
    </li>
  );
}

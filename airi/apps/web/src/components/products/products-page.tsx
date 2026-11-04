"use client";

import { DndContext, DragOverlay } from "@dnd-kit/core";
import { Button } from "@/components/ui/button";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  productTemplate,
  productTemplateOfCtwa,
  productTemplateOfMotion,
  productTemplateOfPost,
  productTemplatePicks,
  PRODUCT_PICKS_MAX,
  type ProductTemplate,
  type ProductTemplateId,
  type ProductTemplateStamp,
} from "@/lib/products/templates";
import {
  productAdMotionOf,
  type DraftProductRecord,
  type ProductAdMotion,
  type ProductAdRecord,
  type ProductKitRecord,
  type ProductsErrorCode,
  type ProductsListResponse,
  type ProductVideoImportRecord,
  type ProductVideoImportResponse,
  type WorkspaceProductRecord,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import { Upload } from "lucide-react";
import { useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import useSWR, { useSWRConfig } from "swr";
import {
  createProductAd,
  fetchProductAd,
  fetchProductAdBrief,
  productAdBriefUrl,
  updateProductAd,
} from "./ads-client";
import { fetchMetaReadiness, productsMetaUrl } from "./meta-client";
import { adRequestId } from "./product-ad-parts";
import {
  CarriedStack,
  galleryTileId,
  GalleryHint,
  ProductGallery,
} from "./product-gallery";
import { MadeList } from "./product-made-list";
import { ProductReview } from "./product-review";
import {
  AddVideoBay,
  EmptyShelf,
  ProductShelfSkeleton,
  ShelfRows,
  type ShelfRowBay,
  type ShelfRowModel,
} from "./product-shelf";
import {
  draftShelfInfo,
  pickHero,
  type DraftShelfInfo,
} from "./product-stage-model";
import theme from "./product-theme.module.css";
import { ImportProgress, UploadProgress } from "./product-video-intake";
import { WhatsAppLinkButton } from "./product-whatsapp-link";
import {
  ProductWorkbench,
  type ProductWorkbenchSubject,
} from "./product-workbench";
import {
  fetchProductImport,
  fetchProducts,
  ProductDraftError,
  productAdUrl,
  productImportUrl,
  productsApiUrl,
  productsMadeUrl,
  reviewProducts,
} from "./products-client";
import { useProductDrag } from "./use-product-drag";
import { ProductAdAutoUpdateProvider } from "./use-product-ad";
import {
  isImportRunning,
  PRODUCT_IMPORT_POLL_MS,
  useProductImports,
} from "./use-product-imports";
import { useProductsMade } from "./use-product-kits";
import {
  AD_MAX_PRODUCTS,
  canGoInAd,
  cleanPicks,
  picksIn,
  useProductSelection,
} from "./use-product-selection";
import { useProductVideoUpload } from "./use-product-video-upload";

const EMPTY_PRODUCTS: WorkspaceProductRecord[] = [];
/** The most videos with rows of their own; older ones stand on the plain row. */
const ROW_IMPORTS_MAX = 12;
const ROWS = PRODUCTS_COPY.rows;

const carriesFiles = (event: DragEvent) =>
  Array.from(event.dataTransfer.types).includes("Files");

/**
 * What the page shows over the one page, with its own address so a link
 * opens it and Back closes it: the check of an import's products, one by
 * one (?review=<import>). Everything else is the one page: the shelf, its
 * picks (?picks=<ids>) and the tiles, with a tile's workbench in place
 * (?ad=<ad> opens an ad's).
 */
export type ProductsView =
  | { kind: "page" }
  | { kind: "review"; importId: string; productId?: string };

const PAGE: ProductsView = { kind: "page" };
/** Addresses of v2's views, read once and turned into picks. */
const LEGACY_PARAMS = ["make", "products"];
const OBJECT_ID = /^[a-f\d]{24}$/i;

/** The view an address opens; the page for one it can't read. */
export function productsViewIn(search: URLSearchParams | null): ProductsView {
  const review = search?.get("review");
  if (review && OBJECT_ID.test(review)) {
    const productId = search?.get("reviewProduct");
    return {
      kind: "review",
      importId: review,
      ...(productId && OBJECT_ID.test(productId) ? { productId } : {}),
    };
  }
  return PAGE;
}

/**
 * The picks an address asks for: ?picks=, else v2's ?make=<ids> and
 * ?ad=new&products=<ids>, which now open the one page with them picked.
 */
export function addressPicks(search: URLSearchParams | null): string[] {
  const picks = picksIn(search);
  if (picks.length > 0) return picks;
  const make = search?.get("make");
  if (make) return cleanPicks(make.split(","));
  if (search?.get("ad") === "new")
    return cleanPicks((search.get("products") ?? "").split(","));
  return [];
}

/** The ad an address opens (?ad=<id>), or null. */
export function addressAd(search: URLSearchParams | null): string | null {
  const ad = search?.get("ad");
  return ad && OBJECT_ID.test(ad) ? ad.toLowerCase() : null;
}

/** This page's address with these parameters set (null removes one). */
function pageAddress(changes: Record<string, string | null>): string {
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);
  for (const name of LEGACY_PARAMS) params.delete(name);
  if (params.get("ad") === "new") params.delete("ad");
  if (changes.review === null) params.delete("reviewProduct");
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) params.delete(name);
    else params.set(name, value);
  }
  // Ids are joined by plain commas, which an address keeps as they are.
  const search = params.toString().replace(/%2C/gi, ",");
  url.search = search ? `?${search}` : "";
  return url.toString();
}

/** How many views this page opened on top of its own entry, kept with each entry. */
const depthOf = (state: unknown): number => {
  const depth = (state as { productsDepth?: unknown } | null)?.productsDepth;
  return typeof depth === "number" && depth > 0 ? depth : 0;
};

/** The column the page scrolls in: the nearest ancestor that scrolls. */
function scrollColumnOf(from: Element | null): HTMLElement | null {
  for (let node = from?.parentElement; node; node = node.parentElement)
    if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
  return null;
}

// Inputs a key isn't typed into.
const PRESSED_INPUTS = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
]);

/** Whether a key is typed into a field, which keeps its own Escape. */
function typedInField(event: KeyboardEvent): boolean {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("textarea, select, [contenteditable='true']"))
    return true;
  const input = target?.closest("input");
  return Boolean(input && !PRESSED_INPUTS.has(input.type));
}

const WHEN = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const whenOf = (iso: string | null) => {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : WHEN.format(at);
};

/** Imports newest first; one without a date last. */
const newestFirst = (
  a: ProductVideoImportRecord,
  b: ProductVideoImportRecord
) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "");

/** The first-visit hint stays away once the owner made something. */
const HINT_KEY = "airi.products.v3.hint";
function hintDismissed(): boolean {
  try {
    return window.localStorage.getItem(HINT_KEY) === "done";
  } catch {
    return false;
  }
}
function dismissHint() {
  try {
    window.localStorage.setItem(HINT_KEY, "done");
  } catch {
    // Private windows and blocked storage: the hint just shows again.
  }
}

/** Refusals that come before an ad is written: the next press is a new one. */
const REFUSED_BEFORE_WRITING: ReadonlySet<string> = new Set([
  "ai_disabled",
  "ai_actions_used",
  "spend_limit",
  "trial_ended",
  "not_enough_products",
  "invalid_request",
  "ad_letters_unsupported",
  "product_not_found",
  "price_to_check",
]);

const codeOf = (error: unknown): ProductsErrorCode | "failed" =>
  error instanceof ProductDraftError
    ? (error.code as ProductsErrorCode | "failed")
    : "failed";

/** An ad's products, in its order, as one key. */
const productsKey = (ids: readonly string[]) => ids.join(",");

/** The ad these products already made, newest first; not a failed one. */
export function adForPicks(
  ads: readonly ProductAdRecord[],
  productIds: readonly string[]
): ProductAdRecord | null {
  if (productIds.length === 0) return null;
  const key = productsKey(productIds);
  return (
    ads.find(
      ad =>
        ad.status !== "failed" &&
        productsKey(ad.products.map(product => product.productId)) === key
    ) ?? null
  );
}

/** What each tile's stamp says, from what the ad and the kit put out on Meta. */
export function templateStamps(
  ad: ProductAdRecord | null,
  kit: ProductKitRecord | null
): Map<ProductTemplateId, ProductTemplateStamp> {
  const stamps = new Map<ProductTemplateId, ProductTemplateStamp>();
  for (const post of ad?.meta?.posts ?? []) {
    const template = productTemplateOfPost(post);
    if (!template) continue;
    if (post.state === "published") stamps.set(template.id, "live");
    else if (post.state === "failed" && !stamps.has(template.id))
      stamps.set(template.id, "failed");
  }
  const ctwa = ad?.meta?.ctwa ?? null;
  if (ctwa) {
    const template = productTemplateOfCtwa(ctwa);
    const status = ctwa.effectiveStatus?.toUpperCase() ?? null;
    const stamp: ProductTemplateStamp | null =
      ctwa.state === "failed"
        ? "failed"
        : ctwa.state === "paused"
          ? "paused"
          : ctwa.state === "running"
            ? status === null
              ? null
              : status === "ACTIVE"
                ? "live"
                : status === "DISAPPROVED"
                  ? "failed"
                  : "in_review"
            : null;
    if (stamp) stamps.set(template.id, stamp);
  }
  const carousel = kit?.parts.carousel ?? null;
  if (carousel) {
    const meta = carousel.metaStatus?.toUpperCase() ?? null;
    const stamp: ProductTemplateStamp | null =
      meta === "APPROVED"
        ? "approved"
        : meta === "REJECTED" || carousel.state === "failed"
          ? "failed"
          : carousel.state === "submitted"
            ? "in_review"
            : null;
    if (stamp) stamps.set("chat_kit", stamp);
  }
  return stamps;
}

/** The tile an ad's workbench opens on: what last went out from it, else its Reel. */
export function templateOfAd(ad: ProductAdRecord): ProductTemplate {
  const posts = ad.meta?.posts ?? [];
  const latest = [...posts].sort((a, b) =>
    b.requestedAt.localeCompare(a.requestedAt)
  )[0];
  const fromPost = latest ? productTemplateOfPost(latest) : null;
  if (fromPost?.shipped) return fromPost;
  const ctwa = ad.meta?.ctwa;
  if (ctwa) {
    const fromCtwa = productTemplateOfCtwa(ctwa);
    if (fromCtwa.shipped) return fromCtwa;
  }
  const reel = productTemplateOfMotion(productAdMotionOf(ad.motion));
  return reel.shipped ? reel : productTemplateOfMotion("shelf");
}

/** An open workbench: the tile it opened from, and what it shows. */
type OpenBench = {
  templateId: ProductTemplateId;
  subject: ProductWorkbenchSubject;
  /** The picks the tile used, in pick order, when it was made. */
  picks: WorkspaceProductRecord[];
  /** Each make counts, so an answer for an earlier one is let go. */
  make: number;
};

/** Fetches one import's products for its shelf row, sharing the stage's request. */
function ImportProbe({
  workspaceId,
  importId,
  running,
  onData,
}: {
  workspaceId: string;
  importId: string;
  running: boolean;
  onData: (importId: string, data: ProductVideoImportResponse | null) => void;
}) {
  const { data } = useSWR<ProductVideoImportResponse>(
    productImportUrl(workspaceId, importId),
    fetchProductImport,
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      refreshInterval: running ? PRODUCT_IMPORT_POLL_MS : 0,
    }
  );
  useEffect(() => {
    onData(importId, data ?? null);
  }, [importId, data, onData]);
  return null;
}

/** Products: the workspace's own catalog, which the owner fills by filming their shelf. */
export function ProductsPage({
  workspaceId,
  whatsappNumber = null,
}: {
  workspaceId: string;
  /** Airi's number shop owners send videos to, when that's set up. */
  whatsappNumber?: string | null;
}) {
  return (
    <ProductAdAutoUpdateProvider workspaceId={workspaceId}>
      <ProductsPageContent
        workspaceId={workspaceId}
        whatsappNumber={whatsappNumber}
      />
    </ProductAdAutoUpdateProvider>
  );
}

function ProductsPageContent({
  workspaceId,
  whatsappNumber,
}: {
  workspaceId: string;
  whatsappNumber: string | null;
}) {
  const { mutate: mutateKey } = useSWRConfig();
  const { data, error, isValidating, mutate } = useSWR<ProductsListResponse>(
    productsApiUrl(workspaceId),
    fetchProducts,
    // Photos come as signed links that change on every list; refetching on
    // focus would download every photo again.
    { shouldRetryOnError: false, revalidateOnFocus: false }
  );
  const published = data?.products ?? EMPTY_PRODUCTS;
  // What went out on Meta sits under the tiles; the tiles' stamps and the
  // ad the picks already made are read from it too.
  const made = useProductsMade(workspaceId);
  const madeSettled = made.data !== undefined || made.error !== undefined;
  const shelfId = useId();
  const galleryId = useId();
  const tilePrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  const { imports: listed, refresh: refreshImports } =
    useProductImports(workspaceId);
  // Rows the owner put away on this visit: still listed, no longer shown.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const imports = useMemo(
    () =>
      (dismissed.size > 0
        ? listed.filter(record => !dismissed.has(record.id))
        : listed
      )
        .slice()
        .sort(newestFirst),
    [listed, dismissed]
  );
  // First frames of the videos uploaded from this page, by import.
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const previewLinks = useRef(previews);
  useEffect(() => {
    previewLinks.current = previews;
  }, [previews]);
  useEffect(
    () => () => {
      for (const link of Object.values(previewLinks.current))
        URL.revokeObjectURL(link);
    },
    []
  );

  // Each finished import's products, for its row: drafts stand on it too.
  const [details, setDetails] = useState<
    ReadonlyMap<string, ProductVideoImportResponse>
  >(() => new Map());
  const onDetail = useCallback(
    (importId: string, detail: ProductVideoImportResponse | null) => {
      setDetails(current => {
        if (!detail) {
          if (!current.has(importId)) return current;
          const next = new Map(current);
          next.delete(importId);
          return next;
        }
        if (current.get(importId) === detail) return current;
        return new Map(current).set(importId, detail);
      });
    },
    []
  );

  // The one video on the stage: an upload from this page, else the first
  // import running, else the first that failed with products to check. Others
  // running are rows; a ready one collapses into its print, its products
  // standing on the shelf as a row.
  const upload = useProductVideoUpload(workspaceId, (importId, preview) => {
    setPreviews(current => ({ ...current, [importId]: preview }));
    // Shown as waiting right away, rather than after the next list.
    void refreshImports(
      current => ({
        imports: [
          {
            id: importId,
            status: "queued",
            stage: null,
            productTotal: 0,
            photoTotal: 0,
            photoDone: 0,
            errorCode: null,
            photosStopped: null,
            draftsLeft: false,
            presenter: null,
            createdAt: new Date().toISOString(),
            finishedAt: null,
          },
          ...(current?.imports ?? []).filter(entry => entry.id !== importId),
        ],
      }),
      { revalidate: true }
    );
  });
  const uploading = upload.state.phase !== "idle";
  const sending = uploading && upload.state.phase !== "failed";
  const running = useMemo(() => imports.filter(isImportRunning), [imports]);
  const hero = uploading
    ? null
    : pickHero(imports.filter(record => record.status !== "ready"));
  // Cards above the shelf: other imports running, and finished ones that
  // stand on no row (nothing found), failed, or stopped making photos, which
  // say why.
  const cards = imports.filter(
    record =>
      record !== hero &&
      (isImportRunning(record) ||
        record.status === "failed" ||
        record.productTotal === 0 ||
        record.photosStopped !== null)
  );
  // The videos the shelf has rows for: the finished ones the list shows
  // (with drafts left), and every video a shelf product came from, which
  // the list leaves out once all its products were checked. The newest
  // first; past ROW_IMPORTS_MAX their products stand on the plain row.
  const rowImports = useMemo(() => {
    const ids: string[] = [];
    const add = (id: string | null | undefined) => {
      if (!id || ids.includes(id) || id === hero?.id) return;
      if (running.some(record => record.id === id)) return;
      ids.push(id);
    };
    for (const record of imports)
      if (!isImportRunning(record) && record.productTotal > 0) add(record.id);
    for (const product of published) add(product.importId);
    return ids.slice(0, ROW_IMPORTS_MAX);
  }, [imports, published, hero, running]);

  // The shelf's rows: each video's products, newest first, in the order
  // they were named; the products of no video (or of an old one) on a last,
  // plain row.
  const { rows, shelfProducts, frames, draftImports, doubts } = useMemo(() => {
    const byId = new Map(published.map(product => [product.id, product]));
    const listedImports = new Map(imports.map(record => [record.id, record]));
    const placed = new Set<string>();
    const frameOf = new Map<string, string>();
    const draftOf = new Map<string, string>();
    const doubtful = new Set<string>();
    const built: Array<{ at: string; row: ShelfRowModel }> = [];
    for (const importId of rowImports) {
      const detail = details.get(importId) ?? null;
      const record = listedImports.get(importId) ?? detail?.import ?? null;
      const info =
        detail && record
          ? draftShelfInfo(detail.products, record)
          : new Map<string, DraftShelfInfo>();
      const bays: ShelfRowBay[] = [];
      const listedHere = (detail?.products ?? []) as DraftProductRecord[];
      for (const product of listedHere) {
        const option = product.options[product.featuredOption] ?? null;
        if (option?.originalUrl) frameOf.set(product.id, option.originalUrl);
        if (product.status === "draft") {
          const shelfInfo = info.get(product.id) ?? null;
          bays.push({ product, draft: true, info: shelfInfo });
          draftOf.set(product.id, importId);
          if (shelfInfo?.priceDoubt) doubtful.add(product.id);
          placed.add(product.id);
        } else if (product.status === "published" && byId.has(product.id)) {
          bays.push({
            product: byId.get(product.id)!,
            draft: false,
            info: null,
          });
          placed.add(product.id);
        }
      }
      // Shelf products of this video its own list didn't name (yet).
      for (const product of published)
        if (product.importId === importId && !placed.has(product.id)) {
          bays.push({ product, draft: false, info: null });
          placed.add(product.id);
        }
      if (bays.length === 0) continue;
      const first = listedHere[0];
      built.push({
        at: record?.createdAt ?? "",
        row: {
          key: importId,
          importId,
          when: whenOf(record?.createdAt ?? null),
          print: {
            frame:
              record?.presenter?.originalUrl ??
              first?.options[first.featuredOption]?.originalUrl ??
              null,
            video: previews[importId] ?? null,
          },
          bays,
          draftsLeft: bays.some(bay => bay.draft),
        },
      });
    }
    // Newest first; a video whose date isn't known yet keeps its place.
    built.sort((a, b) => (a.at && b.at ? b.at.localeCompare(a.at) : 0));
    const rest = published.filter(product => !placed.has(product.id));
    const rowsOut = built.map(entry => entry.row);
    if (rest.length > 0)
      rowsOut.push({
        key: "shelf",
        importId: null,
        when: null,
        print: null,
        bays: rest.map(product => ({ product, draft: false, info: null })),
        draftsLeft: false,
      });
    return {
      rows: rowsOut,
      shelfProducts: rowsOut.flatMap(row => row.bays.map(bay => bay.product)),
      frames: frameOf as ReadonlyMap<string, string>,
      draftImports: draftOf as ReadonlyMap<string, string>,
      doubts: doubtful as ReadonlySet<string>,
    };
  }, [rowImports, imports, details, published, previews]);

  const searchParams = useSearchParams();
  const [startAd, setStartAd] = useState(() => addressAd(searchParams));
  const selection = useProductSelection(shelfProducts, () =>
    addressPicks(searchParams)
  );
  // Whether the owner (or the address) set the picks: the page then never
  // picks for them.
  const touched = useRef(selection.picks.length > 0 || startAd !== null);

  const [view, setView] = useState<ProductsView>(() =>
    productsViewIn(searchParams)
  );
  // Each move in the browser's history, so the entry it lands on gets the picks.
  const [moves, setMoves] = useState(0);

  // The picks live in the address, so a reload keeps them; back from the
  // review, the page's own entry learns the picks made there.
  const picksParam = selection.picks.join(",");
  useEffect(() => {
    const want = picksParam || null;
    const params = new URLSearchParams(window.location.search);
    const legacy = LEGACY_PARAMS.some(name => params.has(name));
    if (params.get("picks") === want && !legacy) return;
    window.history.replaceState(
      window.history.state,
      "",
      pageAddress({ picks: want })
    );
    // searchParams: Next's router writes back the address it last heard of
    // (the review's close, from before the picks changed); the picks are
    // put back in when it does.
  }, [picksParam, view.kind, moves, searchParams]);

  // Picks for the owner: once the shelf shows, the newest video's first 3,
  // so every tile shows real products at once; and a video that finishes
  // while nothing is picked has its first 3 picked. A tap changes them.
  const wasRunning = useRef<ReadonlySet<string>>(new Set());
  const justFinished = useRef<string | null>(null);
  useEffect(() => {
    const now = new Set(running.map(record => record.id));
    for (const id of wasRunning.current)
      if (!now.has(id)) justFinished.current = id;
    wasRunning.current = now;
  }, [running]);
  const { set: setPicks } = selection;
  useEffect(() => {
    if (selection.picks.length > 0) {
      justFinished.current = null;
      return;
    }
    const row =
      (justFinished.current
        ? rows.find(entry => entry.importId === justFinished.current)
        : null) ?? (!touched.current ? rows[0] : null);
    if (!row || row.bays.length === 0) return;
    // In the order the owner named them, once the video's own list is in.
    if (row.importId && !details.has(row.importId)) return;
    justFinished.current = null;
    touched.current = true;
    setPicks(row.bays.slice(0, AD_MAX_PRODUCTS).map(bay => bay.product.id));
  }, [rows, details, selection.picks.length, setPicks]);

  // How many views this page opened on top of its own entry in the
  // browser's history: closing a view goes back that far, so Back after it
  // doesn't open it again.
  const depth = useRef(0);
  const closing = useRef(false);
  useEffect(() => {
    depth.current = depthOf(window.history.state);
    const onPop = () => {
      setMoves(count => count + 1);
      const next = productsViewIn(new URLSearchParams(window.location.search));
      if (closing.current) {
        closing.current = false;
        depth.current = 0;
        // The first entry was the review's own address, opened from a link.
        if (next.kind !== "page")
          window.history.replaceState(null, "", pageAddress({ review: null }));
        setView(PAGE);
        return;
      }
      depth.current = depthOf(window.history.state);
      setView(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const pageRoot = useRef<HTMLElement>(null);
  const pageScroll = useRef<number | null>(null);
  const viewKey = view.kind === "review" ? `review:${view.importId}` : "page";
  const lastViewKey = useRef(viewKey);
  useEffect(() => {
    if (lastViewKey.current === viewKey) return;
    lastViewKey.current = viewKey;
    const column = scrollColumnOf(pageRoot.current);
    if (view.kind === "page") {
      if (column && pageScroll.current !== null)
        column.scrollTop = pageScroll.current;
      pageScroll.current = null;
      return;
    }
    if (column) column.scrollTop = 0;
  }, [viewKey, view.kind]);

  const openReview = useCallback((importId: string, productId?: string) => {
    if (lastViewKey.current === "page")
      pageScroll.current = scrollColumnOf(pageRoot.current)?.scrollTop ?? null;
    const level = depth.current + 1;
    window.history.pushState(
      { productsDepth: level },
      "",
      pageAddress({
        review: importId,
        reviewProduct: productId ?? null,
        ad: null,
      })
    );
    depth.current = level;
    setView({ kind: "review", importId, ...(productId ? { productId } : {}) });
  }, []);
  /** Back to the page from the review, however deep. */
  const closeReview = useCallback(() => {
    const level = depth.current;
    depth.current = 0;
    if (level > 0) {
      closing.current = true;
      window.history.go(-level);
    } else {
      window.history.replaceState(null, "", pageAddress({ review: null }));
    }
    setView(PAGE);
  }, []);

  // ------------------------------------------------------------ the make

  const ads = made.data?.ads;
  const madeAds = useMemo(() => ads ?? [], [ads]);
  const picked = selection.picked;
  const adPicks = useMemo(
    () => picked.filter(canGoInAd).slice(0, AD_MAX_PRODUCTS),
    [picked]
  );
  const adPickIds = useMemo(
    () => adPicks.map(product => product.id),
    [adPicks]
  );
  // Ads made on this visit, by their products, before the made list has them.
  const [madeHere, setMadeHere] = useState<ReadonlyMap<string, string>>(
    () => new Map()
  );
  const listedAd = adForPicks(madeAds, adPickIds);
  const currentAdId =
    listedAd?.id ?? madeHere.get(productsKey(adPickIds)) ?? null;

  const [open, setOpen] = useState<OpenBench | null>(null);
  const makes = useRef(0);
  const openAdId = open?.subject.kind === "ad" ? open.subject.adId : null;

  // A motion change asked for while the ad's video was being made: sent
  // once it's ready (409 ad_not_ready means a run is going).
  const [waitingMotion, setWaitingMotion] = useState<{
    adId: string;
    motion: ProductAdMotion;
  } | null>(null);

  // The ad these picks made, as the workbench reads it: its stills and its
  // stamps. The same request as the workbench's, so it's asked for once.
  const watchedAdId = openAdId ?? startAd ?? currentAdId;
  const { data: watchedAd, error: watchedError } = useSWR<ProductAdRecord>(
    watchedAdId ? productAdUrl(workspaceId, watchedAdId) : null,
    fetchProductAd,
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      refreshInterval: waitingMotion ? 3000 : 0,
    }
  );
  // The picks' ad as its own read, with its stills: the made list's read
  // leaves them out. The same request as the workbench's when it's open on
  // this ad, so it's asked for once.
  const { data: pickedAdRead } = useSWR<ProductAdRecord>(
    currentAdId ? productAdUrl(workspaceId, currentAdId) : null,
    fetchProductAd,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const currentRead =
    currentAdId !== null && pickedAdRead?.id === currentAdId
      ? pickedAdRead
      : null;
  const currentAd =
    currentAdId === null ? null : (currentRead ?? listedAd ?? null);

  const kits = made.data?.kits;
  const kitPickIds = useMemo(
    () =>
      productTemplatePicks(
        productTemplate("chat_kit")!,
        picked.map(product => product.id)
      ),
    [picked]
  );
  const currentKit = useMemo(
    () =>
      (kits ?? []).find(
        kit => productsKey(kit.productIds) === productsKey(kitPickIds)
      ) ?? null,
    [kits, kitPickIds]
  );
  const stamps = useMemo(
    () => templateStamps(currentAd, currentKit),
    [currentAd, currentKit]
  );

  // AI off for the company: tiles that need a new ad lock; an ad that
  // exists, and what it puts out on Meta, still work.
  const { data: readiness } = useSWR(
    productsMetaUrl(workspaceId),
    fetchMetaReadiness,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const locked =
    readiness?.ai?.blocked === "ai_disabled"
      ? PRODUCTS_COPY.gallery.aiOff
      : null;

  const [lastAdKey, setLastAdKey] = useState<string | null>(null);
  const newPicks =
    lastAdKey !== null &&
    adPickIds.length > 0 &&
    lastAdKey !== productsKey(adPickIds) &&
    currentAdId === null;

  const [hint, setHint] = useState(false);
  useEffect(() => {
    setHint(!hintDismissed());
  }, []);

  /** Puts drafts among these products on the shelf: a make is the owner's swipe right. */
  const publishDrafts = useCallback(
    async (products: readonly WorkspaceProductRecord[]) => {
      const byImport = new Map<string, string[]>();
      for (const product of products) {
        const importId = draftImports.get(product.id);
        if (!importId) continue;
        byImport.set(importId, [...(byImport.get(importId) ?? []), product.id]);
      }
      if (byImport.size === 0) return;
      for (const [importId, ids] of byImport)
        await reviewProducts(workspaceId, importId, ids, "published");
      await Promise.all([
        mutate(),
        ...[...byImport.keys()].map(importId =>
          mutateKey(productImportUrl(workspaceId, importId))
        ),
        refreshImports(),
      ]);
    },
    [draftImports, workspaceId, mutate, mutateKey, refreshImports]
  );

  const sendMotion = useCallback(
    async (adId: string, motion: ProductAdMotion) => {
      try {
        const ad = await updateProductAd(workspaceId, adId, { motion });
        setWaitingMotion(current => (current?.adId === adId ? null : current));
        await mutateKey(productAdUrl(workspaceId, adId), ad, {
          revalidate: false,
        });
        void mutateKey(productsMadeUrl(workspaceId));
      } catch (failure) {
        // A run is going: the change waits for it, as the workbench's own
        // changes do, and goes when the video is ready.
        if (codeOf(failure) === "ad_not_ready")
          setWaitingMotion({ adId, motion });
        else
          setWaitingMotion(current =>
            current?.adId === adId ? null : current
          );
      }
    },
    [workspaceId, mutateKey]
  );
  useEffect(() => {
    if (!waitingMotion || watchedAd?.id !== waitingMotion.adId) return;
    if (watchedAd.status !== "ready") return;
    if (productAdMotionOf(watchedAd.motion) === waitingMotion.motion) {
      setWaitingMotion(null);
      return;
    }
    void sendMotion(waitingMotion.adId, waitingMotion.motion);
  }, [waitingMotion, watchedAd, sendMotion]);

  // The press being made, so trying again sends the same id: under it the
  // server answers with the ad it already saved.
  const press = useRef<{ key: string; id: string } | null>(null);

  const make = useCallback(
    async (template: ProductTemplate) => {
      const number = ++makes.current;
      if (hint) {
        setHint(false);
        dismissHint();
      }
      const still = () => makes.current === number;
      if (template.makes === "kit") {
        const kitPicks = productTemplatePicks(template, picked);
        // Opening a kit must not count as confirming a price flagged by the
        // import: publishing it here would also remove the shelf's red tag.
        if (kitPicks.some(product => doubts.has(product.id))) {
          setOpen({
            templateId: template.id,
            subject: { kind: "ad-pending", error: "price_to_check" },
            picks: kitPicks,
            make: number,
          });
          return;
        }
        const importIds = new Set(
          kitPicks.map(
            product => draftImports.get(product.id) ?? product.importId ?? null
          )
        );
        const [onlyImport] = [...importIds];
        setOpen({
          templateId: template.id,
          subject: {
            kind: "kit",
            productIds: kitPicks.map(product => product.id),
            importId: importIds.size === 1 ? (onlyImport ?? null) : null,
          },
          picks: kitPicks,
          make: number,
        });
        // The kit is made of shelf products: drafts among the picks go on
        // the shelf first.
        try {
          await publishDrafts(kitPicks);
        } catch {
          // The kit's own make says what it couldn't use.
        }
        return;
      }

      const tilePicks = productTemplatePicks(template, adPicks);
      if (tilePicks.length === 0) return;
      const ids = tilePicks.map(product => product.id);
      const key = productsKey(ids);
      setLastAdKey(key);
      const opened = (subject: ProductWorkbenchSubject) =>
        setOpen({
          templateId: template.id,
          subject,
          picks: tilePicks,
          make: number,
        });

      if (tilePicks.some(product => doubts.has(product.id))) {
        opened({ kind: "ad-pending", error: "price_to_check" });
        return;
      }
      const existing =
        adForPicks(madeAds, ids)?.id ?? madeHere.get(key) ?? null;
      if (existing) {
        opened({ kind: "ad", adId: existing });
        const known =
          watchedAd?.id === existing
            ? watchedAd
            : (madeAds.find(ad => ad.id === existing) ?? null);
        if (
          template.renderer === "motion" &&
          template.motion &&
          known &&
          productAdMotionOf(known.motion) !== template.motion
        )
          void sendMotion(existing, template.motion);
        return;
      }

      opened({ kind: "ad-pending", error: null });
      const motion =
        template.renderer === "motion" ? template.motion : undefined;
      const pressKey = `${key}|${motion ?? "shelf"}`;
      const id =
        press.current?.key === pressKey ? press.current.id : adRequestId();
      press.current = { key: pressKey, id };
      try {
        await publishDrafts(tilePicks);
        const brief = await fetchProductAdBrief(
          productAdBriefUrl(workspaceId, ids)
        );
        if (brief.blocked) throw new ProductDraftError(brief.blocked);
        if (
          brief.products.length === 0 ||
          brief.products.some(product => product.problem !== null)
        )
          throw new ProductDraftError("not_enough_products");
        const ad = await createProductAd(workspaceId, {
          requestId: id,
          productIds: ids,
          idea: { kind: "new" },
          // The owner's own recording when the video has them saying a price.
          voice: brief.products.some(product => product.hasVoice)
            ? "own"
            : "none",
          presenter: { use: false, consent: false },
          music: "acoustic",
          ...(motion ? { motion } : {}),
        });
        press.current = null;
        await mutateKey(productAdUrl(workspaceId, ad.id), ad, {
          revalidate: false,
        });
        void mutateKey(productsMadeUrl(workspaceId));
        setMadeHere(current => new Map(current).set(key, ad.id));
        if (still())
          setOpen(current =>
            current?.make === number
              ? { ...current, subject: { kind: "ad", adId: ad.id } }
              : current
          );
      } catch (failure) {
        const code = codeOf(failure);
        if (REFUSED_BEFORE_WRITING.has(code)) press.current = null;
        if (still())
          setOpen(current =>
            current?.make === number
              ? { ...current, subject: { kind: "ad-pending", error: code } }
              : current
          );
      }
    },
    [
      hint,
      picked,
      adPicks,
      draftImports,
      doubts,
      madeAds,
      madeHere,
      watchedAd,
      publishDrafts,
      sendMotion,
      workspaceId,
      mutateKey,
    ]
  );

  // ?ad=<id>: that ad's workbench, on its last tile, with its products
  // picked. An ad that can't be read opens nothing.
  useEffect(() => {
    if (startAd && watchedError && watchedAdId === startAd) setStartAd(null);
  }, [startAd, watchedError, watchedAdId]);
  useEffect(() => {
    if (!startAd || watchedAd?.id !== startAd) return;
    setStartAd(null);
    const ids = watchedAd.products.map(product => product.productId);
    if (selection.picks.length === 0) setPicks(ids);
    const template = templateOfAd(watchedAd);
    setLastAdKey(productsKey(ids));
    setMadeHere(current => new Map(current).set(productsKey(ids), startAd));
    setOpen({
      templateId: template.id,
      subject: { kind: "ad", adId: startAd },
      picks: [],
      make: ++makes.current,
    });
  }, [startAd, watchedAd, selection.picks.length, setPicks]);

  // The open ad's workbench keeps its address (?ad=<id>), so a reload
  // returns to it.
  useEffect(() => {
    if (view.kind !== "page") return;
    const want = openAdId;
    const params = new URLSearchParams(window.location.search);
    if (params.get("ad") === want || (!want && !params.has("ad"))) return;
    if (!want && startAd) return;
    window.history.replaceState(
      window.history.state,
      "",
      pageAddress({ ad: want })
    );
  }, [openAdId, view.kind, startAd]);

  const closeBench = useCallback(() => {
    const tileId = open ? galleryTileId(tilePrefix, open.templateId) : null;
    setOpen(null);
    if (tileId)
      requestAnimationFrame(() => document.getElementById(tileId)?.focus());
  }, [open, tilePrefix]);

  // Escape closes the workbench from anywhere on the page, but not from a
  // field, nor while an open popover takes it.
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.isComposing ||
      typedInField(event) ||
      view.kind !== "page" ||
      !open
    )
      return;
    event.preventDefault();
    closeBench();
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // ------------------------------------------------------------ the drag

  const pickedCount = useRef(0);
  pickedCount.current = picked.length;
  const carried = useCallback(() => pickedCount.current, []);
  const { pick, toggle } = selection;
  const drag = useProductDrag({
    carried,
    onCarry: useCallback(
      (productId: string) => {
        touched.current = true;
        pick(productId);
      },
      [pick]
    ),
    onDrop: make,
  });
  const onToggle = useCallback(
    (productId: string) => {
      if (drag.justDropped()) return;
      touched.current = true;
      toggle(productId);
    },
    [drag, toggle]
  );

  // ------------------------------------------------------------ the page

  // Where the keyboard's focus goes once the control it was on has gone:
  // the "+" bay, as a video's upload card or row leaves.
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const refocusAdd = useRef(false);
  useEffect(() => {
    if (!refocusAdd.current) return;
    const element = addButtonRef.current;
    if (!element) return;
    refocusAdd.current = false;
    if (!document.activeElement || document.activeElement === document.body)
      element.focus();
  });

  const fileInput = useRef<HTMLInputElement>(null);
  const chooseVideo = () => fileInput.current?.click();
  const [draggingFile, setDraggingFile] = useState(false);
  const inReview = view.kind === "review";

  const stopUpload = () => {
    refocusAdd.current = true;
    upload.cancel();
  };
  const dismissRow = (importId: string) => {
    refocusAdd.current = true;
    setDismissed(current => new Set(current).add(importId));
  };

  const emptyShelf =
    data !== undefined &&
    published.length === 0 &&
    rows.length === 0 &&
    !uploading &&
    imports.length === 0;
  const videos = new Set(
    published.flatMap(product => (product.importId ? [product.importId] : []))
  ).size;

  const whatsappButton = (className: string) =>
    whatsappNumber ? (
      <WhatsAppLinkButton
        workspaceId={workspaceId}
        number={whatsappNumber}
        className={className}
      />
    ) : null;

  const addBay = (
    <AddVideoBay
      onChoose={chooseVideo}
      buttonRef={addButtonRef}
      disabled={sending}
      extra={whatsappButton(
        "h-auto min-h-7 w-full justify-center gap-1 whitespace-normal px-1 py-1 text-[11px] leading-[13px] [&_svg]:size-3.5"
      )}
    />
  );

  let shelf: ReactNode = null;
  if (!data) {
    shelf =
      error && !isValidating ? (
        <EmptyShelf lit={false}>
          <p
            role="alert"
            className="text-[15px] leading-[22px] font-medium text-(--p-ink)"
          >
            {PRODUCTS_COPY.loadError}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void mutate()}
          >
            {PRODUCTS_COPY.retry}
          </Button>
        </EmptyShelf>
      ) : (
        <ProductShelfSkeleton />
      );
  } else if (rows.length > 0 && !madeSettled) {
    shelf = <ProductShelfSkeleton />;
  } else if (emptyShelf) {
    shelf = (
      <EmptyShelf>
        <h2 className={cn(theme.displayL, "max-w-[20ch] text-balance")}>
          {PRODUCTS_COPY.emptyTitle}
        </h2>
        <p className="mt-2.5 max-w-[50ch] text-[15px] leading-[22px] text-balance text-(--p-ink-2)">
          {PRODUCTS_COPY.emptyDescription}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5 max-sm:w-full max-sm:flex-col max-sm:items-stretch">
          {/* Stacked and full width on a phone. */}
          <Button
            ref={addButtonRef}
            className={theme.fillOnPhone}
            onClick={chooseVideo}
          >
            <Upload aria-hidden="true" />
            {PRODUCTS_COPY.uploadVideo}
          </Button>
          {whatsappButton("h-10 px-4 text-sm")}
        </div>
        <p className="mt-3 text-xs leading-4 text-(--p-ink-2)">
          {PRODUCTS_COPY.uploadHint}
        </p>
      </EmptyShelf>
    );
  } else {
    shelf = (
      <div className="min-w-0">
        <h2 id={shelfId} className="sr-only">
          {ROWS.label}
        </h2>
        <ShelfRows
          rows={rows}
          numbers={selection.numbers}
          labelledBy={shelfId}
          addBay={addBay}
          onToggle={onToggle}
          onCheckOneByOne={openReview}
          onFixPrice={(bay, importId) => {
            if (importId) openReview(importId, bay.product.id);
          }}
        />
        <p aria-live="polite" className="sr-only">
          {ROWS.picked(picked.length)}
        </p>
      </div>
    );
  }

  const openTemplate = open ? productTemplate(open.templateId) : null;
  const workbench =
    open && openTemplate ? (
      <ProductWorkbench
        key={open.templateId}
        workspaceId={workspaceId}
        template={openTemplate}
        subject={open.subject}
        picks={open.picks.length > 0 ? open.picks : adPicks}
        priceToCheck={(open.picks.length > 0 ? open.picks : adPicks).some(
          product => doubts.has(product.id)
        )}
        tileId={galleryTileId(tilePrefix, open.templateId)}
        onClose={closeBench}
        onRetryMake={() => void make(openTemplate)}
        onCheckOneByOne={openReview}
        onCheckPrice={() => {
          const product = (open.picks.length > 0 ? open.picks : adPicks).find(
            pick => doubts.has(pick.id)
          );
          if (!product) return;
          const importId = draftImports.get(product.id) ?? product.importId;
          if (importId) openReview(importId, product.id);
        }}
        onChanged={() => {
          void mutateKey(productsMadeUrl(workspaceId));
        }}
      />
    ) : null;

  const showGallery = data !== undefined && rows.length > 0 && madeSettled;
  const carriedProducts = drag.carrying ? picked : [];

  return (
    <section
      ref={pageRoot}
      className="relative flex min-w-0 flex-col gap-10 max-sm:gap-8"
      // A file dropped on the page is always caught: left to the browser, it
      // would open the file in place of the page, and stop an upload. During
      // an upload or the review, a drop does nothing.
      onDragEnter={event => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        if (!sending && !inReview) setDraggingFile(true);
      }}
      onDragOver={event => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = sending || inReview ? "none" : "copy";
      }}
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDraggingFile(false);
      }}
      onDrop={event => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDraggingFile(false);
        const file = event.dataTransfer.files[0];
        if (file && !sending && !inReview) upload.start(file);
      }}
    >
      {/* Opened by the upload buttons, which are what assistive tech meets. */}
      <input
        ref={fileInput}
        type="file"
        accept="video/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        aria-label={PRODUCTS_COPY.uploadVideo}
        onChange={event => {
          const file = event.currentTarget.files?.[0];
          // Cleared, so choosing the same video again still counts.
          event.currentTarget.value = "";
          if (file) upload.start(file);
        }}
      />
      {rowImports.map(importId => (
        <ImportProbe
          key={importId}
          workspaceId={workspaceId}
          importId={importId}
          running={false}
          onData={onDetail}
        />
      ))}
      {view.kind === "review" ? (
        <>
          {/* The page's title stays for assistive tech while the review shows. */}
          <h1 className="sr-only">{PRODUCTS_COPY.title}</h1>
          <ProductReview
            key={`${view.importId}:${view.productId ?? ""}`}
            workspaceId={workspaceId}
            importId={view.importId}
            initialProductId={view.productId}
            onClose={closeReview}
            // Back from a finished check: what was added is picked.
            onChangeProducts={ids => {
              touched.current = true;
              setPicks(ids.slice(0, PRODUCT_PICKS_MAX));
              closeReview();
            }}
          />
        </>
      ) : (
        <>
          <header className="flex min-w-0 flex-col">
            <h1 className={theme.displayXl}>
              {PRODUCTS_COPY.title}
              {data && published.length > 0 ? (
                <span className="mt-1 block font-sans text-[15px] leading-[22px] font-medium tracking-normal text-(--p-ink-2) tabular-nums sm:mt-0 sm:ml-2.5 sm:inline sm:align-middle sm:text-[17px]">
                  <span className="sr-only">: </span>
                  {PRODUCTS_COPY.page.onShelf(published.length, videos)}
                </span>
              ) : null}
            </h1>
            {/* The section is new: judges and owners see so, under the title. */}
            <p className="mt-1.5 text-[13px] leading-[18px] text-(--p-ink-2)">
              {PRODUCTS_COPY.hackathonNote}
            </p>
          </header>
          {upload.state.phase !== "idle" ? (
            <UploadProgress
              state={upload.state}
              onCancel={stopUpload}
              onRetry={upload.retry}
            />
          ) : null}
          {hero ? (
            <ImportProgress
              key={hero.id}
              workspaceId={workspaceId}
              record={hero}
              preview={previews[hero.id] ?? null}
              variant="stage"
              onReview={openReview}
            />
          ) : null}
          {cards.length > 0 ? (
            <ul
              aria-label={PRODUCTS_COPY.stage.otherVideos}
              className="flex flex-col gap-4"
            >
              {cards.map(record => (
                <li key={record.id}>
                  <ImportProgress
                    workspaceId={workspaceId}
                    record={record}
                    preview={previews[record.id] ?? null}
                    variant="row"
                    onReview={openReview}
                    onUploadAgain={sending ? undefined : chooseVideo}
                    onDismiss={dismissRow}
                  />
                </li>
              ))}
            </ul>
          ) : null}
          <DndContext
            sensors={drag.sensors}
            accessibility={drag.accessibility}
            {...drag.events}
          >
            {shelf}
            {showGallery ? (
              <div className="flex min-w-0 flex-col gap-5">
                <h2 id={galleryId} className="sr-only">
                  {PRODUCTS_COPY.gallery.label}
                </h2>
                <ProductGallery
                  idPrefix={tilePrefix}
                  picks={picked}
                  adPicks={adPicks}
                  frames={frames}
                  ad={currentAd}
                  adStillsRead={currentRead !== null}
                  stamps={stamps}
                  locked={locked}
                  newPicks={newPicks}
                  openId={open?.templateId ?? null}
                  workbench={workbench}
                  carrying={drag.carrying !== null}
                  onMake={template => void make(template)}
                />
                {hint && !open ? <GalleryHint /> : null}
              </div>
            ) : null}
            <DragOverlay dropAnimation={null}>
              {carriedProducts.length > 0 ? (
                <CarriedStack products={carriedProducts} />
              ) : null}
            </DragOverlay>
          </DndContext>
          {/* What went out on Meta, once the shelf holds something. */}
          {published.length > 0 ? (
            <MadeList
              workspaceId={workspaceId}
              // A receipt opens its ad's workbench on the tile it went out
              // from, else on the ad's last tile, with its products picked.
              onOpenAd={(adId, templateId) => {
                const ad = madeAds.find(entry => entry.id === adId);
                if (!ad) return;
                const ids = ad.products.map(product => product.productId);
                const from = productTemplate(templateId);
                touched.current = true;
                setPicks(ids);
                setLastAdKey(productsKey(ids));
                setOpen({
                  templateId:
                    from?.shipped && from.makes === "ad"
                      ? from.id
                      : templateOfAd(ad).id,
                  subject: { kind: "ad", adId },
                  picks: [],
                  make: ++makes.current,
                });
              }}
              // A WhatsApp chat receipt: the chat tile, with its products picked.
              onOpenKit={kit => {
                touched.current = true;
                setPicks(kit.productIds);
                setOpen({
                  templateId: "chat_kit",
                  subject: {
                    kind: "kit",
                    productIds: kit.productIds,
                    importId: kit.importId,
                  },
                  picks: kit.productIds.flatMap(id => {
                    const product = shelfProducts.find(
                      entry => entry.id === id
                    );
                    return product ? [product] : [];
                  }),
                  make: ++makes.current,
                });
              }}
            />
          ) : null}
        </>
      )}
      <div
        aria-hidden="true"
        className={cn(
          // Inside the page's narrowest side margin (16 px), so it never
          // makes the page scroll sideways; above the stage, which has its
          // own layers.
          "pointer-events-none absolute -inset-2 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-(--p-line-strong) bg-[color-mix(in_oklab,var(--p-paper)_85%,transparent)] text-[15px] font-medium text-(--p-ink) transition-opacity duration-200",
          draggingFile ? "opacity-100" : "opacity-0"
        )}
      >
        {PRODUCTS_COPY.dropVideo}
      </div>
    </section>
  );
}

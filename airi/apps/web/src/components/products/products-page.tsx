"use client";

import { Button } from "@/components/ui/button";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import type {
  ProductsListResponse,
  WorkspaceProductRecord,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import { ArrowLeft, ListChecks, Upload } from "lucide-react";
import { useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import useSWR from "swr";
import { AdStudio } from "./product-ad-studio";
import { ProductChooseBar } from "./product-choose-bar";
import { MadeList } from "./product-made-list";
import { MakeOutputs } from "./product-make";
import { ProductReview } from "./product-review";
import {
  EmptyShelf,
  ProductShelf,
  ProductShelfSkeleton,
  ShelfHeading,
} from "./product-shelf";
import { pickHero } from "./product-stage-model";
import theme from "./product-theme.module.css";
import { ImportProgress, UploadProgress } from "./product-video-intake";
import { WhatsAppLinkButton } from "./product-whatsapp-link";
import { fetchProducts, productsApiUrl } from "./products-client";
import { useProductImports } from "./use-product-imports";
import { useProductsMade } from "./use-product-kits";
import {
  AD_MAX_PRODUCTS,
  MAKE_MAX_PRODUCTS,
  useProductSelection,
} from "./use-product-selection";
import { useProductVideoUpload } from "./use-product-video-upload";

const EMPTY_PRODUCTS: WorkspaceProductRecord[] = [];

const carriesFiles = (event: DragEvent) =>
  Array.from(event.dataTransfer.types).includes("Files");

/**
 * What the page shows, each with its own address so a link opens it and Back
 * closes it: the shelf, the check of an import's products (?review=<import>),
 * what to make with products (?make=<ids>, in shelf order), and a video ad's
 * studio, new (?ad=new&products=<ids>) or made (?ad=<ad>).
 */
export type ProductsView =
  | { kind: "shelf" }
  | { kind: "review"; importId: string }
  | { kind: "make"; productIds: string[] }
  | { kind: "ad-new"; productIds: string[] }
  | { kind: "ad"; adId: string };

const SHELF: ProductsView = { kind: "shelf" };
const VIEW_PARAMS = ["review", "make", "ad", "products"];
const OBJECT_ID = /^[a-f\d]{24}$/i;

/** 1 to `max` distinct ids, or null for anything else. */
function idsIn(value: string | null | undefined, max: number) {
  if (!value) return null;
  const ids = [...new Set(value.split(","))];
  return ids.length <= max && ids.every(id => OBJECT_ID.test(id)) ? ids : null;
}

/** The view an address opens; the shelf for one it can't read. */
export function productsViewIn(search: URLSearchParams | null): ProductsView {
  const review = search?.get("review");
  if (review && OBJECT_ID.test(review))
    return { kind: "review", importId: review };
  const make = idsIn(search?.get("make"), MAKE_MAX_PRODUCTS);
  if (make) return { kind: "make", productIds: make };
  const ad = search?.get("ad");
  if (ad === "new") {
    const products = idsIn(search?.get("products"), AD_MAX_PRODUCTS);
    if (products) return { kind: "ad-new", productIds: products };
  } else if (ad && OBJECT_ID.test(ad)) {
    return { kind: "ad", adId: ad };
  }
  return SHELF;
}

/** This page's address showing `view`, keeping any other parameters. */
function viewAddress(view: ProductsView): string {
  const url = new URL(window.location.href);
  const rest = new URLSearchParams(url.search);
  for (const name of VIEW_PARAMS) rest.delete(name);
  // Ids are joined by plain commas, which an address keeps as they are.
  const own =
    view.kind === "review"
      ? `review=${encodeURIComponent(view.importId)}`
      : view.kind === "make"
        ? `make=${view.productIds.join(",")}`
        : view.kind === "ad-new"
          ? `ad=new&products=${view.productIds.join(",")}`
          : view.kind === "ad"
            ? `ad=${view.adId}`
            : "";
  const search = [rest.toString(), own].filter(Boolean).join("&");
  url.search = search ? `?${search}` : "";
  return url.toString();
}

/** How many views this page opened on top of the shelf, kept with each entry. */
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

// Inputs a key isn't typed into: a bay's checkbox lets Escape through.
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

/** Products: the workspace's own catalog, which the owner fills by filming their shelf. */
export function ProductsPage({
  workspaceId,
  whatsappNumber = null,
}: {
  workspaceId: string;
  /** Airi's number shop owners send videos to, when that's set up. */
  whatsappNumber?: string | null;
}) {
  const { data, error, isValidating, mutate } = useSWR<ProductsListResponse>(
    productsApiUrl(workspaceId),
    fetchProducts,
    // Photos come as signed links that change on every list; refetching on
    // focus would download every photo again.
    { shouldRetryOnError: false, revalidateOnFocus: false }
  );
  const products = data?.products ?? EMPTY_PRODUCTS;
  // Made from your shelf goes above the shelf: asked for with the products
  // (the list shares this request), and the shelf waits for its answer, so
  // the list doesn't push the shelf down under the owner's finger.
  const made = useProductsMade(workspaceId);
  const madeSettled = made.data !== undefined || made.error !== undefined;
  const shelfId = useId();
  const selection = useProductSelection(products);

  const { imports: listed, refresh: refreshImports } =
    useProductImports(workspaceId);
  // Rows the owner put away on this visit: still listed, no longer shown.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const imports =
    dismissed.size > 0
      ? listed.filter(record => !dismissed.has(record.id))
      : listed;
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

  // Where the keyboard's focus goes once the control it was on has gone:
  // the upload button (an upload's row went, or a view closed), or the
  // Choose button, or the choose bar's make button (a view opened from it
  // closed). Only when the focus fell to the page.
  const uploadButtonRef = useRef<HTMLButtonElement>(null);
  const chooseButtonRef = useRef<HTMLButtonElement>(null);
  const makeKitButtonRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef<"upload" | "choose" | "make" | null>(null);
  useEffect(() => {
    const target = refocus.current;
    if (!target) return;
    const element = {
      upload: uploadButtonRef,
      choose: chooseButtonRef,
      make: makeKitButtonRef,
    }[target].current;
    if (!element) return;
    refocus.current = null;
    if (!document.activeElement || document.activeElement === document.body)
      element.focus();
  });

  const searchParams = useSearchParams();
  const [view, setView] = useState<ProductsView>(() =>
    productsViewIn(searchParams)
  );
  // How many views this page opened on top of the shelf's own entry in the
  // browser's history: closing a view goes back that far, so Back after it
  // doesn't open it again.
  const depth = useRef(0);
  const closing = useRef(false);
  useEffect(() => {
    depth.current = depthOf(window.history.state);
    const onPop = () => {
      const next = productsViewIn(new URLSearchParams(window.location.search));
      if (closing.current) {
        closing.current = false;
        depth.current = 0;
        // The first entry was a view's own address, opened from a link.
        if (next.kind !== "shelf")
          window.history.replaceState(null, "", viewAddress(SHELF));
        setView(SHELF);
        return;
      }
      depth.current = depthOf(window.history.state);
      if (next.kind === "shelf") refocus.current = "upload";
      setView(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const viewRoot = useRef<HTMLDivElement>(null);
  const viewKey =
    view.kind === "review"
      ? `review:${view.importId}`
      : view.kind === "make"
        ? `make:${view.productIds.join(",")}`
        : view.kind === "ad-new"
          ? `ad-new:${view.productIds.join(",")}`
          : view.kind === "ad"
            ? `ad:${view.adId}`
            : "shelf";
  // A view opens at the top of the page, with the keyboard's focus in it;
  // the review takes the focus itself, for its keys. Back on the shelf, the
  // page is where the owner left it, with what they chose.
  const lastViewKey = useRef(viewKey);
  const pageRoot = useRef<HTMLElement>(null);
  const onShelf = useRef(view.kind === "shelf");
  const shelfScroll = useRef<number | null>(null);
  useEffect(() => {
    onShelf.current = view.kind === "shelf";
    if (lastViewKey.current === viewKey) return;
    lastViewKey.current = viewKey;
    const column = scrollColumnOf(pageRoot.current);
    if (view.kind === "shelf") {
      if (column && shelfScroll.current !== null)
        column.scrollTop = shelfScroll.current;
      shelfScroll.current = null;
      return;
    }
    if (column) column.scrollTop = 0;
    if (view.kind !== "review")
      viewRoot.current?.focus({ preventScroll: true });
  }, [viewKey, view.kind]);

  const openView = useCallback((next: ProductsView) => {
    // Where the shelf was, to come back to.
    if (onShelf.current)
      shelfScroll.current = scrollColumnOf(pageRoot.current)?.scrollTop ?? null;
    const level = depth.current + 1;
    window.history.pushState({ productsDepth: level }, "", viewAddress(next));
    depth.current = level;
    setView(next);
  }, []);
  const replaceView = useCallback((next: ProductsView) => {
    window.history.replaceState(
      { productsDepth: depth.current },
      "",
      viewAddress(next)
    );
    setView(next);
  }, []);
  /** Back to the shelf, from any view, however deep. */
  const closeView = useCallback(() => {
    const level = depth.current;
    depth.current = 0;
    if (level > 0) {
      closing.current = true;
      window.history.go(-level);
    } else {
      window.history.replaceState(null, "", viewAddress(SHELF));
    }
    setView(SHELF);
  }, []);

  const openReview = useCallback(
    (importId: string) => openView({ kind: "review", importId }),
    [openView]
  );
  const closeToShelf = () => {
    refocus.current = selection.choosing ? "make" : "upload";
    closeView();
  };
  // "Change" in what to make: the shelf's Choose mode, with these chosen.
  const chooseAgain = (productIds: string[]) => {
    refocus.current = "make";
    closeView();
    selection.start(productIds);
  };
  const makeAd = (productIds: string[]) => {
    const chosen = productIds.slice(0, AD_MAX_PRODUCTS);
    if (chosen.length > 0) openView({ kind: "ad-new", productIds: chosen });
  };
  const makeKit = (productIds: string[]) => {
    const chosen = productIds.slice(0, MAKE_MAX_PRODUCTS);
    if (chosen.length > 0) openView({ kind: "make", productIds: chosen });
  };
  const stopChoosing = () => {
    refocus.current = "choose";
    selection.stop();
  };

  // Escape closes the make and ad views, or leaves Choose mode; the review
  // has its own. Not while a field or an open popover takes it.
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.isComposing ||
      typedInField(event)
    )
      return;
    if (view.kind === "make" || view.kind === "ad-new" || view.kind === "ad") {
      event.preventDefault();
      closeToShelf();
    } else if (view.kind === "shelf" && selection.choosing) {
      event.preventDefault();
      stopChoosing();
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const onStarted = useCallback(
    (importId: string, preview: string) => {
      refocus.current = "upload";
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
    },
    [refreshImports]
  );
  const upload = useProductVideoUpload(workspaceId, onStarted);
  const uploading = upload.state.phase !== "idle";
  const sending = uploading && upload.state.phase !== "failed";

  const fileInput = useRef<HTMLInputElement>(null);
  const chooseVideo = () => fileInput.current?.click();
  const [dragging, setDragging] = useState(false);

  const stopUpload = () => {
    refocus.current = "upload";
    upload.cancel();
  };
  const dismissRow = (importId: string) => {
    refocus.current = "upload";
    setDismissed(current => new Set(current).add(importId));
  };

  const inView = view.kind !== "shelf";

  // The empty shelf has its own upload button; otherwise the page head's is
  // the one way to choose a video, once there is something to show beside
  // it. While a video is sent, the upload's card takes the buttons' place.
  const emptyShelf =
    data !== undefined &&
    products.length === 0 &&
    !uploading &&
    imports.length === 0;
  const pageButtons =
    !emptyShelf &&
    !sending &&
    (data !== undefined || uploading || imports.length > 0);
  // One video plays on the stage: an upload from this page, else the first
  // import running, else the first with products to check. Others are rows.
  const hero = uploading ? null : pickHero(imports);
  const rows = imports.filter(record => record !== hero);
  const videos = new Set(
    products.flatMap(product => (product.importId ? [product.importId] : []))
  ).size;

  // An import moving between the stage and the rows is drawn anew in its new
  // place, and the keyboard's focus in its old one would fall to the page:
  // it follows the import instead.
  const focusedImport = useRef<{ id: string; element: Element } | null>(null);
  const heroId = hero?.id ?? null;
  useEffect(() => {
    const focused = focusedImport.current;
    if (!focused || focused.element.isConnected) return;
    focusedImport.current = null;
    if (document.activeElement && document.activeElement !== document.body)
      return;
    Array.from(document.querySelectorAll<HTMLElement>("[data-import]"))
      .find(element => element.dataset.import === focused.id)
      ?.querySelector<HTMLElement>("button")
      ?.focus();
  }, [heroId]);

  const whatsappButton = (className: string) =>
    whatsappNumber ? (
      <WhatsAppLinkButton
        workspaceId={workspaceId}
        number={whatsappNumber}
        className={className}
      />
    ) : null;

  let shelf: ReactNode;
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
  } else if (products.length > 0 && !madeSettled) {
    shelf = <ProductShelfSkeleton />;
  } else if (products.length > 0) {
    shelf = (
      <div className="min-w-0">
        <ShelfHeading
          id={shelfId}
          title={PRODUCTS_COPY.yourShelf}
          count={products.length}
          note={selection.choosing ? PRODUCTS_COPY.choose.note : null}
          action={
            <Button
              ref={chooseButtonRef}
              variant={selection.choosing ? "outline" : "ghost"}
              size="sm"
              className="shrink-0"
              onClick={() =>
                selection.choosing ? stopChoosing() : selection.start()
              }
            >
              {selection.choosing ? (
                PRODUCTS_COPY.choose.done
              ) : (
                <>
                  <ListChecks aria-hidden="true" />
                  {PRODUCTS_COPY.choose.start}
                </>
              )}
            </Button>
          }
        />
        <ProductShelf
          products={products}
          labelledBy={shelfId}
          choose={
            selection.choosing
              ? { chosen: selection.chosen, onToggle: selection.toggle }
              : null
          }
        />
        {selection.choosing ? (
          <ProductChooseBar
            chosen={selection.chosenProducts}
            adReady={selection.adReady}
            makeKitRef={makeKitButtonRef}
            onClear={() => {
              refocus.current = "choose";
              selection.clear();
            }}
            onMakeAd={() => makeAd(selection.chosenIds)}
            onMakeKit={() => makeKit(selection.chosenIds)}
          />
        ) : null}
      </div>
    );
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
            ref={uploadButtonRef}
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
  }
  // While an upload or import is under way, the empty shelf says nothing.

  let content: ReactNode = null;
  if (view.kind === "review") {
    content = (
      <ProductReview
        key={view.importId}
        workspaceId={workspaceId}
        importId={view.importId}
        onClose={closeToShelf}
        onChangeProducts={chooseAgain}
        onMakeAd={makeAd}
      />
    );
  } else if (view.kind !== "shelf") {
    content = (
      <div
        ref={viewRoot}
        key={viewKey}
        tabIndex={-1}
        className={cn(theme.enter, "flex min-w-0 flex-col gap-6 outline-none")}
      >
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 self-start"
          onClick={closeToShelf}
        >
          <ArrowLeft aria-hidden="true" />
          {PRODUCTS_COPY.page.back}
        </Button>
        {view.kind === "make" ? (
          <MakeOutputs
            workspaceId={workspaceId}
            productIds={view.productIds}
            importId={null}
            onChangeProducts={chooseAgain}
            onMakeAd={makeAd}
          />
        ) : (
          <AdStudio
            workspaceId={workspaceId}
            view={
              view.kind === "ad"
                ? { kind: "ad", adId: view.adId }
                : { kind: "new", productIds: view.productIds }
            }
            // Only while the brief it was made from is still the view: an
            // owner who left it while the ad started stays where they went.
            onCreated={adId => {
              if (lastViewKey.current === viewKey)
                replaceView({ kind: "ad", adId });
            }}
            onChangeProducts={chooseAgain}
            onClose={closeToShelf}
          />
        )}
      </div>
    );
  }

  return (
    <section
      ref={pageRoot}
      className="relative flex min-w-0 flex-col gap-12 max-sm:gap-9"
      // A file dropped on the page is always caught: left to the browser, it
      // would open the file in place of the page, and stop an upload. During
      // an upload or a view, a drop does nothing.
      onDragEnter={event => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        if (!sending && !inView) setDragging(true);
      }}
      onDragOver={event => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = sending || inView ? "none" : "copy";
      }}
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={event => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file && !sending && !inView) upload.start(file);
      }}
      onFocusCapture={event => {
        const target = event.target as Element;
        const id = target.closest("[data-import]")?.getAttribute("data-import");
        focusedImport.current = id ? { id, element: target } : null;
      }}
      onBlurCapture={event => {
        if (event.relatedTarget) return;
        // Focus left for nothing: a click away from any control, which
        // forgets it, or its element going with the import's old place.
        const left = event.target as Element;
        queueMicrotask(() => {
          if (left.isConnected && focusedImport.current?.element === left)
            focusedImport.current = null;
        });
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
      {inView ? (
        <>
          {/* The page's title stays for assistive tech while a view shows. */}
          <h1 className="sr-only">{PRODUCTS_COPY.title}</h1>
          {content}
        </>
      ) : (
        <>
          <header className="flex items-end justify-between gap-6 max-sm:flex-col max-sm:items-stretch max-sm:gap-4">
            <div className="flex min-w-0 flex-col">
              <h1 className={theme.displayXl}>{PRODUCTS_COPY.title}</h1>
              {data && products.length > 0 ? (
                <p className="mt-1 text-[15px] leading-[22px] text-(--p-ink-2) tabular-nums">
                  {PRODUCTS_COPY.page.onShelf(products.length, videos)}
                </p>
              ) : null}
              {/* The section is new: judges and owners see so, under the title. */}
              <p className="mt-1.5 text-[13px] leading-[18px] text-(--p-ink-2)">
                {PRODUCTS_COPY.hackathonNote}
              </p>
            </div>
            {pageButtons ? (
              // On a phone the pair shares the column's width.
              <div className="flex shrink-0 gap-2 max-sm:grid max-sm:auto-cols-fr max-sm:grid-flow-col">
                {whatsappButton(
                  "h-9 px-4 text-sm max-sm:h-10 max-sm:gap-1.5 max-sm:px-2 max-sm:text-[13px]"
                )}
                <Button
                  ref={uploadButtonRef}
                  variant="outline"
                  className="max-sm:h-10 max-sm:gap-1.5 max-sm:px-2 max-sm:text-[13px]"
                  onClick={chooseVideo}
                >
                  <Upload aria-hidden="true" />
                  {PRODUCTS_COPY.uploadVideo}
                </Button>
              </div>
            ) : null}
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
          {rows.length > 0 ? (
            <ul
              aria-label={PRODUCTS_COPY.stage.otherVideos}
              className="flex flex-col gap-6"
            >
              {rows.map(record => (
                <li key={record.id}>
                  <ImportProgress
                    workspaceId={workspaceId}
                    record={record}
                    preview={previews[record.id] ?? null}
                    variant="row"
                    onReview={openReview}
                    // Another video, as the page's upload buttons choose
                    // one; not while one is being sent.
                    onUploadAgain={sending ? undefined : chooseVideo}
                    onDismiss={dismissRow}
                  />
                </li>
              ))}
            </ul>
          ) : null}
          {/* Things are made from the shelf: until it holds something, there
              is nothing to list, nor to ask for. */}
          {products.length > 0 ? (
            <MadeList
              workspaceId={workspaceId}
              onOpenAd={adId => openView({ kind: "ad", adId })}
              onMakeAd={makeAd}
            />
          ) : null}
          {shelf}
        </>
      )}
      <div
        aria-hidden="true"
        className={cn(
          // Inside the page's narrowest side margin (16 px), so it never
          // makes the page scroll sideways; above the stage, which has its
          // own layers.
          "pointer-events-none absolute -inset-2 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-(--p-line-strong) bg-[color-mix(in_oklab,var(--p-paper)_85%,transparent)] text-[15px] font-medium text-(--p-ink) transition-opacity duration-200",
          dragging ? "opacity-100" : "opacity-0"
        )}
      >
        {PRODUCTS_COPY.dropVideo}
      </div>
    </section>
  );
}

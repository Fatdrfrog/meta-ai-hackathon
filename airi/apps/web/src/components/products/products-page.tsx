"use client";

import { Button } from "@/components/ui/button";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import type {
  ProductsListResponse,
  WorkspaceProductRecord,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import { Upload } from "lucide-react";
import { useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import useSWR from "swr";
import { ProductReview } from "./product-review";
import {
  EmptyShelf,
  ProductShelf,
  ProductShelfSkeleton,
  ShelfHeading,
} from "./product-shelf";
import { pickHero } from "./product-stage-model";
import { ImportProgress, UploadProgress } from "./product-video-intake";
import { WhatsAppLinkButton } from "./product-whatsapp-link";
import { fetchProducts, productsApiUrl } from "./products-client";
import { useProductImports } from "./use-product-imports";
import { useProductVideoUpload } from "./use-product-video-upload";

const EMPTY_PRODUCTS: WorkspaceProductRecord[] = [];

const carriesFiles = (event: DragEvent) =>
  Array.from(event.dataTransfer.types).includes("Files");

// The review of an import's products has its own address, ?review=<import>,
// so a link (from WhatsApp, later) opens it and Back closes it.
const REVIEW_PARAM = "review";
const reviewIn = (search: URLSearchParams | null) => {
  const importId = search?.get(REVIEW_PARAM) ?? null;
  return importId && /^[a-f\d]{24}$/i.test(importId) ? importId : null;
};

function reviewAddress(importId: string | null): string {
  const url = new URL(window.location.href);
  if (importId) url.searchParams.set(REVIEW_PARAM, importId);
  else url.searchParams.delete(REVIEW_PARAM);
  return url.toString();
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
  const shelfId = useId();

  const { imports, refresh: refreshImports } = useProductImports(workspaceId);
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
  // When an upload's row goes, by cancelling or by its import starting, or
  // the review closes, the focus it held goes back to the upload button.
  const uploadButtonRef = useRef<HTMLButtonElement>(null);
  const refocusUpload = useRef(false);
  useEffect(() => {
    if (!refocusUpload.current || !uploadButtonRef.current) return;
    refocusUpload.current = false;
    if (!document.activeElement || document.activeElement === document.body)
      uploadButtonRef.current.focus();
  });

  const searchParams = useSearchParams();
  const [reviewing, setReviewing] = useState(() => reviewIn(searchParams));
  // Whether this page added the review to the history, so closing goes back.
  const pushedReview = useRef(false);
  useEffect(() => {
    const onPop = () => {
      pushedReview.current = false;
      refocusUpload.current = true;
      setReviewing(reviewIn(new URLSearchParams(window.location.search)));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const openReview = useCallback((importId: string) => {
    window.history.pushState(null, "", reviewAddress(importId));
    pushedReview.current = true;
    setReviewing(importId);
  }, []);
  const closeReview = () => {
    refocusUpload.current = true;
    if (pushedReview.current) {
      pushedReview.current = false;
      window.history.back();
    } else {
      window.history.replaceState(null, "", reviewAddress(null));
    }
    setReviewing(null);
  };
  const onStarted = useCallback(
    (importId: string, preview: string) => {
      refocusUpload.current = true;
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
    refocusUpload.current = true;
    upload.cancel();
  };

  const uploadButton = (variant: "default" | "outline") => (
    <Button
      ref={uploadButtonRef}
      variant={variant}
      size="sm"
      onClick={chooseVideo}
    >
      <Upload aria-hidden="true" />
      {PRODUCTS_COPY.uploadVideo}
    </Button>
  );

  // The empty shelf has its own upload button; otherwise the page's is the
  // one way to choose a video, once there is something to show beside it.
  const emptyShelf =
    data !== undefined &&
    products.length === 0 &&
    !uploading &&
    imports.length === 0;
  const pageButtons =
    !emptyShelf && (data !== undefined || uploading || imports.length > 0);
  // One video plays on the stage: an upload from this page, else the first
  // import running, else the first with products to check. Others are rows.
  const hero = uploading ? null : pickHero(imports);
  const rows = imports.filter(record => record !== hero);

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

  let shelf: ReactNode;
  if (!data) {
    shelf =
      error && !isValidating ? (
        <EmptyShelf lit={false}>
          <p role="alert" className="text-[15px] font-medium">
            {PRODUCTS_COPY.loadError}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void mutate()}
          >
            {PRODUCTS_COPY.retry}
          </Button>
        </EmptyShelf>
      ) : (
        <div role="status" aria-label={PRODUCTS_COPY.loading}>
          <ProductShelfSkeleton />
        </div>
      );
  } else if (products.length > 0) {
    shelf = (
      <div className="min-w-0">
        <ShelfHeading id={shelfId} title={PRODUCTS_COPY.yourShelf} />
        <ProductShelf products={products} labelledBy={shelfId} />
      </div>
    );
  } else if (emptyShelf) {
    shelf = (
      <EmptyShelf>
        <p className="text-[15px] font-medium">{PRODUCTS_COPY.emptyTitle}</p>
        <p className="max-w-sm text-sm text-balance text-foreground/65">
          {PRODUCTS_COPY.emptyDescription}
        </p>
        <div className="mt-3 flex flex-col items-center gap-1.5">
          <div className="flex flex-wrap justify-center gap-2">
            {uploadButton("default")}
            {whatsappNumber ? (
              <WhatsAppLinkButton
                workspaceId={workspaceId}
                number={whatsappNumber}
              />
            ) : null}
          </div>
          <p className="text-xs text-foreground/60">
            {PRODUCTS_COPY.uploadHint}
          </p>
        </div>
      </EmptyShelf>
    );
  }
  // While an upload or import is under way, the empty shelf says nothing.

  return (
    <section
      className="relative flex min-w-0 flex-col gap-14"
      // A file dropped on the page is always caught: left to the browser, it
      // would open the file in place of the page, and stop an upload. During
      // an upload or the review, a drop does nothing.
      onDragEnter={event => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        if (!sending && !reviewing) setDragging(true);
      }}
      onDragOver={event => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = sending || reviewing ? "none" : "copy";
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
        if (file && !sending && !reviewing) upload.start(file);
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
      <h1 className="sr-only">{PRODUCTS_COPY.title}</h1>
      {reviewing ? (
        <ProductReview
          key={reviewing}
          workspaceId={workspaceId}
          importId={reviewing}
          onClose={closeReview}
        />
      ) : null}
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
      {reviewing ? null : (
        <>
          {pageButtons ? (
            // Kept in place, out of reach, while a video is sent: the stage
            // below doesn't jump when the upload ends. On a phone the pair
            // fills the column.
            <div
              inert={sending}
              aria-hidden={sending || undefined}
              className={cn(
                "-mb-6 flex flex-wrap justify-end gap-2 max-sm:*:flex-auto",
                sending && "invisible"
              )}
            >
              {whatsappNumber ? (
                <WhatsAppLinkButton
                  workspaceId={workspaceId}
                  number={whatsappNumber}
                />
              ) : null}
              {uploadButton("outline")}
            </div>
          ) : null}
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
                  />
                </li>
              ))}
            </ul>
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
          "pointer-events-none absolute -inset-2 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-foreground/25 bg-background/85 text-[15px] font-medium transition-opacity",
          dragging ? "opacity-100" : "opacity-0"
        )}
      >
        {PRODUCTS_COPY.dropVideo}
      </div>
    </section>
  );
}

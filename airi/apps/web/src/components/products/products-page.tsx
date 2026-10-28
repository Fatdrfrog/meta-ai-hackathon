"use client";

import { Button } from "@/components/ui/button";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import type {
  ProductsListResponse,
  WorkspaceProductRecord,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import { Upload } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import useSWR from "swr";
import {
  EmptyShelf,
  ProductShelf,
  ProductShelfSkeleton,
} from "./product-shelf";
import { ImportProgress, UploadProgress } from "./product-video-intake";
import { fetchProducts, productsApiUrl } from "./products-client";
import { useProductImports } from "./use-product-imports";
import { useProductVideoUpload } from "./use-product-video-upload";

const EMPTY_PRODUCTS: WorkspaceProductRecord[] = [];

const carriesFiles = (event: DragEvent) =>
  Array.from(event.dataTransfer.types).includes("Files");

/** Products: the workspace's own catalog, which the owner fills by filming their shelf. */
export function ProductsPage({ workspaceId }: { workspaceId: string }) {
  const { data, error, isValidating, mutate } = useSWR<ProductsListResponse>(
    productsApiUrl(workspaceId),
    fetchProducts,
    // Photos come as signed links that change on every list; refetching on
    // focus would download every photo again.
    { shouldRetryOnError: false, revalidateOnFocus: false }
  );
  const products = data?.products ?? EMPTY_PRODUCTS;

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
  // When an upload's row goes, by cancelling or by its import starting, the
  // focus it held goes back to the upload button.
  const uploadButtonRef = useRef<HTMLButtonElement>(null);
  const refocusUpload = useRef(false);
  useEffect(() => {
    if (!refocusUpload.current || !uploadButtonRef.current) return;
    refocusUpload.current = false;
    if (!document.activeElement || document.activeElement === document.body)
      uploadButtonRef.current.focus();
  });
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
  const pageButton =
    !sending &&
    !emptyShelf &&
    (data !== undefined || uploading || imports.length > 0);

  let shelf: ReactNode;
  if (!data) {
    shelf =
      error && !isValidating ? (
        <EmptyShelf>
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
    shelf = <ProductShelf products={products} />;
  } else if (emptyShelf) {
    shelf = (
      <EmptyShelf>
        <p className="text-[15px] font-medium">{PRODUCTS_COPY.emptyTitle}</p>
        <p className="max-w-sm text-sm text-balance text-muted-foreground">
          {PRODUCTS_COPY.emptyDescription}
        </p>
        <div className="mt-3 flex flex-col items-center gap-1.5">
          {uploadButton("default")}
          <p className="text-xs text-muted-foreground">
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
      // would open the file in place of the page, and stop an upload.
      onDragEnter={event => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        if (!sending) setDragging(true);
      }}
      onDragOver={event => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = sending ? "none" : "copy";
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
        if (file && !sending) upload.start(file);
      }}
    >
      <h1 className="sr-only">{PRODUCTS_COPY.title}</h1>
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
      {pageButton ? (
        <div className="-mb-6 flex justify-end">{uploadButton("outline")}</div>
      ) : null}
      {upload.state.phase !== "idle" ? (
        <UploadProgress
          state={upload.state}
          onCancel={stopUpload}
          onRetry={upload.retry}
        />
      ) : null}
      {imports.map(record => (
        <ImportProgress
          key={record.id}
          workspaceId={workspaceId}
          record={record}
          preview={previews[record.id] ?? null}
        />
      ))}
      {shelf}
      <div
        aria-hidden="true"
        className={cn(
          // Inside the page's narrowest side margin (16 px), so it never
          // makes the page scroll sideways.
          "pointer-events-none absolute -inset-2 flex items-center justify-center rounded-2xl border-2 border-dashed border-foreground/25 bg-background/85 text-[15px] font-medium transition-opacity",
          dragging ? "opacity-100" : "opacity-0"
        )}
      >
        {PRODUCTS_COPY.dropVideo}
      </div>
    </section>
  );
}

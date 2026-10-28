"use client";

import type {
  DraftProductRecord,
  ProductChanges,
  ProductVideoImportResponse,
  WorkspaceProductStatus,
} from "@/lib/products/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import {
  fetchProductImport,
  productImportsUrl,
  productImportUrl,
  productsApiUrl,
  reviewProducts,
  updateProduct,
} from "./products-client";

/** A decision the owner can undo: these products were added to the shelf, or skipped. */
export type ReviewMove = { ids: string[]; to: "published" | "rejected" };

const NO_PRODUCTS: DraftProductRecord[] = [];

/** A product with the owner's changes that may not be saved yet. */
function withLocalChanges(
  product: DraftProductRecord,
  status: WorkspaceProductStatus | undefined,
  edit: ProductChanges | undefined
): DraftProductRecord {
  if (!status && !edit) return product;
  const featured = edit?.featuredOption;
  return {
    ...product,
    ...(status ? { status } : {}),
    ...(edit?.name !== undefined ? { name: edit.name } : {}),
    // Setting the price settles the doubts about it.
    ...(edit?.price !== undefined
      ? {
          price: edit.price,
          doubts: product.doubts.filter(doubt => doubt.about !== "price"),
        }
      : {}),
    ...(featured !== undefined
      ? {
          featuredOption: featured,
          imageUrl: product.options[featured]?.imageUrl ?? null,
        }
      : {}),
  };
}

/**
 * One import's products as the owner checks them. Decisions and edits show
 * at once and are saved behind, decisions one after another so the server
 * sees them in the owner's order. They stay over what the server says while
 * the review is open, so a refresh landing mid-save doesn't take one back on
 * screen. A change that can't be saved is undone, and `failed` says so.
 */
export function useProductReview(workspaceId: string, importId: string) {
  const { data, error, isValidating, mutate } =
    useSWR<ProductVideoImportResponse>(
      productImportUrl(workspaceId, importId),
      fetchProductImport,
      { revalidateOnFocus: false, shouldRetryOnError: false }
    );
  const { mutate: mutateKey } = useSWRConfig();
  const [statuses, setStatuses] = useState<
    Record<string, WorkspaceProductStatus>
  >({});
  const [edits, setEdits] = useState<Record<string, ProductChanges>>({});
  const editsRef = useRef(edits);
  useEffect(() => {
    editsRef.current = edits;
  }, [edits]);
  const [moves, setMoves] = useState<ReviewMove[]>([]);
  const [failed, setFailed] = useState(false);
  const saving = useRef<Promise<unknown>>(Promise.resolve());

  const products = useMemo(
    () =>
      (data?.products ?? NO_PRODUCTS).map(product =>
        withLocalChanges(product, statuses[product.id], edits[product.id])
      ),
    [data, statuses, edits]
  );
  const queue = useMemo(
    () => products.filter(product => product.status === "draft"),
    [products]
  );

  const setStatus = (ids: string[], status: WorkspaceProductStatus) =>
    setStatuses(current => ({
      ...current,
      ...Object.fromEntries(ids.map(id => [id, status])),
    }));

  const save = useCallback(
    (ids: string[], status: WorkspaceProductStatus) => {
      const saved = saving.current.then(() =>
        reviewProducts(workspaceId, importId, ids, status)
      );
      saving.current = saved.catch(() => undefined);
      return saved.then(() => {
        // The page behind shows what was saved: the shelf, and the imports
        // with products left to check.
        void mutateKey(productsApiUrl(workspaceId));
        void mutateKey(productImportsUrl(workspaceId));
      });
    },
    [workspaceId, importId, mutateKey]
  );

  const decide = useCallback(
    (ids: string[], to: ReviewMove["to"]) => {
      if (ids.length === 0) return;
      const move: ReviewMove = { ids, to };
      setFailed(false);
      setStatus(ids, to);
      setMoves(current => [...current, move]);
      save(ids, to).catch(() => {
        setStatus(ids, "draft");
        setMoves(current => current.filter(entry => entry !== move));
        setFailed(true);
      });
    },
    [save]
  );

  const lastMove = moves.at(-1) ?? null;
  const undo = useCallback(() => {
    if (!lastMove) return;
    setFailed(false);
    setMoves(current => current.filter(entry => entry !== lastMove));
    setStatus(lastMove.ids, "draft");
    save(lastMove.ids, "draft").catch(() => {
      setStatus(lastMove.ids, lastMove.to);
      setMoves(current => [...current, lastMove]);
      setFailed(true);
    });
  }, [lastMove, save]);

  const edit = useCallback(
    (productId: string, changes: ProductChanges) => {
      const before = editsRef.current[productId];
      setFailed(false);
      setEdits(current => ({
        ...current,
        [productId]: { ...current[productId], ...changes },
      }));
      updateProduct(workspaceId, productId, changes).catch(() => {
        setEdits(current => {
          const next = { ...current };
          if (before) next[productId] = before;
          else delete next[productId];
          return next;
        });
        setFailed(true);
      });
    },
    [workspaceId]
  );

  return {
    products,
    /** Products left to check, in the order they were filmed. */
    queue,
    loading: data === undefined && (error === undefined || isValidating),
    loadFailed: data === undefined && error !== undefined && !isValidating,
    reload: () => void mutate(),
    decide,
    undo,
    lastMove,
    edit,
    failed,
  };
}

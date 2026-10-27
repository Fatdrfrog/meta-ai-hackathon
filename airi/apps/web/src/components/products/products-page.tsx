"use client";

import { Button } from "@/components/ui/button";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import type {
  ProductsListResponse,
  WorkspaceProductRecord,
} from "@/lib/products/types";
import type { ReactNode } from "react";
import useSWR from "swr";
import {
  EmptyShelf,
  ProductShelf,
  ProductShelfSkeleton,
} from "./product-shelf";
import { fetchProducts, productsApiUrl } from "./products-client";

const EMPTY_PRODUCTS: WorkspaceProductRecord[] = [];

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

  let body: ReactNode;
  if (!data) {
    body =
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
  } else if (products.length === 0) {
    body = (
      <EmptyShelf>
        <p className="text-[15px] font-medium">{PRODUCTS_COPY.emptyTitle}</p>
        <p className="max-w-sm text-sm text-balance text-muted-foreground">
          {PRODUCTS_COPY.emptyDescription}
        </p>
      </EmptyShelf>
    );
  } else {
    body = <ProductShelf products={products} />;
  }

  return (
    <section className="min-w-0">
      <h1 className="sr-only">{PRODUCTS_COPY.title}</h1>
      {body}
    </section>
  );
}

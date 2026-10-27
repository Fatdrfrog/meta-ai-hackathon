"use client";

import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "@/components/ui/async-states";
import { PageHeader } from "@/components/ui/page-header";
import { PRODUCTS_COPY, productCountLabel } from "@/lib/products/copy";
import {
  formatProductPrice,
  type ProductsListResponse,
  type WorkspaceProductRecord,
} from "@/lib/products/types";
import { Package } from "lucide-react";
import type { ReactNode } from "react";
import useSWR from "swr";
import { fetchProducts, productsApiUrl } from "./products-client";

const EMPTY_PRODUCTS: WorkspaceProductRecord[] = [];

/** Products: the workspace's own catalog, which the owner fills by filming their shelf. */
export function ProductsPage({ workspaceId }: { workspaceId: string }) {
  const { data, error, isValidating, mutate } = useSWR<ProductsListResponse>(
    productsApiUrl(workspaceId),
    fetchProducts,
    { shouldRetryOnError: false }
  );
  const products = data?.products ?? EMPTY_PRODUCTS;

  let body: ReactNode;
  if (!data) {
    body =
      error && !isValidating ? (
        <ErrorState
          message={PRODUCTS_COPY.loadError}
          onRetry={() => void mutate()}
          retryLabel={PRODUCTS_COPY.retry}
        />
      ) : (
        <div role="status" aria-label={PRODUCTS_COPY.loading}>
          <LoadingState lines={4} />
        </div>
      );
  } else if (products.length === 0) {
    body = (
      <EmptyState
        title={PRODUCTS_COPY.emptyTitle}
        description={PRODUCTS_COPY.emptyDescription}
      />
    );
  } else {
    body = (
      <div className="min-w-0 space-y-3">
        <p className="text-sm text-muted-foreground">
          {productCountLabel(products.length)}
        </p>
        <ul
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
          aria-label={PRODUCTS_COPY.title}
        >
          {products.map(product => (
            <li
              key={product.id}
              className="flex min-w-0 flex-col gap-2 rounded-lg border p-3"
            >
              <div className="flex aspect-square items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Package aria-hidden="true" className="size-8" />
              </div>
              <p
                className="line-clamp-2 font-medium break-words"
                title={product.name}
              >
                {product.name}
              </p>
              <p className="text-sm text-muted-foreground tabular-nums">
                {product.price === null
                  ? PRODUCTS_COPY.noPrice
                  : formatProductPrice(product.price)}
              </p>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title={PRODUCTS_COPY.title}
        description={PRODUCTS_COPY.description}
      />
      {body}
    </div>
  );
}

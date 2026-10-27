"use client";

import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "@/components/ui/async-states";
import { PageHeader } from "@/components/ui/page-header";
import {
  formatProductPrice,
  type ProductsListResponse,
  type WorkspaceProductRecord,
} from "@/lib/products/types";
import { Package } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import useSWR from "swr";
import { fetchProducts, productsApiUrl } from "./products-client";

const EMPTY_PRODUCTS: WorkspaceProductRecord[] = [];

/** Products: the workspace's own catalog, which the owner fills by filming their shelf. */
export function ProductsPage({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("ProductsPage");
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
          message={t("loadError")}
          onRetry={() => void mutate()}
          retryLabel={t("retry")}
        />
      ) : (
        <div role="status" aria-label={t("loading")}>
          <LoadingState lines={4} />
        </div>
      );
  } else if (products.length === 0) {
    body = (
      <EmptyState
        title={t("empty.title")}
        description={t("empty.description")}
      />
    );
  } else {
    body = (
      <div className="min-w-0 space-y-3">
        <p className="text-sm text-muted-foreground">
          {t("count", { count: products.length })}
        </p>
        <ul
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
          aria-label={t("title")}
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
                  ? t("noPrice")
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
      <PageHeader title={t("title")} description={t("description")} />
      {body}
    </div>
  );
}

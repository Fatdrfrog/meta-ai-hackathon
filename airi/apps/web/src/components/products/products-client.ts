import type { ProductsListResponse } from "@/lib/products/types";

// Requests the Products page makes.

/** The Products API of one workspace. */
export function productsApiUrl(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/products`;
}

export async function fetchProducts(
  url: string
): Promise<ProductsListResponse> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as ProductsListResponse | null;
  if (!Array.isArray(data?.products)) throw new Error("Unexpected response");
  return data;
}

import type {
  ProductsAccessResponse,
  ProductsListResponse,
} from "@/lib/products/types";

// Requests the Products page and its menu entry make.

/** The Products API of one workspace. */
export function productsApiUrl(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/products`;
}

export function productsAccessUrl(workspaceId: string): string {
  return `${productsApiUrl(workspaceId)}/access`;
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

/** Whether this user sees Products; any failure hides it. */
export async function fetchProductsAccess(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return false;
    const data = (await response.json()) as Partial<ProductsAccessResponse>;
    return data?.available === true;
  } catch {
    return false;
  }
}

import "server-only";
import { WorkspaceProduct } from "@/models/workspace-product";
import { MAX_LISTED_PRODUCTS, type WorkspaceProductRecord } from "./types";

function toIsoOrNull(value: unknown): string | null {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString()
    : null;
}

/** The workspace's published products, in shelf order, as the Products page lists them. */
export async function listPublishedProducts(
  workspaceId: string
): Promise<WorkspaceProductRecord[]> {
  const rows = await WorkspaceProduct.find({ workspaceId, status: "published" })
    .sort({ position: 1, _id: 1 })
    .limit(MAX_LISTED_PRODUCTS)
    .select("name price updatedAt")
    .lean<Record<string, unknown>[]>();
  return rows.map(row => ({
    id: String(row._id),
    name: typeof row.name === "string" ? row.name : "",
    price:
      typeof row.price === "number" && Number.isFinite(row.price)
        ? row.price
        : null,
    // Products get photos from the video import, which doesn't store them yet.
    imageUrl: null,
    updatedAt: toIsoOrNull(row.updatedAt),
  }));
}

import mongoose from "mongoose";
import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import { loadProductVideoImport } from "@/lib/products/imports";
import type { ProductVideoImportResponse } from "@/lib/products/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string; importId: string }> };

/** An import's progress and the products it found so far, drafts included. */
export async function GET(_request: Request, { params }: Context) {
  const { workspaceId, importId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    if (!mongoose.isValidObjectId(importId))
      return productsFail("import_not_found", 404);
    await connectDB();
    const found = await loadProductVideoImport(workspaceId, importId);
    if (!found) return productsFail("import_not_found", 404);
    return productsJson(found satisfies ProductVideoImportResponse);
  } catch (error) {
    logger.error("[Products API] import GET failed", error, {
      event: "products.import_load_failed",
      workspaceId,
      importId,
    });
    return productsFail("load_failed", 503);
  }
}

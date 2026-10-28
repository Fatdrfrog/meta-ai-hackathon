import mongoose from "mongoose";
import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import type { ProductCarouselDraftResponse } from "@/lib/products/types";
import {
  loadAddedProducts,
  prepareCarouselDraft,
} from "@/lib/products/whatsapp-drafts";
import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";
import { StorageQuotaError } from "@icecore/airi-runtime/storage-quota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Context = { params: Promise<{ workspaceId: string; importId: string }> };

/**
 * Makes the cards of a WhatsApp carousel from the products an import added
 * to the shelf (their pictures stored as template header samples), for the
 * page to open in the template editor. Needs a connected WhatsApp number,
 * which the template is made on.
 */
export async function POST(_request: Request, { params }: Context) {
  const { workspaceId, importId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    if (!mongoose.isValidObjectId(importId))
      return productsFail("import_not_found", 404);
    await connectDB();
    const added = await loadAddedProducts(workspaceId, importId);
    if (!added) return productsFail("import_not_found", 404);
    const whatsapp = await getWhatsAppWorkspaceContext(workspaceId, {
      requireManager: true,
    });
    if (whatsapp.error) return productsFail("whatsapp_not_connected", 409);
    const draft = await prepareCarouselDraft(workspaceId, added);
    if (!draft) return productsFail("not_enough_products", 409);
    return productsJson({ draft } satisfies ProductCarouselDraftResponse);
  } catch (error) {
    if (error instanceof StorageQuotaError)
      return productsFail("storage_full", 409);
    logger.error("[Products API] carousel POST failed", error, {
      event: "products.carousel_draft_failed",
      workspaceId,
      importId,
    });
    return productsFail("draft_failed", 503);
  }
}

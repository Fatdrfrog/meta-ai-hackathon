import mongoose from "mongoose";
import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import type { ProductOrderFormResponse } from "@/lib/products/types";
import {
  createOrderFormDraft,
  loadAddedProducts,
} from "@/lib/products/whatsapp-drafts";
import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Context = { params: Promise<{ workspaceId: string; importId: string }> };

/**
 * Saves an order form for the products an import added to the shelf on the
 * workspace's WhatsApp Business Account, as a draft Flow the owner checks
 * and publishes in WhatsApp Flows.
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
    if (added.products.length === 0)
      return productsFail("not_enough_products", 409);
    const whatsapp = await getWhatsAppWorkspaceContext(workspaceId, {
      requireManager: true,
    });
    const { accessToken, wabaId } = whatsapp.context ?? {};
    if (!accessToken || !wabaId)
      return productsFail("whatsapp_not_connected", 409);
    const created = await createOrderFormDraft({
      accessToken,
      wabaId,
      products: added.products,
      language: added.language,
    });
    if (!created.ok) {
      logger.error("[Products API] order form refused", undefined, {
        event: "products.order_form_refused",
        workspaceId,
        importId,
        reason: created.error,
      });
      return productsFail("draft_failed", 502);
    }
    return productsJson(
      {
        flow: { id: created.flowId, name: created.name },
        leftOut: created.leftOut,
      } satisfies ProductOrderFormResponse,
      201
    );
  } catch (error) {
    logger.error("[Products API] order form POST failed", error, {
      event: "products.order_form_failed",
      workspaceId,
      importId,
    });
    return productsFail("draft_failed", 503);
  }
}

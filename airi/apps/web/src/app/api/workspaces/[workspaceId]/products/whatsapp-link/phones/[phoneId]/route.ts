import mongoose from "mongoose";
import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import type { ProductsWhatsAppLinkResponse } from "@/lib/products/types";
import {
  loadProductsWhatsAppLink,
  unlinkProductsWhatsAppPhone,
} from "@/lib/products/whatsapp-intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string; phoneId: string }> };

/**
 * Unlinks one of the workspace's phones: the videos it sends to Airi stop
 * turning into products here. Answers with the panel; 404 for a phone this
 * workspace hasn't linked.
 */
export async function DELETE(_request: Request, { params }: Context) {
  const { workspaceId, phoneId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    if (!mongoose.isValidObjectId(phoneId))
      return productsFail("whatsapp_link_not_found", 404);
    await connectDB();
    if (!(await unlinkProductsWhatsAppPhone(workspaceId, phoneId)))
      return productsFail("whatsapp_link_not_found", 404);
    logger.info("[Products API] WhatsApp phone unlinked", {
      event: "products.whatsapp_phone_unlinked",
      workspaceId,
      phoneId,
      userId: access.userId,
    });
    const panel = await loadProductsWhatsAppLink(workspaceId);
    if (!panel) return productsFail("whatsapp_intake_unavailable", 404);
    return productsJson(panel satisfies ProductsWhatsAppLinkResponse);
  } catch (error) {
    logger.error("[Products API] WhatsApp phone DELETE failed", error, {
      event: "products.whatsapp_unlink_failed",
      workspaceId,
      phoneId,
    });
    return productsFail("save_failed", 503);
  }
}

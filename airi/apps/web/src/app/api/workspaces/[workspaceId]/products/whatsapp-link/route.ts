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
  openProductsWhatsAppPairing,
} from "@/lib/products/whatsapp-intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

/**
 * The "Send from WhatsApp" panel: the link to open WhatsApp with, the phones
 * asking to be linked and the phones linked. The open panel asks every few
 * seconds, so a phone's ask shows up while the owner holds it.
 */
export async function GET(_request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    await connectDB();
    const panel = await loadProductsWhatsAppLink(workspaceId);
    if (!panel) return productsFail("whatsapp_intake_unavailable", 404);
    return productsJson(panel satisfies ProductsWhatsAppLinkResponse);
  } catch (error) {
    logger.error("[Products API] WhatsApp link GET failed", error, {
      event: "products.whatsapp_link_load_failed",
      workspaceId,
    });
    return productsFail("load_failed", 503);
  }
}

/**
 * Opens the shop to phones asking to be linked, for 15 minutes, or keeps it
 * open longer: the panel does this as it opens. Answers with the panel; 409
 * while another workspace with Products has the same name, which a phone's
 * message couldn't tell apart.
 */
export async function POST(_request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    await connectDB();
    const panel = await openProductsWhatsAppPairing(workspaceId, access.userId);
    if (!panel) return productsFail("whatsapp_intake_unavailable", 404);
    if (panel === "shop_name_taken") {
      logger.info("[Products API] WhatsApp shop name taken", {
        event: "products.whatsapp_shop_name_taken",
        workspaceId,
        userId: access.userId,
      });
      return productsFail("whatsapp_link_shop_name_taken", 409);
    }
    return productsJson(panel satisfies ProductsWhatsAppLinkResponse, 201);
  } catch (error) {
    logger.error("[Products API] WhatsApp link POST failed", error, {
      event: "products.whatsapp_link_failed",
      workspaceId,
    });
    return productsFail("save_failed", 503);
  }
}

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
  approveProductsWhatsAppRequest,
  denyProductsWhatsAppRequest,
  loadProductsWhatsAppLink,
} from "@/lib/products/whatsapp-intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string; requestId: string }> };

/**
 * Links the phone that asked: the admin says it's theirs. Airi tells the
 * owner on WhatsApp. Answers with the panel; 404 for an ask that isn't this
 * workspace's or has expired; 409 for a phone another workspace has, which
 * stays there.
 */
export async function POST(_request: Request, { params }: Context) {
  const { workspaceId, requestId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    if (!mongoose.isValidObjectId(requestId))
      return productsFail("whatsapp_link_not_found", 404);
    await connectDB();
    const approval = await approveProductsWhatsAppRequest(
      workspaceId,
      requestId,
      access.userId
    );
    if (approval === "gone")
      return productsFail("whatsapp_link_not_found", 404);
    if (approval === "linked_elsewhere") {
      logger.info("[Products API] WhatsApp phone linked elsewhere", {
        event: "products.whatsapp_phone_linked_elsewhere",
        workspaceId,
        requestId,
        userId: access.userId,
      });
      return productsFail("whatsapp_link_linked_elsewhere", 409);
    }
    logger.info("[Products API] WhatsApp phone linked", {
      event: "products.whatsapp_phone_linked",
      workspaceId,
      requestId,
      userId: access.userId,
    });
    const panel = await loadProductsWhatsAppLink(workspaceId);
    if (!panel) return productsFail("whatsapp_intake_unavailable", 404);
    return productsJson(panel satisfies ProductsWhatsAppLinkResponse);
  } catch (error) {
    logger.error("[Products API] WhatsApp link request POST failed", error, {
      event: "products.whatsapp_link_approve_failed",
      workspaceId,
      requestId,
    });
    return productsFail("save_failed", 503);
  }
}

/** Forgets the ask: it isn't the admin's phone. Airi doesn't write to it. */
export async function DELETE(_request: Request, { params }: Context) {
  const { workspaceId, requestId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    if (!mongoose.isValidObjectId(requestId))
      return productsFail("whatsapp_link_not_found", 404);
    await connectDB();
    if (!(await denyProductsWhatsAppRequest(workspaceId, requestId)))
      return productsFail("whatsapp_link_not_found", 404);
    logger.info("[Products API] WhatsApp link request denied", {
      event: "products.whatsapp_link_request_denied",
      workspaceId,
      requestId,
      userId: access.userId,
    });
    const panel = await loadProductsWhatsAppLink(workspaceId);
    if (!panel) return productsFail("whatsapp_intake_unavailable", 404);
    return productsJson(panel satisfies ProductsWhatsAppLinkResponse);
  } catch (error) {
    logger.error("[Products API] WhatsApp link request DELETE failed", error, {
      event: "products.whatsapp_link_deny_failed",
      workspaceId,
      requestId,
    });
    return productsFail("save_failed", 503);
  }
}

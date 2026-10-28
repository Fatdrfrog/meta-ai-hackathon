import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import type { ProductsWhatsAppLinkResponse } from "@/lib/products/types";
import { createProductsWhatsAppLink } from "@/lib/products/whatsapp-intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

/**
 * A one-time link that opens WhatsApp to airi's own number with a code the
 * owner sends, which links their phone to this workspace for shelf videos.
 */
export async function POST(_request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    await connectDB();
    const link = await createProductsWhatsAppLink(workspaceId, access.userId);
    if (!link) return productsFail("whatsapp_intake_unavailable", 404);
    return productsJson(link satisfies ProductsWhatsAppLinkResponse, 201);
  } catch (error) {
    logger.error("[Products API] WhatsApp link POST failed", error, {
      event: "products.whatsapp_link_failed",
      workspaceId,
    });
    return productsFail("save_failed", 503);
  }
}

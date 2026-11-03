import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { listProductAdRecords } from "@/lib/products/ads";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import {
  listProductKitRecords,
  productsWhatsAppConnection,
} from "@/lib/products/kits";
import type { ProductsMadeResponse } from "@/lib/products/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Newest first, this many kits and this many ads. */
const MADE_LIMIT = 20;

type Context = { params: Promise<{ workspaceId: string }> };

/**
 * What the owner made from the shelf, for "Made from your shelf": the
 * newest kits (with Meta's status) and video ads, and the WhatsApp number
 * they're made on. Ads or the number failing to load leave the kits shown.
 */
export async function GET(_request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    await connectDB();
    const [kits, ads, whatsapp] = await Promise.all([
      listProductKitRecords(workspaceId, MADE_LIMIT),
      listProductAdRecords(workspaceId, MADE_LIMIT).catch(error => {
        logger.error("[Products API] made ads failed", error, {
          event: "products.made_ads_failed",
          workspaceId,
        });
        return [];
      }),
      productsWhatsAppConnection(workspaceId).catch(error => {
        logger.error("[Products API] made WhatsApp failed", error, {
          event: "products.made_whatsapp_failed",
          workspaceId,
        });
        return { connected: false, displayPhone: null };
      }),
    ]);
    return productsJson({ kits, ads, whatsapp } satisfies ProductsMadeResponse);
  } catch (error) {
    logger.error("[Products API] made GET failed", error, {
      event: "products.made_failed",
      workspaceId,
    });
    return productsFail("load_failed", 503);
  }
}

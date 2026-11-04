import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { isAdObjectId } from "@/lib/products/ad-request";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import { createCtwa, loadCtwa, parseCtwaRequest } from "@/lib/products/ctwa";
import type { ProductAdCtwaResponse } from "@/lib/products/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A poll spends up to ~7 s at Meta, a press up to ~6 s: room past a short default.
export const maxDuration = 30;

type Context = { params: Promise<{ workspaceId: string; adId: string }> };

/**
 * The ad's Click-to-WhatsApp ad, advanced first: each ask makes the next
 * steps Meta allows within one request (the page asks every 3 s while it's
 * made), and reads Meta's review once it's paused or running. `{ctwa: null}`
 * when none was asked for.
 */
export async function GET(_request: Request, { params }: Context) {
  const { workspaceId, adId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    if (!isAdObjectId(adId)) return productsFail("ad_not_found", 404);
    await connectDB();
    const result = await loadCtwa({ workspaceId, adId: adId.toLowerCase() });
    if ("refused" in result) return productsFail(result.refused, result.status);
    return productsJson({ ctwa: result.ctwa } satisfies ProductAdCtwaResponse);
  } catch (error) {
    logger.error("[Products API] ctwa GET failed", error, {
      event: "products.ctwa_load_failed",
      workspaceId,
      adId,
    });
    return productsFail("load_failed", 503);
  }
}

/**
 * "Create ad": the Click-to-WhatsApp campaign, ad set, creative and ad, all
 * PAUSED (nothing spent, nothing reviewed). 202 with the ad being made; a
 * repeated press, or an ad already made from this video, answers 200 as it
 * is. 409 before anything is stored: ads_not_connected,
 * page_whatsapp_missing, price_to_check, ad_not_ready, budget_refused (an
 * account not in US dollars). Once stored, Meta's refusals land on the ad.
 */
export async function POST(request: Request, { params }: Context) {
  const { workspaceId, adId } = await params;
  const body: unknown = await request.json().catch(() => null);
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    if (!isAdObjectId(adId)) return productsFail("ad_not_found", 404);
    const ctwaRequest = parseCtwaRequest(body);
    if (!ctwaRequest) return productsFail("invalid_request", 400);
    await connectDB();
    const result = await createCtwa({
      workspaceId,
      adId: adId.toLowerCase(),
      request: ctwaRequest,
    });
    if ("refused" in result) {
      logger.warn("[Products API] ctwa refused", {
        event: "products.ctwa_refused",
        workspaceId,
        adId,
        code: result.refused,
      });
      return productsFail(
        result.refused,
        result.status,
        result.issues?.length ? { issues: result.issues.slice(0, 3) } : {}
      );
    }
    return productsJson(
      { ctwa: result.ctwa } satisfies ProductAdCtwaResponse,
      result.started ? 202 : 200
    );
  } catch (error) {
    logger.error("[Products API] ctwa POST failed", error, {
      event: "products.ctwa_create_failed",
      workspaceId,
      adId,
    });
    return productsFail("ctwa_failed", 503);
  }
}

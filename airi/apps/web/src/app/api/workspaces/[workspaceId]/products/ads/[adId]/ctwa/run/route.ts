import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { isAdObjectId } from "@/lib/products/ad-request";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import { parseCtwaRunRequest, runCtwa } from "@/lib/products/ctwa";
import type { ProductAdCtwaResponse } from "@/lib/products/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Up to ~13 s: the switches (~7 s), a wait for a poll's lease and the
// pause-again on a refusal. Never cut off halfway through switching on.
export const maxDuration = 30;

type Context = { params: Promise<{ workspaceId: string; adId: string }> };

/**
 * "Run", after its confirm: the paused Click-to-WhatsApp ad gets its daily
 * budget and end, and is switched on; Meta reviews it before it runs. The
 * server caps both whatever is sent: 409 run_disabled unless
 * PRODUCTS_CTWA_RUN_ENABLED=1, 409 budget_refused above
 * PRODUCTS_CTWA_RUN_MAX_DAILY_CENTS (100) or PRODUCTS_CTWA_RUN_MAX_DAYS (3).
 * A running ad answers as it is. Meta's refusal lands on the ad, still
 * paused.
 */
export async function POST(request: Request, { params }: Context) {
  const { workspaceId, adId } = await params;
  const body: unknown = await request.json().catch(() => null);
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    if (!isAdObjectId(adId)) return productsFail("ad_not_found", 404);
    const runRequest = parseCtwaRunRequest(body);
    if (!runRequest) return productsFail("invalid_request", 400);
    await connectDB();
    const result = await runCtwa({
      workspaceId,
      adId: adId.toLowerCase(),
      request: runRequest,
    });
    if ("refused" in result) {
      logger.warn("[Products API] ctwa run refused", {
        event: "products.ctwa_run_refused",
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
    logger.info("[Products API] ctwa run", {
      event: "products.ctwa_run",
      workspaceId,
      adId,
      state: result.ctwa.state,
      dailyBudgetCents: result.ctwa.dailyBudgetCents,
      errorCode: result.ctwa.errorCode,
    });
    return productsJson({ ctwa: result.ctwa } satisfies ProductAdCtwaResponse);
  } catch (error) {
    logger.error("[Products API] ctwa run failed", error, {
      event: "products.ctwa_run_failed",
      workspaceId,
      adId,
    });
    return productsFail("ctwa_failed", 503);
  }
}

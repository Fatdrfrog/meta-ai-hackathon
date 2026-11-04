import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import {
  isObjectIdText,
  parseProductIds,
  parseProductKitRequest,
} from "@/lib/products/kit-request";
import { makeProductKit, readProductKitPlan } from "@/lib/products/kits";
import type {
  ProductKitPlanResponse,
  ProductKitResponse,
} from "@/lib/products/types";
import { StorageQuotaError } from "@icecore/airi-runtime/storage-quota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Both parts are made inside the request: usually 10–30 s.
export const maxDuration = 60;

type Context = { params: Promise<{ workspaceId: string }> };

/**
 * What the make view needs before the press, for the products in
 * `?products=<id>,<id>…` (and `&importId=` after a review): the products as
 * buyers will read them, the buyers' language, whether WhatsApp is
 * connected, and the kit last made from that review.
 */
export async function GET(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    const query = new URL(request.url).searchParams;
    const productIds = parseProductIds(
      (query.get("products") ?? "").split(",").filter(Boolean)
    );
    const importId = query.get("importId") || null;
    if (!productIds || (importId !== null && !isObjectIdText(importId)))
      return productsFail("invalid_request", 400);
    await connectDB();
    return productsJson(
      (await readProductKitPlan({
        workspaceId,
        productIds,
        importId: importId?.toLowerCase() ?? null,
      })) satisfies ProductKitPlanResponse
    );
  } catch (error) {
    logger.error("[Products API] kit plan GET failed", error, {
      event: "products.kit_plan_failed",
      workspaceId,
    });
    return productsFail("load_failed", 503);
  }
}

/**
 * Makes a kit: the carousel (sent to Meta for review) and the order form
 * (published), whichever were asked for, at once, from the owner's edits
 * when the press carries them. Answers 201 with the kit once both have
 * settled, or 200 with the kit an earlier send of the same press made.
 * Nothing is made without products on the shelf and a connected WhatsApp
 * number; edits that fail their checks are a 400 with the first 3 issues,
 * and an edited carousel's name Meta or this kit has is a 409
 * template_name_taken.
 */
export async function POST(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    const kitRequest = parseProductKitRequest(
      await request.json().catch(() => null)
    );
    if (!kitRequest) return productsFail("invalid_request", 400);
    await connectDB();
    const outcome = await makeProductKit({
      workspaceId,
      userId: access.userId,
      request: kitRequest,
    });
    if ("invalid" in outcome)
      return productsFail("invalid_request", 400, {
        issues: outcome.invalid.slice(0, 3),
      });
    if ("refused" in outcome)
      // Meta couldn't say whether it has the owner's name: try again.
      return outcome.refused === "meta_unavailable"
        ? productsFail("draft_failed", 503)
        : productsFail(outcome.refused, 409);
    return productsJson(
      { kit: outcome.kit } satisfies ProductKitResponse,
      outcome.repeated ? 200 : 201
    );
  } catch (error) {
    // The edited cards' pictures from Assets couldn't be kept.
    if (error instanceof StorageQuotaError)
      return productsFail("storage_full", 409);
    logger.error("[Products API] kit POST failed", error, {
      event: "products.kit_failed",
      workspaceId,
    });
    return productsFail("draft_failed", 503);
  }
}

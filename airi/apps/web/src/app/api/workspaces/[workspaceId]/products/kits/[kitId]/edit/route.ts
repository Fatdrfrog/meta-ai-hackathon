import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import {
  isProductKitPart,
  parseProductKitEditRequest,
} from "@/lib/products/kit-request";
import { editProductKitPart, productKitEditSource } from "@/lib/products/kits";
import type {
  ProductKitEditSourceResponse,
  ProductKitResponse,
} from "@/lib/products/types";
import { StorageQuotaError } from "@icecore/airi-runtime/storage-quota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The part goes to Meta inside the request, as the kit made it.
export const maxDuration = 60;

type Context = { params: Promise<{ workspaceId: string; kitId: string }> };

/**
 * What "Edit and send again" / "Edit order form" opens with
 * (?part=carousel|orderForm): the part as it was sent, the carousel under a
 * new name for this kit. Kits from before v2 are made again from the shelf.
 */
export async function GET(request: Request, { params }: Context) {
  const { workspaceId, kitId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    const part = new URL(request.url).searchParams.get("part");
    if (!isProductKitPart(part)) return productsFail("invalid_request", 400);
    await connectDB();
    const source = await productKitEditSource({ workspaceId, kitId, part });
    if (!source) return productsFail("kit_not_found", 404);
    if ("refused" in source)
      return source.refused === "invalid_request"
        ? productsFail("invalid_request", 400)
        : productsFail(source.refused, 409);
    return productsJson(source satisfies ProductKitEditSourceResponse);
  } catch (error) {
    if (error instanceof StorageQuotaError)
      return productsFail("storage_full", 409);
    logger.error("[Products API] kit edit source failed", error, {
      event: "products.kit_edit_source_failed",
      workspaceId,
      kitId,
    });
    return productsFail("load_failed", 503);
  }
}

/**
 * Sends one made part again with the owner's edits ({requestId, part,
 * name + components | config}): the carousel as a new template, the order
 * form as a new version (or in place, for a draft). Answers 200 with the
 * kit once the part has settled; the same requestId again answers with the
 * kit as it is. 409 kit_part_busy while the part is made or looked for at
 * Meta; 409 carousel_found (with the kit) when a carousel whose answer was
 * lost turned up at Meta, so the edits weren't sent; 409
 * template_name_taken; 409 meta_refused (Meta's words in `issues`, the kit,
 * which keeps what it held); 400 with the first 3 issues.
 */
export async function POST(request: Request, { params }: Context) {
  const { workspaceId, kitId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    const edit = parseProductKitEditRequest(
      await request.json().catch(() => null)
    );
    if (!edit) return productsFail("invalid_request", 400);
    await connectDB();
    const outcome = await editProductKitPart({
      workspaceId,
      userId: access.userId,
      kitId,
      request: edit,
    });
    if (!outcome) return productsFail("kit_not_found", 404);
    if ("invalid" in outcome)
      return productsFail("invalid_request", 400, {
        issues: outcome.invalid.slice(0, 3),
      });
    if ("carouselFound" in outcome)
      return productsFail("carousel_found", 409, {
        kit: outcome.carouselFound,
      });
    if ("metaRefused" in outcome)
      return productsFail("meta_refused", 409, {
        issues: outcome.metaRefused.words ? [outcome.metaRefused.words] : [],
        kit: outcome.metaRefused.kit,
      });
    if ("refused" in outcome) {
      const { refused } = outcome;
      if (refused === "invalid_request")
        return productsFail("invalid_request", 400);
      // Meta couldn't say whether it has the carousel or the name: try again.
      if (refused === "meta_unavailable")
        return productsFail("draft_failed", 503);
      // With the kit when the refusal changed it (a carousel now looked for).
      return productsFail(
        refused,
        409,
        outcome.kit ? { kit: outcome.kit } : {}
      );
    }
    return productsJson({ kit: outcome.kit } satisfies ProductKitResponse);
  } catch (error) {
    // The edited cards' pictures from Assets couldn't be kept.
    if (error instanceof StorageQuotaError)
      return productsFail("storage_full", 409);
    logger.error("[Products API] kit edit failed", error, {
      event: "products.kit_edit_failed",
      workspaceId,
      kitId,
    });
    return productsFail("draft_failed", 503);
  }
}

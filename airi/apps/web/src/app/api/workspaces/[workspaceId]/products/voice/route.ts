import { getWorkspaceAiRequiredDetails } from "@/lib/ai/workspace-ai-errors";
import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import { productImportSpend } from "@/lib/products/import-spend";
import type { ProductVoiceResponse } from "@/lib/products/types";
import {
  parseProductVoiceCreateRequest,
  parseProductVoiceSourceQuery,
} from "@/lib/products/voice-request";
import {
  createProductVoice,
  loadProductVoice,
  productVoiceSource,
  removeProductVoice,
} from "@/lib/products/voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

/**
 * The workspace's cloned voice: pending, ready, or failed with why; null for
 * none. With ?productIds=a,b, also the video a copy would be made from for
 * those products (`source`), for the consent to name; 400 for bad ids.
 */
export async function GET(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    const productIds = parseProductVoiceSourceQuery(
      new URL(request.url).searchParams.get("productIds")
    );
    if (productIds === null) return productsFail("invalid_request", 400);
    await connectDB();
    const [voice, source] = await Promise.all([
      loadProductVoice(workspaceId),
      productIds ? productVoiceSource(workspaceId, productIds) : undefined,
    ]);
    return productsJson({
      voice,
      ...(productIds ? { source: source ?? null } : {}),
    } satisfies ProductVoiceResponse);
  } catch (error) {
    logger.error("[Products API] voice GET failed", error, {
      event: "products.voice_load_failed",
      workspaceId,
    });
    return productsFail("load_failed", 503);
  }
}

/**
 * Clone the owner's voice from a video's narration, only with the consent
 * tick (400 voice_consent_required without it): 201 with the pending voice
 * (made in the first ad read in it), or a failed one when the video has too
 * little speech; 200 with the workspace's voice when it has one. 404 when
 * no video of the workspace's is there; 409 ai_disabled, nothing saved, for
 * a company that turned AI off; 503 when voices aren't set up.
 */
export async function POST(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    const parsed = parseProductVoiceCreateRequest(
      await request.json().catch(() => null)
    );
    if (parsed === "missing_consent")
      return productsFail("voice_consent_required", 400);
    if (!parsed) return productsFail("invalid_request", 400);
    try {
      await productImportSpend.assertAiEnabled(workspaceId);
    } catch (error) {
      if (
        getWorkspaceAiRequiredDetails(error)?.code === "workspace_ai_disabled"
      )
        return productsFail("ai_disabled", 409);
      throw error;
    }
    await connectDB();
    const result = await createProductVoice({
      workspaceId,
      userId: access.userId,
      request: parsed,
    });
    if ("refused" in result)
      return productsFail(
        result.refused,
        result.refused === "import_not_found" ? 404 : 503
      );
    return productsJson(
      { voice: result.voice } satisfies ProductVoiceResponse,
      result.created ? 201 : 200
    );
  } catch (error) {
    logger.error("[Products API] voice POST failed", error, {
      event: "products.voice_create_failed",
      workspaceId,
    });
    return productsFail("save_failed", 503);
  }
}

/**
 * "Remove my voice": deleted at ElevenLabs, then gone from the workspace;
 * answers `{voice: null}` either way. 503 voice_unavailable when ElevenLabs
 * couldn't delete it: nothing changed, and the owner can try again. Never
 * gated on the company's AI switch: deleting the clone honours an opt-out.
 */
export async function DELETE(_request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    await connectDB();
    const result = await removeProductVoice({ workspaceId });
    if ("refused" in result) return productsFail(result.refused, 503);
    return productsJson({ voice: null } satisfies ProductVoiceResponse);
  } catch (error) {
    logger.error("[Products API] voice DELETE failed", error, {
      event: "products.voice_remove_failed",
      workspaceId,
    });
    return productsFail("save_failed", 503);
  }
}

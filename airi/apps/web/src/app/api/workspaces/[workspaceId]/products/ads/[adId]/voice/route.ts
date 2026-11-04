import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { isAdObjectId } from "@/lib/products/ad-request";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import type { ProductAdResponse } from "@/lib/products/types";
import { parseProductAdVoiceRequest } from "@/lib/products/voice-request";
import { changeProductAdVoice } from "@/lib/products/voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Context = { params: Promise<{ workspaceId: string; adId: string }> };

/**
 * The finished ad read in another voice: 202 with the ad, a "voice" run
 * started that pays only for new words; 200 as it is when nothing changes,
 * or for a press repeated while its run goes. 409 ad_not_ready unless it's
 * ready with a video, voice_not_found for "Your voice, new words" without a
 * cloned voice, and the AI admission codes for new words the workspace
 * can't pay for now.
 */
export async function POST(request: Request, { params }: Context) {
  const { workspaceId, adId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    if (!isAdObjectId(adId)) return productsFail("ad_not_found", 404);
    const parsed = parseProductAdVoiceRequest(
      await request.json().catch(() => null)
    );
    if (!parsed) return productsFail("invalid_request", 400);
    await connectDB();
    const result = await changeProductAdVoice({
      workspaceId,
      adId: adId.toLowerCase(),
      request: parsed,
    });
    if ("refused" in result)
      return productsFail(
        result.refused,
        result.refused === "ad_not_found" ? 404 : 409
      );
    return productsJson(
      { ad: result.ad } satisfies ProductAdResponse,
      result.started ? 202 : 200
    );
  } catch (error) {
    logger.error("[Products API] ad voice change failed", error, {
      event: "products.ad_voice_failed",
      workspaceId,
      adId,
    });
    return productsFail("ad_unavailable", 503);
  }
}

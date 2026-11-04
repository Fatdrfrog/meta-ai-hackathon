import { getWorkspaceAiRequiredDetails } from "@/lib/ai/workspace-ai-errors";
import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { productsFail, requireProductsAdmin } from "@/lib/products/api";
import { parseVoiceSampleLanguage } from "@/lib/products/voice-request";
import { productVoiceSampleAudio } from "@/lib/products/voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Context = { params: Promise<{ workspaceId: string; voiceId: string }> };

/**
 * One Airi voice's sample in `?language=kk|ru|en`, as audio: kept from
 * before, or made now (a few seconds) and kept for everyone. 404 for a
 * voice that isn't one of airi's; 403 ai_disabled when one would be made for
 * a company that turned AI off; 503 when it can't be made now.
 */
export async function GET(request: Request, { params }: Context) {
  const { workspaceId, voiceId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    const language = parseVoiceSampleLanguage(
      new URL(request.url).searchParams.get("language")
    );
    if (!language) return productsFail("invalid_request", 400);
    await connectDB();
    const sample = await productVoiceSampleAudio(
      workspaceId,
      voiceId,
      language
    );
    if (!sample) return productsFail("voice_not_found", 404);
    return new Response(new Uint8Array(sample.audio), {
      status: 200,
      headers: {
        "Content-Type": sample.mimeType,
        "Content-Length": String(sample.audio.length),
        // The same voice and language always say the same: keep it a day.
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch (error) {
    if (getWorkspaceAiRequiredDetails(error)?.code === "workspace_ai_disabled")
      return productsFail("ai_disabled", 403);
    logger.error("[Products API] voice sample failed", error, {
      event: "products.voice_sample_failed",
      workspaceId,
      voiceId,
    });
    return productsFail("voice_unavailable", 503);
  }
}

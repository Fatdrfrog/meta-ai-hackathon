import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import { parseVoiceSampleLanguage } from "@/lib/products/voice-request";
import { productVoiceSamples } from "@/lib/products/voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

/**
 * airi's voices for an ad in `?language=kk|ru|en` (English without one),
 * each with the link to its sample in that language.
 */
export async function GET(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  const access = await requireProductsAdmin(workspaceId);
  if ("response" in access) return access.response;
  const language = parseVoiceSampleLanguage(
    new URL(request.url).searchParams.get("language")
  );
  if (!language) return productsFail("invalid_request", 400);
  return productsJson(productVoiceSamples(workspaceId, language));
}

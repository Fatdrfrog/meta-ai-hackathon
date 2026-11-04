import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import { sendProductKitFormTest } from "@/lib/products/kit-form-test";
import type { ProductKitSendTestResponse } from "@/lib/products/types";
import { createClient } from "@/lib/supabase/server";
import {
  readWhatsAppTestPhone,
  WHATSAPP_TEST_SEND_HOURLY_LIMIT,
} from "@/lib/whatsapp/test-send";
import {
  checkRateLimit,
  createRateLimiter,
} from "@icecore/shared/lib/rate-limiter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Context = { params: Promise<{ workspaceId: string; kitId: string }> };

// Test sends skip any campaign limits, so they're capped per user, as the
// campaigns' own Test send is.
const formTestLimiter = createRateLimiter({
  requests: WHATSAPP_TEST_SEND_HOURLY_LIMIT,
  window: "1 h",
  prefix: "products:form-test",
});

/**
 * "Send me the order form" ({part: "orderForm"}): the kit's published form
 * to the signed-in owner's own test phone, the one a campaign's Test send
 * saved. 409 test_phone_missing without one; 429 rate_limited; 409
 * kit_part_busy while the form is made, invalid_request when it isn't
 * published; Meta's refusals of the phone as test_phone_is_shop (131021),
 * test_phone_unreachable (131026) and test_phone_not_allowed (131030).
 */
export async function POST(request: Request, { params }: Context) {
  const { workspaceId, kitId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    const body = (await request.json().catch(() => null)) as {
      part?: unknown;
    } | null;
    if (body?.part !== "orderForm") return productsFail("invalid_request", 400);

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const to = readWhatsAppTestPhone(user?.user_metadata);
    if (!to) return productsFail("test_phone_missing", 409);

    try {
      const limit = await checkRateLimit(
        formTestLimiter,
        access.userId,
        WHATSAPP_TEST_SEND_HOURLY_LIMIT
      );
      if (!limit.success) return productsFail("rate_limited", 429);
    } catch {
      // A limiter outage must not block the owner's own test.
    }

    await connectDB();
    const outcome = await sendProductKitFormTest({ workspaceId, kitId, to });
    if (!outcome) return productsFail("kit_not_found", 404);
    if ("refused" in outcome)
      return outcome.refused === "invalid_request"
        ? productsFail("invalid_request", 409)
        : productsFail(outcome.refused, 409);
    return productsJson({ sent: true } satisfies ProductKitSendTestResponse);
  } catch (error) {
    logger.error("[Products API] kit form test send failed", error, {
      event: "products.kit_form_test_failed",
      workspaceId,
      kitId,
    });
    return productsFail("draft_failed", 503);
  }
}

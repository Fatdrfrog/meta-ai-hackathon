import { NextRequest } from "next/server";
import { z } from "zod";
import {
  readJsonBodyWithinLimit,
  InvalidJsonBodyError,
  JsonBodyTooLargeError,
} from "@/lib/api/json-body";
import {
  fetchWidgetSourceByClientKey,
  resolveAuthorizedWidgetSource,
  type AuthorizedWidgetSourceResult,
} from "@/lib/widget/source-context";
import { handleCorsOptions, jsonWithCors } from "@/lib/widget/cors";
import {
  createRateLimiter,
  checkRateLimit,
} from "@icecore/shared/lib/rate-limiter";
import {
  COMMERCE_TRACKING_MAX_EVENTS_PER_REQUEST,
  normalizeCommerceTrackingEvent,
} from "@icecore/shared/types/commerce-tracking";
import {
  issueCartSession,
  readCartSession,
} from "@/lib/commerce/browser-session";
import {
  createCartHandoff,
  recordBrowserCartEvent,
  listWebsiteCarts,
} from "@/lib/commerce/carts";
import { WebsiteCartError } from "@/lib/commerce/cart-state";
import {
  resolveWebsiteCommerceContext,
  WebsiteCommerceIntegrationError,
} from "@/lib/commerce/integrations";

const limiter = createRateLimiter({
  requests: 120,
  window: "1 m",
  prefix: "website-cart",
});
const sourceLimiter = createRateLimiter({
  requests: 3000,
  window: "1 m",
  prefix: "website-cart-source",
});
const base = {
  clientKey: z.string().min(1).max(200),
  sessionToken: z.string().max(2048),
};
const schema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("carts") }).strict(),
  z
    .object({
      ...base,
      sessionToken: base.sessionToken.optional(),
      action: z.literal("session"),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("events"),
      events: z
        .array(z.unknown())
        .min(1)
        .max(COMMERCE_TRACKING_MAX_EVENTS_PER_REQUEST),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("handoff"),
      cartId: z.string().min(1).max(200),
      consent: z.literal(true),
      locale: z.string().max(10).optional(),
    })
    .strict(),
]);
export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request);
}
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const reply = (data: unknown, status = 200) =>
    jsonWithCors(data, {
      origin,
      status,
      headers: { "Cache-Control": "no-store" },
    });
  try {
    const parsed = schema.safeParse(
      await readJsonBodyWithinLimit(request, 64 * 1024)
    );
    if (!parsed.success) return reply({ error: "Invalid cart request" }, 400);
    const body = parsed.data;
    let auth: AuthorizedWidgetSourceResult;
    // Sandboxed pixels can continue a storefront-issued capability; they cannot mint one.
    if (body.action === "events" && (!origin || origin === "null")) {
      const source = await fetchWidgetSourceByClientKey(body.clientKey);
      if (
        !source ||
        source.credentials.status !== "active" ||
        !(await readCartSession(body.sessionToken, source.id))
      )
        return reply({ error: "Cart session unavailable" }, 401);
      auth = { ok: true, source, credentials: source.credentials, origin };
    } else
      auth = await resolveAuthorizedWidgetSource({
        request,
        clientKey: body.clientKey,
      });
    if (!auth.ok) return reply({ error: auth.error }, auth.status);
    const sourceBudget = await checkRateLimit(
      sourceLimiter,
      auth.source.id,
      3000
    );
    if (!sourceBudget.success)
      return reply({ error: "Cart tracking temporarily rate limited" }, 429);
    const owner = body.sessionToken
      ? await readCartSession(body.sessionToken, auth.source.id)
      : null;
    const caller =
      owner ||
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      "anonymous";
    if (
      !(await checkRateLimit(limiter, `${auth.source.id}:${caller}`, 120))
        .success
    )
      return reply({ error: "Too many cart requests" }, 429);
    // The widget source's configured WhatsApp mapping is always resolved on the server.
    let context;
    try {
      context = await resolveWebsiteCommerceContext(auth.source.id);
    } catch (error) {
      if (
        body.action === "session" &&
        error instanceof WebsiteCommerceIntegrationError &&
        (error.code === "commerce_disabled" ||
          error.code === "whatsapp_unavailable")
      )
        return reply({ enabled: false, sessionToken: "" });
      throw error;
    }
    if (body.action === "session")
      return reply({
        enabled: true,
        sessionToken: await issueCartSession(auth.source.id, body.sessionToken),
      });
    if (!owner) return reply({ error: "Cart session expired" }, 401);
    if (body.action === "carts")
      return reply({
        carts: await listWebsiteCarts({
          workspaceId: auth.source.workspace_id,
          widgetSourceId: auth.source.id,
          ownerSessionId: owner,
          whatsappSourceId: context.whatsappSource.id,
        }),
      });
    if (body.action === "handoff")
      return reply({
        url: await createCartHandoff({
          widgetSourceId: auth.source.id,
          ownerSessionId: owner,
          cartId: body.cartId,
          locale: body.locale,
        }),
      });
    // Validate the entire batch before any writes; retries keep each immutable event ID.
    let events;
    try {
      events = body.events.map(event => normalizeCommerceTrackingEvent(event));
    } catch {
      return reply({ error: "Invalid cart events" }, 400);
    }
    const carts = [];
    for (const event of events)
      carts.push(
        await recordBrowserCartEvent({
          workspaceId: auth.source.workspace_id,
          widgetSourceId: auth.source.id,
          whatsappSourceId: context.whatsappSource.id,
          ownerSessionId: owner,
          allowedDomains: auth.credentials.allowed_domains,
          event,
        })
      );
    return reply({ carts });
  } catch (error) {
    const status =
      error instanceof WebsiteCartError ||
      error instanceof WebsiteCommerceIntegrationError
        ? error.status
        : error instanceof JsonBodyTooLargeError
          ? 413
          : error instanceof InvalidJsonBodyError
            ? 400
            : 503;
    return reply(
      {
        error:
          error instanceof WebsiteCartError
            ? error.message
            : "Cart tracking unavailable",
      },
      status
    );
  }
}

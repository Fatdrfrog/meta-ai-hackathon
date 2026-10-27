import {
  InvalidJsonBodyError,
  JsonBodyTooLargeError,
  readJsonBodyWithinLimit,
} from "@/lib/api/json-body";
import { getPublicTemplate } from "@/lib/landing/public-template-catalog";
import {
  getPublicTemplateReadiness,
  assertPublicTemplateReadinessRequestAllowed,
  assertPublicTemplateSubmissionRequestAllowed,
  PublicTemplateDeliveryError,
  requestPublicTemplate,
} from "@/lib/landing/template-delivery.server";
import {
  publicTemplateLocaleSchema,
  publicTemplateRequestBodySchema,
} from "@/lib/landing/template-request";
import { getIpRateLimitIdentity } from "@icecore/shared/lib/network-safety";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 4096;

function errorResponse(code: string, status: number, retryAfter?: number) {
  return NextResponse.json(
    { code },
    {
      status,
      headers: {
        ...NO_STORE,
        ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
      },
    }
  );
}

function getRequesterIp(request: Request): string {
  // This header is overwritten by Vercel. Other hosts share a bounded bucket
  // rather than accepting a visitor's arbitrary forwarding headers.
  return getIpRateLimitIdentity(
    process.env.VERCEL === "1"
      ? request.headers.get("x-vercel-forwarded-for")
      : null
  );
}

export async function GET(request: Request) {
  const locale = publicTemplateLocaleSchema.safeParse(
    new URL(request.url).searchParams.get("locale") || "en"
  );
  if (!locale.success) return errorResponse("invalid_request", 400);
  try {
    await assertPublicTemplateReadinessRequestAllowed(getRequesterIp(request));
    return NextResponse.json(await getPublicTemplateReadiness(locale.data), {
      headers: NO_STORE,
    });
  } catch (error) {
    if (error instanceof PublicTemplateDeliveryError)
      return errorResponse(error.code, error.status, error.retryAfter);
    return errorResponse("unavailable", 503);
  }
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (
      (origin && origin !== new URL(request.url).origin) ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      return errorResponse("invalid_request", 400);
    const requesterIp = getRequesterIp(request);
    await assertPublicTemplateSubmissionRequestAllowed(requesterIp);
    if (
      request.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    )
      return errorResponse("invalid_request", 400);
    const parsed = publicTemplateRequestBodySchema.safeParse(
      await readJsonBodyWithinLimit(request, MAX_BODY_BYTES)
    );
    if (!parsed.success || !getPublicTemplate(parsed.data.templateId))
      return errorResponse("invalid_request", 400);
    if (parsed.data.website)
      return NextResponse.json({ status: "accepted" }, { headers: NO_STORE });
    const result = await requestPublicTemplate(parsed.data, requesterIp);
    return NextResponse.json(result, {
      status: result.status === "processing" ? 202 : 200,
      headers: NO_STORE,
    });
  } catch (error) {
    if (
      error instanceof InvalidJsonBodyError ||
      error instanceof JsonBodyTooLargeError
    )
      return errorResponse("invalid_request", 400);
    if (error instanceof PublicTemplateDeliveryError)
      return errorResponse(error.code, error.status, error.retryAfter);
    return errorResponse("unknown", 503);
  }
}

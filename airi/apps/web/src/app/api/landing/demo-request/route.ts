import { demoRequestBodySchema } from "@/lib/landing/demo-request";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  checkRateLimit,
  createRateLimiter,
} from "@icecore/shared/lib/rate-limiter";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEMO_REQUEST_RATE_LIMIT = 5;
const demoRequestLimiter = createRateLimiter({
  requests: DEMO_REQUEST_RATE_LIMIT,
  window: "10 m",
  prefix: "landing:demo-request",
});

function getRequesterIp(request: Request): string {
  const forwardedIp = (
    request.headers.get("x-vercel-forwarded-for") ||
    request.headers.get("x-forwarded-for")
  )
    ?.split(",", 1)[0]
    ?.trim();
  const directIp = request.headers.get("x-real-ip")?.trim();
  return (forwardedIp || directIp || "unknown").slice(0, 128);
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.json().catch(() => null);
    const parsed = demoRequestBodySchema.safeParse(rawBody);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "A valid work email is required" },
        { status: 400 }
      );
    }

    if (parsed.data.website) {
      return NextResponse.json({ ok: true });
    }

    if (!demoRequestLimiter) {
      return NextResponse.json(
        { error: "Something went wrong. Please try again." },
        { status: 503 }
      );
    }

    let rateLimit;
    try {
      rateLimit = await checkRateLimit(
        demoRequestLimiter,
        getRequesterIp(request),
        DEMO_REQUEST_RATE_LIMIT
      );
    } catch {
      return NextResponse.json(
        { error: "Something went wrong. Please try again." },
        { status: 503 }
      );
    }

    if (!rateLimit.success) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((rateLimit.reset - Date.now()) / 1_000)
      );
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfterSeconds),
            "X-RateLimit-Limit": String(rateLimit.limit),
            "X-RateLimit-Remaining": String(rateLimit.remaining),
          },
        }
      );
    }

    const email = parsed.data.email.toLowerCase();

    const { error } = await supabaseAdmin.from("demo_requests").upsert(
      {
        email,
        source: "landing_hero",
        created_at: new Date().toISOString(),
      },
      { onConflict: "email" }
    );

    if (error) {
      console.error("[landing/demo-request] Insert failed:", error.message);
      return NextResponse.json(
        { error: "Something went wrong. Please try again." },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

// Equal-length digests let timingSafeEqual compare without leaking the length.
function matchesSecret(candidate: string, secret: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(candidate), digest(secret));
}

/**
 * Verify a cron request carries a valid `Authorization: Bearer <CRON_SECRET>` header.
 * Missing credentials are allowed only in explicit local/test runtimes.
 *
 * Returns `null` when the request is authorized, or a 401 `NextResponse`
 * that the caller should return immediately.
 */
export function verifyCronAuth(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    const environment = process.env.NODE_ENV?.trim().toLowerCase();
    if (environment === "development" || environment === "test") return null;
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader && matchesSecret(authHeader, `Bearer ${secret}`)) return null;

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

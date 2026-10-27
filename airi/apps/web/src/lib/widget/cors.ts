import { NextRequest, NextResponse } from "next/server";

/**
 * CORS configuration for widget API endpoints
 * Allows cross-origin requests from any domain (widget embeds are public)
 * Echoes Origin when provided to support credentialed requests (analytics may send credentials)
 */

const CORS_HEADERS_BASE = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Visitor-Token, X-Visitor-Id, x-client-key",
  "Access-Control-Expose-Headers": "X-Visitor-Token",
  "Access-Control-Max-Age": "86400",
};

function getCorsHeaders(origin: string | null): Record<string, string> {
  return {
    ...CORS_HEADERS_BASE,
    "Access-Control-Allow-Origin": origin || "*",
    ...(origin && { "Access-Control-Allow-Credentials": "true" }),
  };
}

/**
 * Handle OPTIONS preflight requests for CORS
 * Echoes request Origin to avoid "credentials + wildcard" CORS error
 */
export function handleCorsOptions(req?: NextRequest | null): NextResponse {
  const origin = req?.headers.get("origin") ?? null;
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(origin),
  });
}

/**
 * Create JSON response with CORS headers
 * Echoes request Origin when provided
 */
export function jsonWithCors<T>(
  data: T,
  init?: {
    status?: number;
    headers?: Record<string, string>;
    origin?: string | null;
  }
): NextResponse {
  const origin = init?.origin ?? null;
  const headers = new Headers(getCorsHeaders(origin));

  // Add any additional headers
  if (init?.headers) {
    Object.entries(init.headers).forEach(([key, value]) => {
      headers.set(key, value);
    });
  }

  return NextResponse.json(data, {
    status: init?.status || 200,
    headers,
  });
}

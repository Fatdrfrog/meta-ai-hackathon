import { NextResponse } from "next/server";

/**
 * The Cache-Control values routes use for uncacheable JSON. Callers name one
 * explicitly: a shared CDN may still keep "no-store" bodies that "private"
 * forbids, so one value is never a default for another.
 */
export type NoStoreCacheControl =
  | "no-store"
  | "private, no-store"
  | "no-store, max-age=0";

/**
 * JSON response with an explicit Cache-Control. `headers` are applied after
 * Cache-Control, so a caller-provided Cache-Control wins.
 */
export function noStoreJson(
  body: unknown,
  status: number,
  options: {
    cacheControl: NoStoreCacheControl;
    headers?: Record<string, string>;
  }
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": options.cacheControl, ...options.headers },
  });
}

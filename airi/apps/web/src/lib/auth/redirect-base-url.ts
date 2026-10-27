import "server-only";

import { headers } from "next/headers";

import { readConfiguredEnvValue } from "@/lib/config/app-url";

const FALLBACK_APP_URL = "https://www.airi.chat";

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

/**
 * Resolves the base URL that Supabase auth callbacks should return to. The
 * forwarded request headers win so preview and local origins keep working, and
 * the configured application URL is the last resort.
 */
export async function getAuthRedirectBaseUrl(): Promise<string> {
  const headerStore = await headers();
  const forwardedHost = headerStore.get("x-forwarded-host");
  const host = forwardedHost || headerStore.get("host");
  if (host) {
    const forwardedProto = headerStore.get("x-forwarded-proto");
    const protocol =
      forwardedProto ||
      (host.startsWith("localhost") || host.startsWith("127.0.0.1")
        ? "http"
        : "https");
    return stripTrailingSlash(`${protocol}://${host}`);
  }

  const originHeader = headerStore.get("origin");
  if (originHeader) {
    return stripTrailingSlash(originHeader);
  }

  return stripTrailingSlash(
    readConfiguredEnvValue(process.env.NEXT_PUBLIC_APP_URL) || FALLBACK_APP_URL
  );
}

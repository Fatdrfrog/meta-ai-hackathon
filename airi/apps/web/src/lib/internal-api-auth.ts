import { NextResponse } from "next/server";

function readSecretHeader(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  return request.headers.get("x-test-api-secret")?.trim() || null;
}

function getRequestHostname(request: Request): string {
  try {
    return new URL(request.url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

function notFoundResponse(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export function verifyTestApiAccess(request: Request): NextResponse | null {
  const configuredSecret = process.env.TEST_API_SECRET?.trim();
  const providedSecret = readSecretHeader(request);

  if (configuredSecret) {
    return providedSecret === configuredSecret ? null : notFoundResponse();
  }

  const explicitlyEnabled = process.env.E2E_TEST_API_ENABLED === "true";
  if (process.env.NODE_ENV !== "production" && explicitlyEnabled) {
    return null;
  }

  if (
    process.env.NODE_ENV !== "production" &&
    isLoopbackHostname(getRequestHostname(request))
  ) {
    return null;
  }

  return notFoundResponse();
}

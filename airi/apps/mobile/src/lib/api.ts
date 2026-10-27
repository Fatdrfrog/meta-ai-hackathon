import { mobileConfig } from "./config";

export class MobileApiError extends Error {
  readonly status: number;
  readonly details?: string;

  constructor(message: string, status: number, details?: string) {
    super(message);
    this.name = "MobileApiError";
    this.status = status;
    this.details = details;
  }
}

function buildUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${mobileConfig.apiBaseUrl}${normalizedPath}`;
}

export async function authenticatedJson<T>(
  accessToken: string | null | undefined,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!accessToken) {
    throw new MobileApiError("Not authenticated", 401);
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(buildUrl(path), {
    ...init,
    headers,
  });
  const payload = (await response.json().catch(() => null)) as
    | { error?: string; details?: string }
    | T
    | null;

  if (!response.ok) {
    const errorPayload =
      payload && typeof payload === "object" ? payload : null;
    throw new MobileApiError(
      errorPayload && "error" in errorPayload && errorPayload.error
        ? errorPayload.error
        : `Request failed with ${response.status}`,
      response.status,
      errorPayload && "details" in errorPayload
        ? errorPayload.details
        : undefined,
    );
  }

  return payload as T;
}

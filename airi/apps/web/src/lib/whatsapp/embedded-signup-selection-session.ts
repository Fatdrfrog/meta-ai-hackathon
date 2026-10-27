import "server-only";

import {
  decryptString,
  encryptString,
  type EncryptedString,
} from "@/lib/crypto";

// Embedded Signup can return several WABAs or numbers. The business token
// that lists them used to travel in the select page URL; it now lives in a
// short-lived, encrypted, httpOnly cookie that only the WhatsApp source API
// routes receive. The cookie is bound to the user and workspace that started
// the signup, so a reload of the select page keeps working.
export const WHATSAPP_SELECTION_SESSION_COOKIE = "airi_wa_selection";
export const WHATSAPP_SELECTION_SESSION_PATH = "/api/sources/whatsapp";
export const WHATSAPP_SELECTION_SESSION_MAX_AGE_SECONDS = 30 * 60;

type SelectionSessionPayload = {
  v: 1;
  token: string;
  workspaceId: string;
  userId: string;
  expiresAt: number;
};

type CookieSetter = {
  cookies: {
    set: (
      name: string,
      value: string,
      options: {
        httpOnly: boolean;
        secure: boolean;
        sameSite: "lax";
        path: string;
        maxAge: number;
      }
    ) => unknown;
  };
};

function isEncryptedString(value: unknown): value is EncryptedString {
  const record = value as Record<string, unknown> | null;
  return (
    !!record &&
    typeof record.iv === "string" &&
    typeof record.tag === "string" &&
    typeof record.ciphertext === "string"
  );
}

export function sealWhatsAppSelectionSession(params: {
  accessToken: string;
  workspaceId: string;
  userId: string;
  tokenExpiresAt?: Date | null;
  now?: number;
}): { value: string; maxAge: number } | null {
  const now = params.now ?? Date.now();
  const accessToken = params.accessToken.trim();
  if (!accessToken || !params.workspaceId || !params.userId) return null;

  const tokenExpiresAt = params.tokenExpiresAt?.getTime();
  const expiresAt = Math.min(
    now + WHATSAPP_SELECTION_SESSION_MAX_AGE_SECONDS * 1000,
    Number.isFinite(tokenExpiresAt) ? (tokenExpiresAt as number) : Infinity
  );
  const maxAge = Math.floor((expiresAt - now) / 1000);
  if (maxAge <= 0) return null;

  const payload: SelectionSessionPayload = {
    v: 1,
    token: accessToken,
    workspaceId: params.workspaceId,
    userId: params.userId,
    expiresAt,
  };
  const sealed = encryptString(JSON.stringify(payload));
  return {
    value: Buffer.from(JSON.stringify(sealed), "utf8").toString("base64url"),
    maxAge,
  };
}

export function openWhatsAppSelectionSession(
  value: string | null | undefined,
  scope: { workspaceId: string; userId: string; now?: number }
): string | null {
  if (!value) return null;
  try {
    const sealed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    );
    if (!isEncryptedString(sealed)) return null;
    const payload = JSON.parse(
      decryptString(sealed)
    ) as Partial<SelectionSessionPayload>;
    if (
      payload.v !== 1 ||
      typeof payload.token !== "string" ||
      !payload.token ||
      payload.workspaceId !== scope.workspaceId ||
      payload.userId !== scope.userId ||
      typeof payload.expiresAt !== "number" ||
      payload.expiresAt <= (scope.now ?? Date.now())
    ) {
      return null;
    }
    return payload.token;
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function readWhatsAppSelectionSessionToken(
  request: Request,
  scope: { workspaceId: string | null | undefined; userId: string }
): string | null {
  if (!scope.workspaceId) return null;
  return openWhatsAppSelectionSession(
    readCookie(request, WHATSAPP_SELECTION_SESSION_COOKIE),
    { workspaceId: scope.workspaceId, userId: scope.userId }
  );
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: WHATSAPP_SELECTION_SESSION_PATH,
    maxAge,
  };
}

export function setWhatsAppSelectionSessionCookie(
  response: CookieSetter,
  params: Parameters<typeof sealWhatsAppSelectionSession>[0]
): boolean {
  const sealed = sealWhatsAppSelectionSession(params);
  if (!sealed) return false;
  response.cookies.set(
    WHATSAPP_SELECTION_SESSION_COOKIE,
    sealed.value,
    cookieOptions(sealed.maxAge)
  );
  return true;
}

export function clearWhatsAppSelectionSessionCookie(
  response: CookieSetter
): void {
  response.cookies.set(WHATSAPP_SELECTION_SESSION_COOKIE, "", cookieOptions(0));
}

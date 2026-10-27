import crypto from "crypto";
import { readTrimmedString as safeTrim } from "@icecore/shared/lib/value-utils";

export type MetaWebhookSignatureMode = "off" | "log" | "enforce";
export type SourceWebhookSecretMode = "off" | "optional" | "required";
export type TelegramSourceSecretMode = SourceWebhookSecretMode;

export type WebhookSecurityReasonCode =
  | "missing_signature"
  | "invalid_signature"
  | "missing_source_secret"
  | "invalid_source_secret";

export type WebhookSecurityDecision = {
  allowed: boolean;
  reasonCode?: WebhookSecurityReasonCode;
};

function equalsSecret(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function parseMetaMode(value: string | undefined): MetaWebhookSignatureMode {
  const normalized = safeTrim(value).toLowerCase();
  if (
    normalized === "off" ||
    normalized === "log" ||
    normalized === "enforce"
  ) {
    return normalized;
  }
  return process.env.NODE_ENV === "development" ? "off" : "log";
}

function parseSourceMode(value: string | undefined): SourceWebhookSecretMode {
  const normalized = safeTrim(value).toLowerCase();
  if (
    normalized === "off" ||
    normalized === "optional" ||
    normalized === "required"
  ) {
    return normalized;
  }
  return "optional";
}

export function getMetaWebhookSignatureMode(): MetaWebhookSignatureMode {
  return parseMetaMode(process.env.META_WEBHOOK_SIGNATURE_MODE);
}

export function getTelegramSourceSecretMode(): TelegramSourceSecretMode {
  return parseSourceMode(process.env.TELEGRAM_SOURCE_SECRET_MODE);
}

export function verifyMetaSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string | null,
  appSecret: string
): boolean {
  const signature = safeTrim(signatureHeader);
  const secret = safeTrim(appSecret);
  if (!signature || !secret) {
    return false;
  }

  if (!signature.startsWith("sha256=")) {
    return false;
  }

  const providedDigest = signature.slice("sha256=".length).trim();
  if (!providedDigest) {
    return false;
  }

  const expectedDigest = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  return equalsSecret(providedDigest, expectedDigest);
}

export async function readRawBodyAndJson<T = unknown>(
  request: Request
): Promise<{ rawBody: string; body: T }> {
  const rawBody = await request.text();
  let body: T;
  try {
    body = JSON.parse(rawBody) as T;
  } catch {
    throw new Error("Invalid JSON payload");
  }

  return { rawBody, body };
}

function readSourceSecretCandidate(request: Request): string {
  const headerSecret = safeTrim(request.headers.get("x-airi-webhook-secret"));
  if (headerSecret) {
    return headerSecret;
  }

  try {
    const url = new URL(request.url);
    const querySecret = safeTrim(url.searchParams.get("webhook_secret"));
    if (querySecret) {
      return querySecret;
    }
  } catch {}

  return "";
}

function readTelegramBotApiSecretToken(request: Request): string {
  return safeTrim(request.headers.get("X-Telegram-Bot-Api-Secret-Token"));
}

function readPostmarkWebhookTokenCandidates(request: Request): string[] {
  const candidates = [
    safeTrim(request.headers.get("x-postmark-token")),
    safeTrim(new URL(request.url).searchParams.get("token")),
  ].filter(Boolean);
  return Array.from(new Set(candidates));
}

export function verifySourceWebhookSecret(
  request: Request,
  expectedSecret: string | null | undefined
): boolean {
  const expected = safeTrim(expectedSecret);
  const provided = readSourceSecretCandidate(request);
  if (!expected || !provided) {
    return false;
  }
  return equalsSecret(provided, expected);
}

export function enforceMetaWebhookSignature(params: {
  rawBody: string;
  signatureHeader: string | null;
  appSecret: string | null | undefined;
  mode?: MetaWebhookSignatureMode;
}): WebhookSecurityDecision {
  const mode = params.mode || getMetaWebhookSignatureMode();
  if (mode === "off") {
    return { allowed: true };
  }

  const appSecret = safeTrim(params.appSecret);
  if (!appSecret) {
    return {
      allowed: mode !== "enforce",
      reasonCode: "missing_signature",
    };
  }

  const signature = safeTrim(params.signatureHeader);
  if (!signature) {
    return {
      allowed: mode !== "enforce",
      reasonCode: "missing_signature",
    };
  }

  const valid = verifyMetaSignature(params.rawBody, signature, appSecret);
  if (!valid) {
    return {
      allowed: mode !== "enforce",
      reasonCode: "invalid_signature",
    };
  }

  return { allowed: true };
}

export function verifyPostmarkWebhookToken(
  request: Request,
  expectedSecret: string | null | undefined
): boolean {
  const expected = safeTrim(expectedSecret);
  if (!expected) return false;
  return readPostmarkWebhookTokenCandidates(request).some(candidate =>
    equalsSecret(candidate, expected)
  );
}

export function enforceTelegramSourceWebhookSecret(params: {
  request: Request;
  expectedSecret: string | null | undefined;
  mode?: TelegramSourceSecretMode;
}): WebhookSecurityDecision {
  const mode = params.mode || getTelegramSourceSecretMode();
  if (mode === "off") {
    return { allowed: true };
  }

  const expected = safeTrim(params.expectedSecret);
  const provided = readTelegramBotApiSecretToken(params.request);

  if (!expected) {
    if (provided || mode === "required") {
      return {
        allowed: mode !== "required",
        reasonCode: "missing_source_secret",
      };
    }
    return { allowed: true };
  }

  if (!provided) {
    return {
      allowed: false,
      reasonCode: "missing_source_secret",
    };
  }

  if (!equalsSecret(provided, expected)) {
    return {
      allowed: false,
      reasonCode: "invalid_source_secret",
    };
  }

  return { allowed: true };
}

export function logWebhookSecurityEvent(params: {
  provider: string;
  route: string;
  reasonCode: WebhookSecurityReasonCode;
  mode: string;
  status: "allowed" | "denied";
}): void {
  console.warn("[Webhook Security]", {
    event: "webhook_security",
    provider: params.provider,
    route: params.route,
    reason_code: params.reasonCode,
    mode: params.mode,
    status: params.status,
    timestamp: new Date().toISOString(),
  });
}

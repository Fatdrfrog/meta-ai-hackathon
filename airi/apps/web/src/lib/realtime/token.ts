import type { RealtimeTokenScope } from "@icecore/shared/types/realtime";
import { createHmac, timingSafeEqual } from "node:crypto";

export type RealtimeTokenClaims = RealtimeTokenScope & {
  iat: number;
  exp: number;
  aud: "airi-realtime";
};

type RealtimeTokenOptions = {
  secret?: string;
  expiresInSeconds?: number;
  nowSeconds?: number;
};

const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60;
export const REALTIME_BOUNDED_TOKEN_MAX_TTL_SECONDS = 300;

function encodeSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

function base64UrlEncode(value: Buffer | string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(value: string): Buffer {
  const padded = value.padEnd(
    value.length + ((4 - (value.length % 4)) % 4),
    "="
  );
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function signHmacSha256(input: string, secret: string): string {
  return base64UrlEncode(
    createHmac("sha256", encodeSecret(secret)).update(input).digest()
  );
}

export function getRealtimeTokenSecret(
  env: NodeJS.ProcessEnv = process.env
): string {
  const secret = env.REALTIME_TOKEN_SECRET;
  if (!secret) {
    throw new Error("REALTIME_TOKEN_SECRET is required.");
  }
  return secret;
}

export async function signRealtimeToken(
  scope: RealtimeTokenScope,
  options: RealtimeTokenOptions = {}
): Promise<string> {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now)) {
    throw new Error("Invalid realtime token issuance time.");
  }
  const requestedExpiresInSeconds =
    options.expiresInSeconds && options.expiresInSeconds > 0
      ? options.expiresInSeconds
      : DEFAULT_TOKEN_TTL_SECONDS;
  const isBoundedScope =
    scope.kind === "conversation" &&
    (scope.source === "dashboard" || scope.source === "mobile");
  const expiresInSeconds = isBoundedScope
    ? Math.min(
        requestedExpiresInSeconds,
        REALTIME_BOUNDED_TOKEN_MAX_TTL_SECONDS
      )
    : requestedExpiresInSeconds;
  const secret = options.secret || getRealtimeTokenSecret();

  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      ...scope,
      aud: "airi-realtime",
      iat: now,
      exp: now + expiresInSeconds,
    })
  );
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${signHmacSha256(signingInput, secret)}`;
}

export async function verifyRealtimeToken(
  token: string,
  options: Pick<RealtimeTokenOptions, "secret" | "nowSeconds"> = {}
): Promise<RealtimeTokenClaims> {
  const secret = options.secret || getRealtimeTokenSecret();
  const [headerPart, payloadPart, signaturePart] = token.split(".");
  if (!headerPart || !payloadPart || !signaturePart) {
    throw new Error("Invalid realtime token.");
  }
  const signingInput = `${headerPart}.${payloadPart}`;
  const expectedSignature = signHmacSha256(signingInput, secret);
  const expectedBuffer = Buffer.from(expectedSignature);
  const actualBuffer = Buffer.from(signaturePart);
  if (
    expectedBuffer.length !== actualBuffer.length ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw new Error("Invalid realtime token signature.");
  }

  const header = JSON.parse(base64UrlDecode(headerPart).toString("utf8")) as {
    alg?: string;
  };
  if (header.alg !== "HS256") {
    throw new Error("Invalid realtime token algorithm.");
  }

  const payload = JSON.parse(
    base64UrlDecode(payloadPart).toString("utf8")
  ) as Partial<RealtimeTokenClaims> & Record<string, unknown>;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (payload.aud !== "airi-realtime") {
    throw new Error("Invalid realtime token audience.");
  }
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    throw new Error("Realtime token expired.");
  }

  if (payload.kind !== "workspace" && payload.kind !== "conversation") {
    throw new Error("Invalid realtime token scope.");
  }
  if (typeof payload.workspaceId !== "string") {
    throw new Error("Invalid realtime token workspace.");
  }
  if (
    payload.kind === "conversation" &&
    typeof payload.conversationId !== "string"
  ) {
    throw new Error("Invalid realtime token conversation.");
  }

  return payload as RealtimeTokenClaims;
}

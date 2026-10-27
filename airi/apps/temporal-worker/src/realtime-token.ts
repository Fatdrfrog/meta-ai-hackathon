import {
  type RealtimeTokenScope,
  type RealtimeScope,
} from "@icecore/shared/types/realtime";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isRecord } from "@icecore/shared/lib/value-utils";

export type RealtimeTokenClaims = RealtimeTokenScope & {
  aud: "airi-realtime";
  exp: number;
  iat: number;
};

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function base64UrlEncode(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function hmacSha256(input: string, secret: string): string {
  return base64UrlEncode(createHmac("sha256", secret).update(input).digest());
}

function isRealtimeScope(value: unknown): value is RealtimeTokenScope {
  if (!isRecord(value) || typeof value.workspaceId !== "string") return false;
  if (value.kind === "workspace") return true;
  return (
    value.kind === "conversation" && typeof value.conversationId === "string"
  );
}

function normalizeRealtimeTokenClaims(
  value: Partial<RealtimeTokenClaims> & { scope?: unknown },
): Partial<RealtimeTokenClaims> {
  if (isRealtimeScope(value)) {
    return value;
  }

  // Only the older nested shape, which has no top-level kind, is unwrapped; a
  // claim with any other kind cannot be downgraded through its nested scope.
  if (value.kind !== undefined || !isRealtimeScope(value.scope)) {
    return value;
  }

  return {
    ...value.scope,
    aud: value.aud,
    exp: value.exp,
    iat: value.iat,
  };
}

function getRealtimeTokenSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.REALTIME_TOKEN_SECRET || "";
  if (!secret.trim()) {
    throw new Error("REALTIME_TOKEN_SECRET is required");
  }
  return secret;
}

export function verifyRealtimeToken(
  token: string,
  options: { secret?: string; now?: number } = {},
): RealtimeTokenClaims {
  const [encodedHeader, encodedPayload, signature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !signature) {
    throw new Error("Malformed realtime token");
  }

  const signed = `${encodedHeader}.${encodedPayload}`;
  const expected = hmacSha256(
    signed,
    options.secret || getRealtimeTokenSecret(),
  );
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid realtime token signature");
  }

  const header = JSON.parse(
    base64UrlDecode(encodedHeader).toString("utf8"),
  ) as {
    alg?: string;
  };
  if (header.alg !== "HS256") {
    throw new Error("Unsupported realtime token algorithm");
  }

  const rawClaims = JSON.parse(
    base64UrlDecode(encodedPayload).toString("utf8"),
  ) as Partial<RealtimeTokenClaims> & { scope?: unknown };
  const claims = normalizeRealtimeTokenClaims(rawClaims);
  if (claims.aud !== "airi-realtime" || !isRealtimeScope(claims)) {
    throw new Error("Invalid realtime token claims");
  }

  const now = options.now || Math.floor(Date.now() / 1000);
  const exp = (claims as Partial<RealtimeTokenClaims>).exp;
  if (typeof exp !== "number" || exp <= now) {
    throw new Error("Realtime token expired");
  }

  return claims as RealtimeTokenClaims;
}

export function getScopeFromClaims(claims: RealtimeTokenClaims): RealtimeScope {
  return claims.kind === "conversation"
    ? {
        kind: "conversation",
        workspaceId: claims.workspaceId,
        conversationId: claims.conversationId,
      }
    : { kind: "workspace", workspaceId: claims.workspaceId };
}

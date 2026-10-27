import { createHash, createHmac } from "node:crypto";

const DEFAULT_LIVEKIT_TOKEN_TTL_SECONDS = 10 * 60;

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signHs256(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlJson(header);
  const encodedPayload = base64UrlJson(payload);
  const signature = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function normalizeLiveKitHttpUrl(value: string): string {
  return value
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://");
}

export function resolveLiveKitTokenTtlSeconds(
  ttlSeconds?: number | null,
): number {
  return Math.max(
    60,
    Math.floor(ttlSeconds || DEFAULT_LIVEKIT_TOKEN_TTL_SECONDS),
  );
}

export async function mintLiveKitAccessToken(params: {
  apiKey: string;
  apiSecret: string;
  videoGrant: Record<string, unknown>;
  identity?: string | null;
  ttlSeconds?: number | null;
  nowSeconds?: number | null;
}): Promise<string> {
  const nowSeconds = params.nowSeconds || Math.floor(Date.now() / 1000);
  const ttlSeconds = resolveLiveKitTokenTtlSeconds(params.ttlSeconds);

  return signHs256(
    {
      iss: params.apiKey,
      ...(params.identity ? { sub: params.identity } : {}),
      nbf: nowSeconds,
      exp: nowSeconds + ttlSeconds,
      video: params.videoGrant,
    },
    params.apiSecret,
  );
}

export function buildWhatsAppCallRoomName(params: {
  workspaceId: string;
  callId: string;
}): string {
  const hash = createHash("sha256")
    .update(`${params.workspaceId}:${params.callId}`)
    .digest("hex")
    .slice(0, 32);
  return `wa-call-${hash}`;
}

export function buildWhatsAppCallParticipantIdentity(params: {
  workspaceId: string;
  userId: string;
}): string {
  const hash = createHash("sha256")
    .update(`${params.workspaceId}:${params.userId}`)
    .digest("hex")
    .slice(0, 32);
  return `wa-participant-${hash}`;
}

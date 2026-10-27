import crypto from "crypto";
import { z } from "zod";

const DEFAULT_INVITE_LINK_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface TeamInviteLinkPayload {
  v: 1;
  companyId: string;
  workspaceId: string;
  inviterId: string;
  email?: string;
  iat: number;
  exp: number;
}

function getInviteLinkSecret(): string {
  const secret =
    process.env.TEAM_INVITE_LINK_SECRET ||
    process.env.ENCRYPTION_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "";

  if (!secret) {
    throw new Error(
      "Missing invite-link signing secret. Set TEAM_INVITE_LINK_SECRET or ENCRYPTION_SECRET."
    );
  }

  return secret;
}

function signPayload(payloadBase64: string): string {
  return crypto
    .createHmac("sha256", getInviteLinkSecret())
    .update(payloadBase64)
    .digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

const invitePayloadSchema = z
  .object({
    v: z.literal(1),
    companyId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    inviterId: z.string().uuid(),
    email: z.string().email().optional(),
    iat: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    exp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine(
    payload =>
      payload.exp > payload.iat &&
      payload.exp - payload.iat <= DEFAULT_INVITE_LINK_TTL_SECONDS
  );

function isValidPayload(payload: unknown): payload is TeamInviteLinkPayload {
  return invitePayloadSchema.safeParse(payload).success;
}

export function createTeamInviteToken(input: {
  companyId: string;
  workspaceId: string;
  inviterId: string;
  email?: string;
  expiresInSeconds?: number;
}): { token: string; expiresAt: number } {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresInSeconds =
    input.expiresInSeconds || DEFAULT_INVITE_LINK_TTL_SECONDS;
  const expiresAt =
    nowSeconds +
    Math.min(DEFAULT_INVITE_LINK_TTL_SECONDS, Math.max(60, expiresInSeconds));

  const payload: TeamInviteLinkPayload = {
    v: 1,
    companyId: input.companyId,
    workspaceId: input.workspaceId,
    inviterId: input.inviterId,
    ...(input.email !== undefined
      ? { email: input.email.trim().toLowerCase() }
      : {}),
    iat: nowSeconds,
    exp: expiresAt,
  };

  if (!isValidPayload(payload)) {
    throw new Error("Invalid invite payload");
  }

  const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  const signature = signPayload(payloadBase64);

  return {
    token: `${payloadBase64}.${signature}`,
    expiresAt,
  };
}

export function verifyTeamInviteToken(token: string): {
  valid: boolean;
  payload?: TeamInviteLinkPayload;
  reason?: string;
} {
  const segments = token.split(".");
  const [payloadBase64, signature] = segments;

  if (
    segments.length !== 2 ||
    !payloadBase64 ||
    !signature ||
    token.length > 4096 ||
    !/^[A-Za-z0-9_-]+$/.test(payloadBase64) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature)
  ) {
    return { valid: false, reason: "Malformed token" };
  }

  const expectedSignature = signPayload(payloadBase64);
  if (!safeEqual(signature, expectedSignature)) {
    return { valid: false, reason: "Invalid signature" };
  }

  try {
    const payloadRaw = Buffer.from(payloadBase64, "base64url").toString("utf8");
    const payload = JSON.parse(payloadRaw);

    if (!isValidPayload(payload)) {
      return { valid: false, reason: "Invalid payload" };
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (payload.iat > nowSeconds) {
      return { valid: false, reason: "Invalid issue time" };
    }
    if (payload.exp <= nowSeconds) {
      return { valid: false, reason: "Invite link has expired" };
    }

    return { valid: true, payload };
  } catch {
    return { valid: false, reason: "Failed to decode token" };
  }
}

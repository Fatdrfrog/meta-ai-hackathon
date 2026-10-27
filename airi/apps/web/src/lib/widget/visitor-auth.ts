/**
 * Visitor authentication utilities for web widget
 * Generates and verifies JWTs for widget visitors
 */

import { SignJWT, jwtVerify } from "jose";

const JWT_TTL = "1h"; // 1 hour token lifetime

interface VisitorPayload {
  visitorId: string;
  workspaceId: string;
  sourceId: string;
  scope: "widget";
}

function getVisitorJwtSecret(): Uint8Array {
  const secret = process.env.WIDGET_JWT_SECRET || process.env.ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error(
      "WIDGET_JWT_SECRET or ENCRYPTION_SECRET is required for widget visitor JWTs"
    );
  }

  return new TextEncoder().encode(secret);
}

/**
 * Generate a JWT token for a widget visitor
 */
export async function generateVisitorToken(
  payload: VisitorPayload
): Promise<string> {
  const secret = getVisitorJwtSecret();

  const token = await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(JWT_TTL)
    .sign(secret);

  return token;
}

/**
 * Verify and decode a visitor JWT token
 */
export async function verifyVisitorToken(
  token: string
): Promise<VisitorPayload | null> {
  const secret = getVisitorJwtSecret();

  try {
    const { payload } = await jwtVerify(token, secret);
    if (
      payload.scope !== "widget" ||
      ![payload.visitorId, payload.workspaceId, payload.sourceId].every(
        value => typeof value === "string" && value.length > 0
      )
    )
      return null;
    return payload as unknown as VisitorPayload;
  } catch {
    return null;
  }
}

export type WidgetUploadPayload = {
  visitorId: string;
  workspaceId: string;
  companyId: string;
  sourceId: string;
  reservationId: string;
  path: string;
  bytes: number;
  mimeType: string;
  fileName: string;
};

export async function generateWidgetUploadToken(
  payload: WidgetUploadPayload
): Promise<string> {
  return new SignJWT({ ...payload, scope: "widget_upload" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(getVisitorJwtSecret());
}

export async function verifyWidgetUploadToken(
  token: string
): Promise<WidgetUploadPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getVisitorJwtSecret());
    if (
      payload.scope !== "widget_upload" ||
      ![
        payload.visitorId,
        payload.workspaceId,
        payload.companyId,
        payload.sourceId,
        payload.reservationId,
        payload.path,
        payload.mimeType,
        payload.fileName,
      ].every(value => typeof value === "string" && value.length > 0) ||
      !Number.isSafeInteger(payload.bytes) ||
      Number(payload.bytes) <= 0
    )
      return null;
    return payload as unknown as WidgetUploadPayload;
  } catch {
    return null;
  }
}

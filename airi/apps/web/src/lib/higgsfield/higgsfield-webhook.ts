import "server-only";

import crypto from "crypto";

function getWebhookSecret(): string {
  const secret = (process.env.HIGGSFIELD_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    throw new Error(
      "HIGGSFIELD_WEBHOOK_SECRET is required for Higgsfield webhooks"
    );
  }
  return secret;
}

function getBaseUrl(): string {
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || "").trim();
  if (!baseUrl) {
    throw new Error("NEXT_PUBLIC_APP_URL is required for Higgsfield webhooks");
  }
  return baseUrl.replace(/\/$/, "");
}

export function isHiggsfieldWebhookConfigured(): boolean {
  const secret = (process.env.HIGGSFIELD_WEBHOOK_SECRET || "").trim();
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || "").trim();
  if (!secret || !baseUrl) return false;

  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function signHiggsfieldWebhookToken(assetId: string): string {
  const normalizedAssetId = assetId.trim();
  if (!normalizedAssetId) {
    throw new Error("Asset id is required for Higgsfield webhook signing");
  }
  return crypto
    .createHmac("sha256", getWebhookSecret())
    .update(normalizedAssetId)
    .digest("hex");
}

export function verifyHiggsfieldWebhookToken(
  assetId: string,
  token: string
): boolean {
  const normalizedToken = token.trim();
  if (!assetId.trim() || !normalizedToken) return false;
  try {
    const expected = signHiggsfieldWebhookToken(assetId);
    const provided = Buffer.from(normalizedToken, "utf8");
    const target = Buffer.from(expected, "utf8");
    return (
      provided.length === target.length &&
      crypto.timingSafeEqual(provided, target)
    );
  } catch {
    return false;
  }
}

export function buildHiggsfieldWebhookUrl(assetId: string): string {
  const url = new URL("/api/webhooks/higgsfield", getBaseUrl());
  url.searchParams.set("assetId", assetId.trim());
  url.searchParams.set("token", signHiggsfieldWebhookToken(assetId));
  return url.toString();
}

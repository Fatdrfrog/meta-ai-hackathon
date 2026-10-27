import "server-only";
import { readEnvOrEmpty } from "@icecore/shared/lib/env";

/**
 * Wan talking avatar uses Alibaba Model Studio async video APIs.
 * Singapore (ap-southeast-1): key, host, and model must match the same region.
 * Host example: https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com
 */

export type WanS2VResolution = "720P" | "1080P";

export function getAlibabaApiKey(): string {
  return readEnvOrEmpty("ALIBABA_API_KEY");
}

export function getAlibabaApiHost(): string {
  const cleaned = readEnvOrEmpty("ALIBABA_API_HOST")
    .replace(/\/+$/, "")
    .replace(/\/api\/v1$/i, "");
  if (!cleaned) return "";
  // Vercel/env often stores host without scheme; fetch() requires an absolute URL.
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  return `https://${cleaned}`;
}

export function getWanS2VModel(): string {
  return readEnvOrEmpty("WAN_S2V_MODEL") || "wan2.7-i2v-2026-04-25";
}

/** Same Wan 2.7 i2v family; first+last frame morph uses this model id. */
export function getWanI2VModel(): string {
  return (
    readEnvOrEmpty("WAN_I2V_MODEL") ||
    readEnvOrEmpty("WAN_S2V_MODEL") ||
    "wan2.7-i2v-2026-04-25"
  );
}

export function getWanS2VDefaultResolution(): WanS2VResolution {
  const value = readEnvOrEmpty("WAN_S2V_DEFAULT_RESOLUTION").toUpperCase();
  return value === "720P" ? "720P" : "1080P";
}

export function isWanAvatarConfigured(): boolean {
  return Boolean(getAlibabaApiKey() && getAlibabaApiHost());
}

/** First+last morph shares Alibaba host/key with talking avatars. */
export function isWanMorphConfigured(): boolean {
  return isWanAvatarConfigured();
}

export function normalizeWanS2VResolution(
  value: unknown
): WanS2VResolution | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === "720P" || normalized === "1080P") return normalized;
  return null;
}

/** Wan2.7 i2v video duration is an integer in [2, 15]. */
export function normalizeWanS2VDuration(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const duration = Math.round(value);
  if (duration < 2 || duration > 15) return null;
  return duration;
}

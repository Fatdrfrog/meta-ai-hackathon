import "server-only";

import {
  getAlibabaApiHost,
  getAlibabaApiKey,
} from "@/lib/wan/wan-config";
import { readEnvOrEmpty } from "@icecore/shared/lib/env";

/**
 * HappyHorse (快马) video generation via Alibaba Model Studio.
 * Reuses ALIBABA_API_KEY + ALIBABA_API_HOST (Singapore workspace domain).
 */

export type HappyHorseResolution = "720P" | "1080P";
export type HappyHorseRatio =
  | "9:16"
  | "16:9"
  | "1:1"
  | "4:3"
  | "3:4"
  | "4:5"
  | "5:4"
  | "9:21"
  | "21:9";
export type HappyHorseMode =
  | "text_to_video"
  | "image_to_video"
  | "reference_to_video";

export const HAPPYHORSE_REFERENCE_MIN = 1;
export const HAPPYHORSE_REFERENCE_MAX = 9;

export function getHappyHorseT2VModel(): string {
  return readEnvOrEmpty("HAPPYHORSE_T2V_MODEL") || "happyhorse-1.1-t2v";
}

export function getHappyHorseI2VModel(): string {
  return readEnvOrEmpty("HAPPYHORSE_I2V_MODEL") || "happyhorse-1.1-i2v";
}

export function getHappyHorseR2VModel(): string {
  return readEnvOrEmpty("HAPPYHORSE_R2V_MODEL") || "happyhorse-1.1-r2v";
}

export function getHappyHorseDefaultResolution(): HappyHorseResolution {
  const value = readEnvOrEmpty("HAPPYHORSE_DEFAULT_RESOLUTION").toUpperCase();
  return value === "720P" ? "720P" : "1080P";
}

export function getHappyHorseDefaultRatio(): HappyHorseRatio {
  const value = readEnvOrEmpty("HAPPYHORSE_DEFAULT_RATIO") as HappyHorseRatio;
  return normalizeHappyHorseRatio(value) || "9:16";
}

export function isHappyHorseConfigured(): boolean {
  return Boolean(getAlibabaApiKey() && getAlibabaApiHost());
}

export function normalizeHappyHorseResolution(
  value: unknown
): HappyHorseResolution | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === "720P" || normalized === "1080P") return normalized;
  return null;
}

const HAPPYHORSE_RATIOS: HappyHorseRatio[] = [
  "9:16",
  "16:9",
  "1:1",
  "4:3",
  "3:4",
  "4:5",
  "5:4",
  "9:21",
  "21:9",
];

export function normalizeHappyHorseRatio(
  value: unknown
): HappyHorseRatio | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim() as HappyHorseRatio;
  return HAPPYHORSE_RATIOS.includes(normalized) ? normalized : null;
}

/** HappyHorse duration is an integer in [3, 15]. */
export function normalizeHappyHorseDuration(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const duration = Math.round(value);
  if (duration < 3 || duration > 15) return null;
  return duration;
}

export function getHappyHorseModelForMode(mode: HappyHorseMode): string {
  if (mode === "text_to_video") return getHappyHorseT2VModel();
  if (mode === "reference_to_video") return getHappyHorseR2VModel();
  return getHappyHorseI2VModel();
}

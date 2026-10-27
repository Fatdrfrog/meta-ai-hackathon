import { ApiError } from "@google/genai";
import { parseEnvFlag } from "@icecore/shared/lib/env";

export function parseEnabledFlag(
  value: string | undefined,
  defaultValue = true
): boolean {
  return parseEnvFlag(value, defaultValue);
}

export function extractErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error || "");
}

export function getErrorHttpStatus(error: unknown): number | undefined {
  if (error instanceof ApiError) {
    return typeof error.status === "number" ? error.status : undefined;
  }

  if (!error || typeof error !== "object") return undefined;
  if (!("status" in error)) return undefined;
  const status = (error as { status: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

import { readEnvOrEmpty as compactEnv } from "@icecore/shared/lib/env";

export type WhatsAppOtpDeliveryMode = "pubsub" | "temporal";

function parseCommaList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getWhatsAppOtpDeliveryMode(): WhatsAppOtpDeliveryMode {
  const raw = compactEnv("WHATSAPP_OTP_DELIVERY_MODE").toLowerCase();
  return raw === "temporal" ? "temporal" : "pubsub";
}

export function getWhatsAppOtpTemporalWorkspaceAllowlist(): string[] {
  return parseCommaList(compactEnv("WHATSAPP_OTP_TEMPORAL_WORKSPACE_ALLOWLIST"));
}

export function shouldUseTemporalWhatsAppOtpDelivery(
  workspaceId: string
): boolean {
  if (getWhatsAppOtpDeliveryMode() !== "temporal") return false;
  const allowlist = getWhatsAppOtpTemporalWorkspaceAllowlist();
  if (allowlist.length === 0) return true;
  const normalizedWorkspaceId = workspaceId.trim().toLowerCase();
  return allowlist.some((entry) => entry.toLowerCase() === normalizedWorkspaceId);
}

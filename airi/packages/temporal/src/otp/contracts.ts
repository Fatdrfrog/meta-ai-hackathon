export const WHATSAPP_OTP_DELIVERY_WORKFLOW = "whatsappOtpDeliveryWorkflow";
export const WHATSAPP_OTP_DELIVERY_WORKFLOW_CONTRACT_VERSION = 1;
export const WHATSAPP_OTP_DELIVER_CHALLENGE_ACTIVITY =
  "whatsappOtpDeliverChallengeActivity";
export const WHATSAPP_OTP_DELIVER_CHALLENGE_START_TO_CLOSE_TIMEOUT = "30s";
export const WHATSAPP_OTP_DELIVER_CHALLENGE_SCHEDULE_TO_CLOSE_TIMEOUT = "10m";
export const WHATSAPP_OTP_DELIVERY_WORKFLOW_EXECUTION_TIMEOUT_MS = 600_000;
export const WHATSAPP_OTP_DELIVERY_NON_RETRYABLE_ERROR_TYPES = [
  "WhatsAppOtpExpired",
  "WhatsAppOtpNotFound",
  "WhatsAppOtpMissingCredentials",
  "WhatsAppOtpMissingTemplate",
  "WhatsAppOtpMissingCode",
] as const;

export type WhatsAppOtpDeliveryWorkflowInput = {
  contractVersion?: number | null;
  workspaceId: string;
  challengeId: string;
  correlationId?: string | null;
};

export type WhatsAppOtpDeliverChallengeActivityInput = {
  workspaceId: string;
  challengeId: string;
  correlationId?: string | null;
};

export type WhatsAppOtpDeliveryStatus =
  | "sent"
  | "expired"
  | "already_sent"
  | "not_found"
  | "skipped";

export type WhatsAppOtpDeliverChallengeActivityResult = {
  status: WhatsAppOtpDeliveryStatus;
  challengeId: string;
  providerMessageId?: string;
};

export function buildWhatsAppOtpDeliveryWorkflowId(challengeId: string): string {
  return `whatsapp-otp:${challengeId}`;
}

export function isSupportedWhatsAppOtpDeliveryContractVersion(
  version: number | null | undefined
): boolean {
  return version == null || version === WHATSAPP_OTP_DELIVERY_WORKFLOW_CONTRACT_VERSION;
}

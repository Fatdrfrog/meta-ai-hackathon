import "server-only";

import { getVercelOidcTokenOrEnv } from "@/lib/google/gcp-auth";

export type RemoteWhatsAppOtpRequestPayload = {
  phone: string;
  purpose?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
};

export type RemoteWhatsAppOtpResponse = {
  success: boolean;
  challengeId?: string;
  expiresAt?: string;
  deliveryStatus?: string;
  providerMessageId?: string;
  error?: string;
  status?: number;
};

const GCP_OTP_API_TIMEOUT_MS = Math.max(
  3_000,
  Number(process.env.GCP_OTP_API_TIMEOUT_MS || 15_000)
);

function getGcpOtpApiBaseUrl(): string | null {
  const value = String(process.env.GCP_OTP_API_URL || "").trim();
  if (!value) return null;
  return value.replace(/\/$/, "");
}

export function isGcpOtpApiEnabled(): boolean {
  return Boolean(getGcpOtpApiBaseUrl());
}

export async function requestRemoteWhatsAppOtp(input: {
  customerAuthorization: string | null;
  idempotencyKey?: string;
  payload: RemoteWhatsAppOtpRequestPayload;
}): Promise<RemoteWhatsAppOtpResponse> {
  const baseUrl = getGcpOtpApiBaseUrl();
  if (!baseUrl) {
    throw new Error("GCP_OTP_API_URL is not configured");
  }

  const token = await getVercelOidcTokenOrEnv();
  const response = await fetch(`${baseUrl}/v1/otp/whatsapp/request`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(input.customerAuthorization
        ? { "X-Airi-Api-Key": input.customerAuthorization }
        : {}),
      ...(input.idempotencyKey
        ? { "Idempotency-Key": input.idempotencyKey }
        : {}),
    },
    signal: AbortSignal.timeout(GCP_OTP_API_TIMEOUT_MS),
    body: JSON.stringify({
      ...input.payload,
      idempotencyKey: input.payload.idempotencyKey || input.idempotencyKey,
    }),
  });

  const responseText = await response.text();
  let payload: RemoteWhatsAppOtpResponse;
  try {
    payload = JSON.parse(responseText || "{}") as RemoteWhatsAppOtpResponse;
  } catch {
    throw new Error("GCP OTP API returned non-JSON response");
  }

  if (!response.ok) {
    return {
      success: false,
      status: response.status,
      error:
        payload.error ||
        `GCP OTP API HTTP ${response.status}: ${responseText.slice(0, 500)}`,
    };
  }

  return payload;
}

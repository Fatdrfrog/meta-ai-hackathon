import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";
import { z } from "zod";

/** Supabase user metadata key for the number a user sends tests to. */
export const WHATSAPP_TEST_PHONE_METADATA_KEY = "whatsapp_test_phone";

/** Tests per user per hour; they skip campaign contact limits, so cap them. */
export const WHATSAPP_TEST_SEND_HOURLY_LIMIT = 10;

const WHATSAPP_TEST_SEND_PATH = "/api/sources/whatsapp/test-send";

export const WhatsAppTestSendRequestSchema = z
  .object({
    workspaceId: z.string().trim().min(1),
    sourceId: z.string().trim().min(1).optional(),
    to: z.string().trim().min(1).max(40),
    templateName: z.string().trim().min(1).max(512),
    language: z.string().trim().min(1).max(20),
    /** Values for the template's variables; missing ones use Meta's samples. */
    variables: z.record(z.string(), z.string().max(1024)).optional(),
    recipientName: z.string().trim().max(200).optional(),
    origin: z.enum(["bulk_builder", "launch"]).default("bulk_builder"),
  })
  .strict();

export type WhatsAppTestSendRequest = z.input<
  typeof WhatsAppTestSendRequestSchema
>;

export const WHATSAPP_TEST_SEND_ERROR_CODES = [
  "invalid_request",
  "invalid_phone",
  "not_allowed",
  "whatsapp_not_connected",
  "rate_limited",
  "template_unavailable",
  "template_variables_missing",
  "header_media_missing",
  "template_parameters",
  "recipient_not_allowed",
  "recipient_unreachable",
  "recipient_is_sender",
  "meta_billing",
  "meta_rate_limited",
  "token_invalid",
  "send_failed",
] as const;

export type WhatsAppTestSendErrorCode =
  (typeof WHATSAPP_TEST_SEND_ERROR_CODES)[number];

export type WhatsAppTestSendResult =
  | { ok: true; to: string; messageId: string }
  | {
      ok: false;
      code: WhatsAppTestSendErrorCode;
      /** Template variables still empty after Meta's samples. */
      variables?: string[];
      providerCode?: number;
      retryAt?: string;
    };

const ERROR_CODE_SET = new Set<string>(WHATSAPP_TEST_SEND_ERROR_CODES);

/** The saved test number from Supabase user metadata, normalized. */
export function readWhatsAppTestPhone(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[
    WHATSAPP_TEST_PHONE_METADATA_KEY
  ];
  return typeof value === "string"
    ? (normalizeWhatsAppPhone(value) ?? null)
    : null;
}

export async function fetchWhatsAppTestPhone(): Promise<string | null> {
  const response = await fetch(WHATSAPP_TEST_SEND_PATH, { cache: "no-store" });
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as {
    phone?: unknown;
  } | null;
  return typeof body?.phone === "string" ? body.phone : null;
}

export async function postWhatsAppTestSend(
  request: WhatsAppTestSendRequest
): Promise<WhatsAppTestSendResult> {
  let response: Response;
  try {
    response = await fetch(WHATSAPP_TEST_SEND_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    return { ok: false, code: "send_failed" };
  }
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (
    response.ok &&
    typeof body?.to === "string" &&
    typeof body.messageId === "string"
  ) {
    return { ok: true, to: body.to, messageId: body.messageId };
  }
  const code =
    typeof body?.code === "string" && ERROR_CODE_SET.has(body.code)
      ? (body.code as WhatsAppTestSendErrorCode)
      : "send_failed";
  return {
    ok: false,
    code,
    ...(Array.isArray(body?.variables)
      ? {
          variables: body.variables.filter(
            (value): value is string => typeof value === "string"
          ),
        }
      : {}),
    ...(typeof body?.providerCode === "number"
      ? { providerCode: body.providerCode }
      : {}),
    ...(typeof body?.retryAt === "string" ? { retryAt: body.retryAt } : {}),
  };
}

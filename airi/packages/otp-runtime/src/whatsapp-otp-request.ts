import {
  normalizeOtpIdempotencyKey,
  normalizeOtpPurpose,
} from "./otp-normalization";
import { z } from "zod";

export type NormalizedWhatsAppOtpRequestBody = {
  phone: string;
  purpose: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
};

export class WhatsAppOtpRequestValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "WhatsAppOtpRequestValidationError";
  }
}

export const WhatsAppOtpRequestBodySchema = z
  .object({
    phone: z
      .string()
      .transform(value => value.trim())
      .refine(
        value => value.replace(/\D+/g, "").length >= 6,
        "A valid phone is required"
      ),
    purpose: z.unknown().optional(),
    idempotencyKey: z.unknown().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .transform(body => {
    const idempotencyKey = normalizeOtpIdempotencyKey(body.idempotencyKey);
    return {
      phone: body.phone,
      purpose: normalizeOtpPurpose(body.purpose),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(body.metadata ? { metadata: body.metadata } : {}),
    };
  });

export function normalizeWhatsAppOtpRequestBody(
  body: unknown
): NormalizedWhatsAppOtpRequestBody {
  try {
    return WhatsAppOtpRequestBodySchema.parse(body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      const path = issue?.path.join(".");
      throw new WhatsAppOtpRequestValidationError(
        issue
          ? [path, issue.message].filter(Boolean).join(": ")
          : "A JSON object body is required"
      );
    }
    throw error;
  }
}

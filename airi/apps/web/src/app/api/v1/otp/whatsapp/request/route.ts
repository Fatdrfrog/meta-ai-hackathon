import {
  isGcpOtpApiEnabled,
  requestRemoteWhatsAppOtp,
} from "@/lib/otp/gcp-otp-api";
import { authenticateOtpWriteRequest } from "@/lib/otp/otp-api-auth";
import {
  WhatsAppOtpRequestBodySchema,
  WhatsAppOtpRequestValidationError,
} from "@/lib/otp/whatsapp-otp-request";
import { requestWhatsAppOtp } from "@/lib/otp/whatsapp-otp-service";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = WhatsAppOtpRequestBodySchema.parse(await request.json());
    const headerIdempotencyKey =
      request.headers.get("Idempotency-Key")?.trim() || undefined;

    if (isGcpOtpApiEnabled()) {
      const result = await requestRemoteWhatsAppOtp({
        customerAuthorization: request.headers.get("Authorization"),
        idempotencyKey: body.idempotencyKey || headerIdempotencyKey,
        payload: body,
      });
      return NextResponse.json(result, {
        status: result.success ? 200 : result.status || 500,
      });
    }

    const auth = await authenticateOtpWriteRequest(request, "request");
    if ("error" in auth) return auth.error;

    const result = await requestWhatsAppOtp({
      workspaceId: auth.workspaceId,
      recipientPhone: body.phone,
      purpose: body.purpose,
      idempotencyKey: body.idempotencyKey || headerIdempotencyKey,
      metadata: body.metadata,
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const status =
      error instanceof z.ZodError
        ? 400
        : error instanceof WhatsAppOtpRequestValidationError
          ? error.status
          : 500;
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to request WhatsApp OTP",
      },
      { status }
    );
  }
}

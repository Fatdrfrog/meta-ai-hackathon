import { authenticateOtpWriteRequest } from "@/lib/otp/otp-api-auth";
import { verifyOtpChallenge } from "@/lib/otp/otp-verification-service";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VerifyOtpSchema = z.object({
  challengeId: z.string().min(1),
  code: z.string().min(1),
});

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateOtpWriteRequest(request, "verify");
  if ("error" in auth) return auth.error;

  try {
    const body = VerifyOtpSchema.parse(await request.json());
    const result = await verifyOtpChallenge({
      workspaceId: auth.workspaceId,
      challengeId: body.challengeId,
      code: body.code,
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : 500;
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to verify WhatsApp OTP",
      },
      { status }
    );
  }
}

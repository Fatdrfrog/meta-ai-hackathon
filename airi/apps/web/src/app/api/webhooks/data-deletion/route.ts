import { supabaseAdmin } from "@/lib/supabase/admin";
import crypto from "crypto";
import { NextResponse } from "next/server";

const toBase64Url = (value: string) =>
  value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

const errorResponse = (error: string, status: number) =>
  new Response(JSON.stringify({ error }), { status });

/**
 * Meta posts `signed_request` as a form field
 * (application/x-www-form-urlencoded or multipart); JSON is still accepted.
 * An unreadable body counts as a missing parameter.
 */
async function readSignedRequest(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.toLowerCase().includes("application/json")) {
      const body: unknown = await request.json();
      return body && typeof body === "object"
        ? (body as Record<string, unknown>).signed_request
        : undefined;
    }
    return (await request.formData()).get("signed_request");
  } catch {
    return undefined;
  }
}

function signaturesMatch(received: string, expected: string): boolean {
  const left = Buffer.from(received),
    right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readDeletionPayload(
  payload: string
): { userId: string; issuedAt: number } | null {
  try {
    const data: unknown = JSON.parse(
      Buffer.from(payload, "base64").toString("utf-8")
    );
    if (!data || typeof data !== "object") return null;
    const { user_id: userId, issued_at: issuedAt } = data as Record<
      string,
      unknown
    >;
    return typeof userId === "string" &&
      userId &&
      typeof issuedAt === "number" &&
      Number.isFinite(issuedAt)
      ? { userId, issuedAt }
      : null;
  } catch {
    return null;
  }
}

/**
 * Facebook/Meta Data Deletion Callback
 * Required for WhatsApp Business API app review
 *
 * When a user deletes their Facebook account, Meta calls this endpoint
 * to notify us that we should delete all data associated with that user.
 *
 * @see https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
 */
export async function POST(request: Request) {
  try {
    const signedRequest = await readSignedRequest(request);
    const parts =
      typeof signedRequest === "string" ? signedRequest.split(".") : [];
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return errorResponse("Missing signed_request parameter", 400);
    }
    const [encodedSig, payload] = parts;
    const appSecret = process.env.META_APP_SECRET;

    if (!appSecret) {
      return errorResponse("Server configuration error", 500);
    }

    // Verify signature
    const expectedSig = toBase64Url(
      crypto.createHmac("sha256", appSecret).update(payload).digest("base64")
    );
    if (!signaturesMatch(toBase64Url(encodedSig), expectedSig)) {
      return errorResponse("Invalid signature", 403);
    }

    const data = readDeletionPayload(payload);
    if (!data) {
      return errorResponse("Invalid signed_request payload", 400);
    }
    const confirmationCode = crypto.randomBytes(16).toString("hex");

    // Meta calls this without a user session. Only the service role may write
    // deletion requests, and Meta must not get a code for an unsaved request.
    const { error: insertError } = await supabaseAdmin
      .from("data_deletion_requests")
      .insert({
        facebook_user_id: data.userId,
        request_timestamp: new Date(data.issuedAt * 1000).toISOString(),
        confirmation_code: confirmationCode,
        status: "pending",
        created_at: new Date().toISOString(),
      });
    if (insertError) {
      return errorResponse("Failed to record data deletion request", 500);
    }

    // Return the confirmation URL as required by Meta
    const confirmationUrl = `${process.env.NEXT_PUBLIC_APP_URL || "https://www.airi.chat"}/data-deletion?id=${confirmationCode}`;

    return NextResponse.json({
      url: confirmationUrl,
      confirmation_code: confirmationCode,
    });
  } catch (error) {
    // The cause stays in server logs; the caller gets no internal details.
    console.error(
      "[data-deletion] request failed:",
      error instanceof Error ? error.name : typeof error
    );
    return errorResponse("Failed to process data deletion request", 500);
  }
}

export async function GET() {
  return NextResponse.json({
    message: "Facebook Data Deletion Callback Endpoint",
    instructions:
      "Users can request data deletion by contacting support@airi.chat",
    documentation:
      "https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback",
  });
}

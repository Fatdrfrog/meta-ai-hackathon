import { NextResponse } from "next/server";
import { handleEmbeddedSignupCallback } from "./embedded-signup-handler";

/**
 * WhatsApp OAuth/callback — **Embedded Signup only**.
 *
 * Standard (dialog) OAuth for listing businesses/WABAs has been removed; use
 * QR or Embedded Signup in Settings → Integrations.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);

  const isEmbeddedSignup = searchParams.get("embedded") === "true";
  if (isEmbeddedSignup) {
    return handleEmbeddedSignupCallback(request);
  }

  const stateWorkspace = searchParams.get("state");
  const errorUrl = new URL(
    stateWorkspace
      ? `/panel/w/${stateWorkspace}/settings/integrations`
      : "/panel",
    origin
  );
  errorUrl.searchParams.set("type", "whatsapp");
  errorUrl.searchParams.set("error", "legacy_oauth_removed");
  errorUrl.searchParams.set(
    "message",
    "Standard WhatsApp OAuth is no longer available. Use QR code or Embedded Signup in Integrations."
  );
  return NextResponse.redirect(errorUrl);
}

import { createRequestLogger } from "@/lib/observability/server-logs";

type WhatsAppWebhookVerificationOptions = {
  logScope?: string;
  route?: string;
};

/**
 * Webhook verification endpoint
 * Meta periodically re-verifies webhooks by sending GET requests with hub.mode=subscribe
 * If this fails, Meta will automatically unsubscribe the app (causing subscriptions to be lost)
 *
 * CRITICAL: This endpoint must:
 * 1. Always respond quickly (< 5 seconds)
 * 2. Return 200 OK with the challenge value when verification succeeds
 * 3. Never throw errors or time out
 * 4. Log all verification attempts for debugging
 */
export async function handleWhatsAppWebhookVerification(
  request: Request,
  options: WhatsAppWebhookVerificationOptions = {}
) {
  const route = options.route || "/api/webhooks/whatsapp";
  const requestLogger = createRequestLogger(
    options.logScope || "api.webhooks.whatsapp.verify",
    request,
    {
      route,
      webhookKind: "verification",
    }
  );
  requestLogger.start("WhatsApp webhook verification received");

  // Wrap in try-catch to ensure we never throw unhandled errors
  // Meta will unsubscribe if this endpoint throws an error
  try {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get("hub.mode");
    const token = searchParams.get("hub.verify_token");
    const challenge = searchParams.get("hub.challenge");

    requestLogger.info("WhatsApp webhook verification attempt", {
      mode,
      hasToken: Boolean(token),
      hasChallenge: Boolean(challenge),
      verifyTokenConfigured: Boolean(process.env.WHATSAPP_VERIFY_TOKEN),
    });

    // Validate required parameters
    if (!mode || !token || !challenge) {
      requestLogger.warn(
        "WhatsApp webhook verification missing required query parameters",
        {
          hasMode: !!mode,
          hasToken: !!token,
          hasChallenge: !!challenge,
        }
      );
      return new Response("Missing required parameters", { status: 400 });
    }

    // Only handle subscribe mode (Meta's verification)
    if (mode !== "subscribe") {
      requestLogger.warn("WhatsApp webhook verification used invalid mode", {
        mode,
      });
      return new Response(`Invalid mode: ${mode}`, { status: 400 });
    }

    // Verify token matches
    const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN;
    if (!expectedToken) {
      requestLogger.error(
        "WhatsApp webhook verification failed because verify token is missing"
      );
      return new Response("Server configuration error", { status: 500 });
    }

    if (token !== expectedToken) {
      requestLogger.warn("WhatsApp webhook verification token mismatch", {
        receivedLength: token.length,
        expectedLength: expectedToken.length,
      });
      return new Response("Failed to verify webhook", { status: 403 });
    }

    // Verification successful - return challenge
    requestLogger.success("WhatsApp webhook verification completed", {
      mode,
    });
    return new Response(challenge, {
      status: 200,
      headers: {
        "Content-Type": "text/plain",
      },
    });
  } catch (error) {
    requestLogger.error(
      "WhatsApp webhook verification failed unexpectedly",
      error
    );
    // Catch any unexpected errors to prevent unhandled exceptions
    // This ensures Meta doesn't see a 500 error and unsubscribe
    // Return 500 but log the error for debugging
    // Meta may retry, so this gives us a chance to fix the issue
    return new Response("Internal server error", { status: 500 });
  }
}

export async function GET(request: Request) {
  return handleWhatsAppWebhookVerification(request);
}

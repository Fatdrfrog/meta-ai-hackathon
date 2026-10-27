import { handleWhatsAppFlowEndpointPost } from "@/app/api/webhooks/whatsapp/flow-endpoint/route-shared";
import { loadFlowEndpointPrivateKeyFromEnv } from "@/lib/whatsapp/flows/endpoint-crypto";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * WhatsApp Flow Data Endpoint (encrypted POST body, encrypted plain-text response).
 * Configure URL in Meta Flows (endpoint_uri) after uploading the matching public key.
 *
 * Env:
 * - WHATSAPP_FLOW_ENDPOINT_PRIVATE_KEY — PEM RSA private key (pair with key uploaded to Meta)
 * - META_APP_SECRET — same as main WhatsApp webhooks (X-Hub-Signature-256)
 * - META_WEBHOOK_SIGNATURE_MODE — off | log | enforce (shared with other Meta webhooks)
 *
 * @see https://developers.facebook.com/docs/whatsapp/flows/guides/implementingyourflowendpoint
 */
export async function POST(request: NextRequest) {
  return handleWhatsAppFlowEndpointPost({
    request,
    route: "/api/webhooks/whatsapp/flow-endpoint",
    resolveKeyCandidates: async () => {
      const privateKeyPem = loadFlowEndpointPrivateKeyFromEnv();
      return privateKeyPem ? [{ privateKeyPem }] : null;
    },
    unavailable: {
      status: 503,
      body: "Flow endpoint not configured",
    },
  });
}

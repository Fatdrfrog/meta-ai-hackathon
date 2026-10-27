import {
  JsonBodyTooLargeError,
  readBodyBytesWithinLimit,
} from "@/lib/api/json-body";
import { createServerLogger } from "@/lib/observability/server-logs";
import {
  enforceMetaWebhookSignature,
  getMetaWebhookSignatureMode,
  logWebhookSecurityEvent,
  verifyMetaSignature,
} from "@/lib/webhook-auth";
import {
  decryptFlowEndpointRequest,
  encryptFlowEndpointResponse,
  isFlowEndpointEncryptedBody,
} from "@/lib/whatsapp/flows/endpoint-crypto";
import { handleDecryptedFlowPayload } from "@/lib/whatsapp/flows/endpoint-handler";
import {
  checkRateLimit,
  createRateLimiter,
  rateLimitPresets,
} from "@icecore/shared/lib/rate-limiter";

const FLOW_ENDPOINT_MAX_REQUEST_BYTES = 1_024 * 1_024;
const untrustedFlowEndpointLimiter = createRateLimiter({
  ...rateLimitPresets.webhook,
  prefix: "whatsapp:flow-endpoint:untrusted",
});
const flowEndpointLogger = createServerLogger("whatsapp.flow-endpoint");

type FlowEndpointPrivateKeyCandidate = {
  privateKeyPem: string;
};

type FlowEndpointUnavailableResponse = {
  status: 421 | 503;
  body: string | null;
};

function getUntrustedRequestIdentity(request: Request): string {
  const forwardedIp = (
    request.headers.get("x-vercel-forwarded-for") ||
    request.headers.get("x-forwarded-for")
  )
    ?.split(",", 1)[0]
    ?.trim();
  const directIp = request.headers.get("x-real-ip")?.trim();
  return (forwardedIp || directIp || "unknown").slice(0, 128);
}

async function enforceUntrustedRequestRateLimit(params: {
  request: Request;
  route: string;
}): Promise<Response | null> {
  try {
    const result = await checkRateLimit(
      untrustedFlowEndpointLimiter,
      getUntrustedRequestIdentity(params.request),
      rateLimitPresets.webhook.requests
    );
    if (result.success) return null;

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((result.reset - Date.now()) / 1_000)
    );
    return new Response("Too Many Requests", {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    });
  } catch (error) {
    flowEndpointLogger.warn("Flow endpoint rate limiter unavailable", {
      route: params.route,
      error: error instanceof Error ? error : String(error),
    });
    return null;
  }
}

export async function handleWhatsAppFlowEndpointPost(params: {
  request: Request;
  route: string;
  resolveKeyCandidates: () => Promise<
    readonly FlowEndpointPrivateKeyCandidate[] | null
  >;
  unavailable: FlowEndpointUnavailableResponse;
}): Promise<Response> {
  const mode = getMetaWebhookSignatureMode();
  let rawBody: string;
  try {
    const rawBodyBytes = await readBodyBytesWithinLimit(
      params.request,
      FLOW_ENDPOINT_MAX_REQUEST_BYTES
    );
    rawBody = new TextDecoder().decode(rawBodyBytes);
  } catch (error) {
    return new Response(
      error instanceof JsonBodyTooLargeError
        ? "Payload Too Large"
        : "Bad Request",
      { status: error instanceof JsonBodyTooLargeError ? 413 : 400 }
    );
  }
  const signatureHeader = params.request.headers.get("x-hub-signature-256");
  const appSecret = process.env.META_APP_SECRET;
  const signatureDecision = enforceMetaWebhookSignature({
    rawBody,
    signatureHeader,
    appSecret,
    mode,
  });

  if (signatureDecision.reasonCode) {
    logWebhookSecurityEvent({
      provider: "whatsapp",
      route: params.route,
      reasonCode: signatureDecision.reasonCode,
      mode,
      status: signatureDecision.allowed ? "allowed" : "denied",
    });
  }
  if (!signatureDecision.allowed) {
    return new Response("Unauthorized", { status: 401 });
  }
  const hasTrustedMetaSignature =
    mode === "off"
      ? Boolean(
          appSecret && verifyMetaSignature(rawBody, signatureHeader, appSecret)
        )
      : !signatureDecision.reasonCode;
  if (!hasTrustedMetaSignature) {
    const rateLimitResponse = await enforceUntrustedRequestRateLimit({
      request: params.request,
      route: params.route,
    });
    if (rateLimitResponse) return rateLimitResponse;
  }

  let keyCandidates: readonly FlowEndpointPrivateKeyCandidate[] | null;
  try {
    keyCandidates = await params.resolveKeyCandidates();
  } catch {
    keyCandidates = null;
  }
  const usableKeyCandidates = (keyCandidates ?? []).filter(
    candidate =>
      candidate &&
      typeof candidate.privateKeyPem === "string" &&
      candidate.privateKeyPem.trim().length > 0
  );
  if (usableKeyCandidates.length === 0) {
    return new Response(params.unavailable.body, {
      status: params.unavailable.status,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (!isFlowEndpointEncryptedBody(parsed)) {
    return new Response("Bad Request", { status: 400 });
  }

  let decryptedResult: ReturnType<typeof decryptFlowEndpointRequest> | null =
    null;
  for (const candidate of usableKeyCandidates) {
    try {
      decryptedResult = decryptFlowEndpointRequest(
        parsed,
        candidate.privateKeyPem
      );
      break;
    } catch {
      // Rotation requires trying the next eligible WABA-bound key generation.
    }
  }
  if (!decryptedResult) {
    return new Response(null, { status: 421 });
  }

  const plaintextResponse = handleDecryptedFlowPayload(
    decryptedResult.decrypted
  );
  const encryptedResponse = encryptFlowEndpointResponse(
    plaintextResponse,
    decryptedResult.aesKey,
    decryptedResult.iv
  );
  return new Response(encryptedResponse, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

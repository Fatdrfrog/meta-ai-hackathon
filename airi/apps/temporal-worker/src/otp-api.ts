import http from "node:http";
import { fileURLToPath } from "node:url";

import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  getOtpRateLimitBackend,
  installDefaultOtpRuntime,
  normalizeWhatsAppOtpRequestBody,
  requestWhatsAppOtp,
} from "@icecore/otp-runtime";

import {
  authorizeVercelOidcRequest,
  createVercelOidcAuthConfig,
  getHeaderString,
  getOidcErrorStatus,
  parseEnabledFlag,
  readJsonBody,
  type VercelOidcAuthConfig,
  writeJson,
} from "./http-service.js";
import { loadTemporalWorkerEnv } from "./load-env.js";

const DEFAULT_PORT = 8080;

function getOtpApiAuthConfig(): VercelOidcAuthConfig {
  return createVercelOidcAuthConfig({
    authDisabled:
      parseEnabledFlag(process.env.OTP_API_DISABLE_AUTH, false) ||
      parseEnabledFlag(process.env.AI_GATEWAY_DISABLE_AUTH, false),
    serviceName: "OTP API",
  });
}

function getCustomerAuthorization(
  request: http.IncomingMessage,
  authConfig: VercelOidcAuthConfig,
): string | null {
  const forwarded = getHeaderString(request, "x-airi-api-key");
  if (forwarded) return forwarded;

  if (authConfig.authDisabled) {
    return request.headers.authorization || null;
  }

  return null;
}

async function handleRequestOtp(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  authConfig: VercelOidcAuthConfig,
): Promise<void> {
  await authorizeVercelOidcRequest(request, authConfig);
  installDefaultOtpRuntime();

  const body = normalizeWhatsAppOtpRequestBody(
    await readJsonBody<unknown>(request),
  );
  const customerAuthorization = getCustomerAuthorization(request, authConfig);
  const { authenticateOtpWriteRequest } = await import(
    "@/lib/otp/otp-api-auth"
  );
  const authRequest = new Request("http://localhost/internal/otp-api-auth", {
    headers: {
      ...(customerAuthorization
        ? { Authorization: customerAuthorization }
        : {}),
    },
  });
  const auth = await authenticateOtpWriteRequest(authRequest, "request");
  if ("error" in auth) {
    writeJson(response, auth.error.status, await auth.error.json());
    return;
  }

  const headerIdempotencyKey =
    getHeaderString(request, "idempotency-key") || undefined;
  const result = await requestWhatsAppOtp({
    workspaceId: auth.workspaceId,
    recipientPhone: body.phone,
    purpose: body.purpose,
    idempotencyKey: body.idempotencyKey || headerIdempotencyKey,
    metadata: body.metadata,
  });

  writeJson(response, 200, { success: true, ...result });
}

async function routeOtpApiRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  authConfig: VercelOidcAuthConfig,
): Promise<void> {
  const method = request.method || "GET";
  const url = new URL(request.url || "/", "http://localhost");

  if (method === "GET" && url.pathname === "/healthz") {
    writeJson(response, 200, {
      ok: true,
      runtimeMode: "otp-api",
      rateLimitBackend: getOtpRateLimitBackend(),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/otp/whatsapp/request") {
    await handleRequestOtp(request, response, authConfig);
    return;
  }

  writeJson(response, 404, { error: "Not found" });
}

function getOtpApiErrorStatus(error: unknown): number {
  const oidcStatus = getOidcErrorStatus(error);
  if (oidcStatus === 401) return oidcStatus;

  const message = error instanceof Error ? error.message : String(error);
  if (/valid phone|purpose|invalid json|json object|metadata/i.test(message)) {
    return 400;
  }
  if (/too many otp|please wait/i.test(message)) return 429;

  return 500;
}

export async function runOtpApiServer(): Promise<void> {
  const loadedEnvFiles = loadTemporalWorkerEnv();
  const port = Math.max(1, Number(process.env.PORT || DEFAULT_PORT));
  const authConfig = getOtpApiAuthConfig();

  installDefaultOtpRuntime();
  const rateLimitBackend = getOtpRateLimitBackend();
  if (process.env.NODE_ENV === "production" && rateLimitBackend !== "valkey") {
    throw new Error(
      "OTP API requires Memorystore Valkey rate limiting in production (set MEMORYSTORE_VALKEY_HOST)",
    );
  }

  const server = http.createServer((request, response) => {
    routeOtpApiRequest(request, response, authConfig).catch((error) => {
      const statusCode = getOtpApiErrorStatus(error);
      writeJson(response, statusCode, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve());
  });

  airiWorkerLogger.info("airi.worker.otp_api", {
    port,
    note: "started",
    authDisabled: authConfig.authDisabled,
    issuerUrl: authConfig.issuerUrl,
    audience: authConfig.audience,
    allowedSubjects: authConfig.allowedSubjects,
    rateLimitBackend,
    loadedEnvFiles,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runOtpApiServer().catch((error) => {
    airiWorkerLogger.error("airi.worker.otp_api", error, {
      note: "start_failed",
    });
    process.exit(1);
  });
}

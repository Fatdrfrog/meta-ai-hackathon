import http from "node:http";

import * as jose from "jose";

export { parseEnabledFlag } from "./runtime-env.js";

export type HttpRequestLike = Pick<http.IncomingMessage, "headers"> &
  AsyncIterable<Buffer | string>;

export type VercelOidcAuthConfig = {
  authDisabled: boolean;
  issuerUrl: string | null;
  audience: string | null;
  allowedSubjects: string[];
  jwks: ReturnType<typeof jose.createRemoteJWKSet> | null;
};

export class HttpRequestBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "HttpRequestBodyTooLargeError";
  }
}

export class HttpRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpRequestValidationError";
  }
}

function getRequiredEnv(name: string, serviceName: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`${name} is required for the ${serviceName}`);
  }
  return value;
}

function getAllowedSubjects(): string[] {
  return String(process.env.AI_GATEWAY_VERCEL_OIDC_SUBJECTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function extractBearerToken(
  request: Pick<http.IncomingMessage, "headers">,
): string | null {
  const authorization = request.headers.authorization;
  if (!authorization) return null;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function getHeaderString(
  request: Pick<http.IncomingMessage, "headers">,
  name: string,
): string | null {
  const raw = request.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0]?.trim() || null;
  return raw?.trim() || null;
}

export async function readRawBody(
  request: HttpRequestLike,
  options: { maxBytes?: number } = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new HttpRequestBodyTooLargeError(maxBytes);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function readJsonBody<T>(request: HttpRequestLike): Promise<T> {
  const rawBody = (await readRawBody(request)).trim();

  if (!rawBody) {
    return {} as T;
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new HttpRequestValidationError("Invalid JSON body");
  }
}

export function writeJson(
  response: http.ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

export function createVercelOidcAuthConfig(input: {
  authDisabled: boolean;
  serviceName: string;
}): VercelOidcAuthConfig {
  if (input.authDisabled) {
    return {
      authDisabled: true,
      issuerUrl: null,
      audience: null,
      allowedSubjects: [],
      jwks: null,
    };
  }

  const issuerUrl = getRequiredEnv(
    "AI_GATEWAY_VERCEL_OIDC_ISSUER_URL",
    input.serviceName,
  );
  const audience = getRequiredEnv(
    "AI_GATEWAY_VERCEL_OIDC_AUDIENCE",
    input.serviceName,
  );
  const allowedSubjects = getAllowedSubjects();

  return {
    authDisabled: false,
    issuerUrl,
    audience,
    allowedSubjects,
    jwks: jose.createRemoteJWKSet(new URL("/.well-known/jwks", issuerUrl)),
  };
}

export async function authorizeVercelOidcRequest(
  request: http.IncomingMessage,
  authConfig: VercelOidcAuthConfig,
): Promise<void> {
  if (authConfig.authDisabled) return;

  const token = extractBearerToken(request);
  if (
    !token ||
    !authConfig.jwks ||
    !authConfig.issuerUrl ||
    !authConfig.audience
  ) {
    throw new Error("Missing bearer token");
  }

  const { payload } = await jose.jwtVerify(token, authConfig.jwks, {
    issuer: authConfig.issuerUrl,
    audience: authConfig.audience,
  });

  if (
    authConfig.allowedSubjects.length > 0 &&
    !authConfig.allowedSubjects.includes(String(payload.sub || ""))
  ) {
    throw new Error("OIDC subject is not allowed");
  }
}

export function getHttpErrorStatus(error: unknown): 400 | 401 | 413 | 500 {
  if (error instanceof HttpRequestBodyTooLargeError) return 413;
  if (error instanceof HttpRequestValidationError) return 400;
  if (error instanceof jose.errors.JOSEError) return 401;
  if (
    error instanceof Error &&
    /token|unauthorized|oidc/i.test(error.message)
  ) {
    return 401;
  }
  return 500;
}

export const getOidcErrorStatus = getHttpErrorStatus;

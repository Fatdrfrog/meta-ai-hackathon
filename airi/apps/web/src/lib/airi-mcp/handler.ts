import "server-only";

import {
  createMcpHandler,
  isJsonContentType,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import {
  JsonBodyTooLargeError,
  readJsonBodyWithinLimit,
} from "@/lib/api/json-body";
import { noStoreJson } from "@/lib/http/no-store-json";
import { createAiriMcpServer } from "./server";
import { listAllowedAiriMcpTools } from "./tools";
import type { AiriMcpAuthContext, AiriMcpDeps } from "./types";

/** JSON-RPC requests here are small; the SDK 2.0.0 reads bodies unbounded. */
export const AIRI_MCP_MAX_BODY_BYTES = 64 * 1024;

const BEARER_CHALLENGE = { "WWW-Authenticate": "Bearer" };

/** Kill switch, read per request so it can be flipped without a rebuild. */
export function isAiriMcpEnabled(): boolean {
  return process.env.AIRI_MCP_ENABLED === "1";
}

function httpError(
  status: number,
  code: string,
  error: string,
  headers?: Record<string, string>
): Response {
  return noStoreJson({ code, error }, status, {
    cacheControl: "no-store",
    headers,
  });
}

function jsonRpcError(code: number, message: string): Response {
  return noStoreJson(
    { jsonrpc: "2.0", id: null, error: { code, message } },
    400,
    { cacheControl: "no-store" }
  );
}

/** The shared authenticator's 401s carry no challenge; MCP clients need one. */
function withBearerChallenge(response: Response): Response {
  if (response.status !== 401) return response;
  const headers = new Headers(response.headers);
  headers.set("WWW-Authenticate", "Bearer");
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withNoStore(response: Response): Response {
  if (!response.headers.has("Cache-Control")) {
    try {
      response.headers.set("Cache-Control", "no-store");
    } catch {
      // Immutable headers: the response is still correct without the hint.
    }
  }
  return response;
}

/**
 * Stateless Streamable HTTP endpoint for the read-only Airi MCP.
 *
 * Everything that is not MCP (kill switch, method, Origin, Bearer API key,
 * rate limit, body bounds) is answered here as plain JSON before the SDK
 * runs. 2025-era clients are served by a per-request JSON-only transport;
 * 2026-07-28 clients by `createMcpHandler` in JSON mode. Both build the same
 * per-request server, so no session, SSE stream or GET stream ever exists.
 */
export function createAiriMcpRequestHandler(deps: AiriMcpDeps) {
  // The SDK hands the AuthInfo passed to fetch() to the factory unchanged.
  const contexts = new WeakMap<AuthInfo, AiriMcpAuthContext>();
  let modern: McpHttpHandler | undefined;

  // Lazy: creating it in JSON mode logs a console warning.
  const getModernHandler = () =>
    (modern ??= createMcpHandler(
      ({ authInfo }) => {
        const auth = authInfo ? contexts.get(authInfo) : undefined;
        if (!auth) throw new Error("airi_mcp_missing_auth_context");
        return createAiriMcpServer(auth, deps);
      },
      {
        legacy: "reject",
        responseMode: "json",
        // subscriptions/listen would otherwise open an SSE stream.
        maxSubscriptions: 0,
        keepAliveMs: 0,
        onerror: error =>
          deps.logger.warn("airi_mcp.sdk_error", {
            event: "airi_mcp.sdk_error",
            errorName: error.name,
          }),
      }
    ));

  async function serveLegacy(
    request: Request,
    parsedBody: unknown,
    authInfo: AuthInfo,
    auth: AiriMcpAuthContext
  ): Promise<Response> {
    const server = createAiriMcpServer(auth, deps);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request, { parsedBody, authInfo });
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }

  async function handle(request: Request): Promise<Response> {
    if (!isAiriMcpEnabled()) {
      return httpError(404, "NOT_FOUND", "Not found");
    }
    if (request.method !== "POST") {
      return httpError(405, "METHOD_NOT_ALLOWED", "Use POST.", {
        Allow: "POST",
      });
    }
    if (request.headers.get("origin") !== null) {
      return httpError(
        403,
        "AIRI_MCP_ORIGIN_FORBIDDEN",
        "Browser requests are not accepted. Connect from an MCP client."
      );
    }
    // Bearer only: no X-API-Key fallback and no bare key without the scheme.
    if (!request.headers.get("authorization")?.startsWith("Bearer sk_")) {
      return httpError(
        401,
        "AIRI_MCP_UNAUTHORIZED",
        "Send an Airi API key as Authorization: Bearer sk_...",
        BEARER_CHALLENGE
      );
    }

    const authentication = await deps.authenticate(request);
    if (authentication.error) return withBearerChallenge(authentication.error);
    const { apiKey } = authentication;
    if (listAllowedAiriMcpTools(apiKey).length === 0) {
      return httpError(
        403,
        "AIRI_MCP_FORBIDDEN",
        "This API key cannot read any Airi MCP data."
      );
    }

    if (!isJsonContentType(request.headers.get("content-type"))) {
      return httpError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Content-Type must be application/json."
      );
    }
    let parsedBody: unknown;
    try {
      parsedBody = await readJsonBodyWithinLimit(
        request,
        AIRI_MCP_MAX_BODY_BYTES
      );
    } catch (error) {
      if (error instanceof JsonBodyTooLargeError) {
        return httpError(
          413,
          "PAYLOAD_TOO_LARGE",
          "Request body is too large."
        );
      }
      return jsonRpcError(-32700, "Parse error");
    }
    // One rate-limit token must not admit many calls.
    if (Array.isArray(parsedBody)) {
      return jsonRpcError(-32600, "Batch requests are not supported.");
    }

    const auth: AiriMcpAuthContext = {
      apiKey,
      workspaceId: apiKey.workspace_id,
      appOrigin: new URL(request.url).origin,
    };
    // The key itself never travels further than authentication.
    const authInfo: AuthInfo = { token: "", clientId: apiKey.id, scopes: [] };
    contexts.set(authInfo, auth);

    const response = (await isLegacyRequest(request, parsedBody))
      ? await serveLegacy(request, parsedBody, authInfo, auth)
      : await getModernHandler().fetch(request, { parsedBody, authInfo });
    return withNoStore(response);
  }

  return async function handleAiriMcpRequest(
    request: Request
  ): Promise<Response> {
    try {
      return await handle(request);
    } catch (error) {
      deps.logger.error("airi_mcp.request_failed", undefined, {
        event: "airi_mcp.request_failed",
        errorName: error instanceof Error ? error.name : "unknown",
      });
      return httpError(500, "AIRI_MCP_UNAVAILABLE", "Airi MCP is unavailable.");
    }
  };
}

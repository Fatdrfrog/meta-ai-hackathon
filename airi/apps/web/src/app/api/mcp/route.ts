import { authenticateRequest } from "@/lib/api-auth";
import { createAiriMcpRequestHandler } from "@/lib/airi-mcp/handler";
import { createAiriMcpMongoDataProvider } from "@/lib/airi-mcp/mongo-data-provider";
import {
  createServerLogger,
  flushServerLogsAfterResponse,
} from "@/lib/observability/server-logs";

/**
 * Experimental read-only Airi MCP (Streamable HTTP, stateless, JSON only).
 * Off unless AIRI_MCP_ENABLED=1; see docs/customer-api.md.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const handleAiriMcpRequest = createAiriMcpRequestHandler({
  // No per-instance fallback: production fails closed without the shared limiter.
  authenticate: request =>
    authenticateRequest(request, { requireDistributedRateLimit: true }),
  data: createAiriMcpMongoDataProvider(),
  logger: createServerLogger("api.mcp"),
  now: () => new Date(),
});

export async function POST(request: Request): Promise<Response> {
  flushServerLogsAfterResponse();
  return handleAiriMcpRequest(request);
}

// No GET stream and no sessions: every other method is 405 (404 when off).
export const GET = handleAiriMcpRequest;
export const PUT = handleAiriMcpRequest;
export const PATCH = handleAiriMcpRequest;
export const DELETE = handleAiriMcpRequest;
export const OPTIONS = handleAiriMcpRequest;

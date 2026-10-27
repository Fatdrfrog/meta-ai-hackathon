import connectDB from "@/lib/mongoose";
import {
  getCompanyConversationVisibilityGate,
  isConversationVisibleForPlan,
} from "@/lib/limits/company-limits";
import { getRealtimeGatewayUrl } from "@/lib/realtime/gateway-url";
import {
  getRealtimeTokenSecret,
  REALTIME_BOUNDED_TOKEN_MAX_TTL_SECONDS,
  signRealtimeToken,
} from "@/lib/realtime/token";
import {
  createServerLogger,
  flushServerLogsAfterResponse,
} from "@/lib/observability/server-logs";
import {
  getSupabaseRouteAuth,
  isSupabaseRouteAuthError,
} from "@/lib/supabase/route-auth";
import { handleCorsOptions, jsonWithCors } from "@/lib/widget/cors";
import { verifyVisitorToken } from "@/lib/widget/visitor-auth";
import {
  isWidgetConversationOwnedByVisitor,
  type WidgetConversationOwnershipFields,
} from "@/lib/widget/visitor-conversation-access";
import { Conversation } from "@/models/conversation";
import {
  REALTIME_CLIENT_CONTRACT_HEADER,
  REALTIME_DASHBOARD_CLIENT_CONTRACT_V1,
} from "@icecore/shared/types/realtime";
import type { NextRequest } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";

const TOKEN_TTL_SECONDS = 60 * 60;
const REALTIME_GATEWAY_NOT_CONFIGURED_CODE = "realtime_gateway_not_configured";
const WIDGET_VISITOR_TOKEN_MISSING_CODE = "widget_visitor_token_missing";
const WIDGET_VISITOR_TOKEN_INVALID_CODE = "widget_visitor_token_invalid";
const WIDGET_VISITOR_WORKSPACE_MISMATCH_CODE =
  "widget_visitor_workspace_mismatch";
const WIDGET_CONVERSATION_NOT_FOUND_CODE = "widget_conversation_not_found";
const REALTIME_TOKEN_LOG_SCOPE = "api.realtime.token";

const realtimeTokenLogger = createServerLogger(REALTIME_TOKEN_LOG_SCOPE);

type RealtimeTokenOutcome = "success" | "denied" | "error";
type RealtimeTokenLogEvent = {
  method: "GET" | "POST";
  route: "/api/realtime/token";
  requestId?: string;
  originHost?: string;
  statusCode: number;
  outcome: RealtimeTokenOutcome;
  denialReason?: string;
  code?: string;
  durationMs: number;
  hasWorkspaceId?: boolean;
  hasConversationId?: boolean;
  authMode?: string;
  visitorMatchesWorkspace?: boolean;
  conversationBelongsToWorkspace?: boolean;
  conversationOwnedByVisitor?: boolean;
};

function getRequestId(request: Request): string | undefined {
  return (
    request.headers.get("x-vercel-id") ||
    request.headers.get("x-request-id") ||
    request.headers.get("x-correlation-id") ||
    undefined
  );
}

function getOriginHost(origin: string | null): string | undefined {
  if (!origin) return undefined;
  try {
    return new URL(origin).host;
  } catch {
    return "invalid_origin";
  }
}

function getVisitorAuthMode(request: Request): string {
  if (request.headers.get("x-visitor-token")) return "visitor_header";
  if (request.headers.get("authorization")) return "bearer";
  return "missing";
}

function emitRealtimeTokenLog(event: RealtimeTokenLogEvent) {
  const message = "Realtime token request completed";
  if (event.statusCode >= 500 || event.outcome === "error") {
    realtimeTokenLogger.error(message, undefined, event);
    return;
  }
  if (event.outcome === "denied") {
    realtimeTokenLogger.warn(message, event);
  }
}

async function conversationBelongsToWorkspace(
  conversationId: string,
  workspaceId: string
): Promise<boolean> {
  await connectDB();
  const conversation = await Conversation.findOne({
    _id: conversationId,
    workspaceId,
  })
    .select("_id")
    .lean()
    .exec();
  return Boolean(conversation);
}

async function widgetVisitorOwnsConversation(
  conversationId: string,
  visitor: { workspaceId: string; sourceId: string; visitorId: string }
): Promise<boolean> {
  await connectDB();
  const conversation = await Conversation.findOne({
    _id: conversationId,
    workspaceId: visitor.workspaceId,
  })
    .select("workspaceId channel sourceId visitor_id user")
    .lean<WidgetConversationOwnershipFields>()
    .exec();
  return Boolean(
    conversation &&
      isWidgetConversationOwnedByVisitor(conversation, {
        workspaceId: visitor.workspaceId,
        sourceId: visitor.sourceId,
        visitorIds: [visitor.visitorId],
      })
  );
}

function jsonTokenResponse(
  token: string,
  gatewayUrl: string,
  issuedAtSeconds: number,
  expiresInSeconds: number,
  origin?: string | null
) {
  return jsonWithCors(
    {
      token,
      url: gatewayUrl,
      expiresInSeconds,
      expiresAt: new Date(
        (issuedAtSeconds + expiresInSeconds) * 1000
      ).toISOString(),
    },
    {
      origin,
      headers: { "Cache-Control": "private, no-store" },
    }
  );
}

function jsonError(
  message: string,
  status: number,
  origin?: string | null,
  code?: string
) {
  return jsonWithCors(code ? { error: message, code } : { error: message }, {
    status,
    origin,
    headers: {
      "Cache-Control": "private, no-store",
      ...(code === REALTIME_GATEWAY_NOT_CONFIGURED_CODE
        ? { "Retry-After": "300" }
        : {}),
    },
  });
}

export function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request);
}

export async function GET(request: Request) {
  const origin = request.headers.get("origin");
  const startedAt = Date.now();
  const event: RealtimeTokenLogEvent = {
    method: "GET",
    route: "/api/realtime/token",
    requestId: getRequestId(request),
    originHost: getOriginHost(origin),
    statusCode: 500,
    outcome: "error",
    durationMs: 0,
  };
  flushServerLogsAfterResponse();
  try {
    getRealtimeTokenSecret();
    const gatewayUrl = getRealtimeGatewayUrl();
    if (!gatewayUrl) {
      event.statusCode = 503;
      event.outcome = "denied";
      event.denialReason = "realtime_gateway_not_configured";
      event.code = REALTIME_GATEWAY_NOT_CONFIGURED_CODE;
      return jsonError(
        "Realtime gateway is not configured",
        503,
        origin,
        REALTIME_GATEWAY_NOT_CONFIGURED_CODE
      );
    }

    const auth = await getSupabaseRouteAuth(request);
    if (isSupabaseRouteAuthError(auth)) {
      event.statusCode = 401;
      event.outcome = "denied";
      event.denialReason = "dashboard_auth_failed";
      event.authMode = "supabase";
      return jsonError("Unauthorized", 401, origin);
    }

    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId")?.trim();
    const conversationId = searchParams.get("conversationId")?.trim() || null;
    event.hasWorkspaceId = Boolean(workspaceId);
    event.hasConversationId = Boolean(conversationId);
    event.authMode = auth.authType === "bearer" ? "bearer" : "cookie";
    if (!workspaceId) {
      event.statusCode = 400;
      event.outcome = "denied";
      event.denialReason = "missing_workspace_id";
      return jsonError("workspaceId is required", 400, origin);
    }

    const hasAccess = await checkUserWorkspaceAccess(
      auth.supabase,
      auth.user.id,
      workspaceId
    );
    if (!hasAccess) {
      event.statusCode = 403;
      event.outcome = "denied";
      event.denialReason = "workspace_access_denied";
      return jsonError("Forbidden", 403, origin);
    }

    if (
      conversationId &&
      !(await conversationBelongsToWorkspace(conversationId, workspaceId))
    ) {
      event.statusCode = 403;
      event.outcome = "denied";
      event.denialReason = "conversation_workspace_mismatch";
      event.conversationBelongsToWorkspace = false;
      return jsonError("Forbidden", 403, origin);
    }
    event.conversationBelongsToWorkspace = conversationId ? true : undefined;

    if (conversationId) {
      const visibilityGate = await getCompanyConversationVisibilityGate(
        auth.supabase,
        workspaceId
      );
      if (!isConversationVisibleForPlan(visibilityGate, conversationId)) {
        event.statusCode = 403;
        event.outcome = "denied";
        event.denialReason = "conversation_not_visible";
        return jsonError("Forbidden", 403, origin);
      }
    }

    const issuedAtSeconds = Math.floor(Date.now() / 1_000);
    const expiresInSeconds = conversationId
      ? REALTIME_BOUNDED_TOKEN_MAX_TTL_SECONDS
      : TOKEN_TTL_SECONDS;
    const clientContract =
      auth.authType === "cookie" &&
      request.headers.get(REALTIME_CLIENT_CONTRACT_HEADER)?.trim() ===
        REALTIME_DASHBOARD_CLIENT_CONTRACT_V1
        ? REALTIME_DASHBOARD_CLIENT_CONTRACT_V1
        : undefined;

    const token = await signRealtimeToken(
      conversationId
        ? {
            kind: "conversation",
            workspaceId,
            conversationId,
            userId: auth.user.id,
            source: auth.authType === "bearer" ? "mobile" : "dashboard",
            ...(clientContract ? { clientContract } : {}),
          }
        : {
            kind: "workspace",
            workspaceId,
            userId: auth.user.id,
            source: auth.authType === "bearer" ? "mobile" : "dashboard",
            ...(clientContract ? { clientContract } : {}),
          },
      { expiresInSeconds, nowSeconds: issuedAtSeconds }
    );

    event.statusCode = 200;
    event.outcome = "success";
    return jsonTokenResponse(
      token,
      gatewayUrl,
      issuedAtSeconds,
      expiresInSeconds,
      origin
    );
  } catch (error) {
    event.statusCode = 500;
    event.outcome = "error";
    event.denialReason = "token_exception";
    return jsonError(
      error instanceof Error ? error.message : "Token error",
      500,
      origin
    );
  } finally {
    event.durationMs = Date.now() - startedAt;
    emitRealtimeTokenLog(event);
  }
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const startedAt = Date.now();
  const event: RealtimeTokenLogEvent = {
    method: "POST",
    route: "/api/realtime/token",
    requestId: getRequestId(request),
    originHost: getOriginHost(origin),
    statusCode: 500,
    outcome: "error",
    durationMs: 0,
    authMode: getVisitorAuthMode(request),
  };
  flushServerLogsAfterResponse();
  try {
    getRealtimeTokenSecret();
    const gatewayUrl = getRealtimeGatewayUrl();
    if (!gatewayUrl) {
      event.statusCode = 503;
      event.outcome = "denied";
      event.denialReason = "realtime_gateway_not_configured";
      event.code = REALTIME_GATEWAY_NOT_CONFIGURED_CODE;
      return jsonError(
        "Realtime gateway is not configured",
        503,
        origin,
        REALTIME_GATEWAY_NOT_CONFIGURED_CODE
      );
    }

    const body = (await request.json().catch(() => null)) as {
      workspaceId?: string;
      conversationId?: string;
      source?: string;
    } | null;
    const workspaceId = body?.workspaceId?.trim();
    const conversationId = body?.conversationId?.trim();
    event.hasWorkspaceId = Boolean(workspaceId);
    event.hasConversationId = Boolean(conversationId);
    if (!workspaceId || !conversationId || body?.source !== "widget") {
      event.statusCode = 400;
      event.outcome = "denied";
      event.denialReason = "invalid_widget_token_request";
      return jsonError(
        "workspaceId, conversationId, and source=widget are required",
        400,
        origin
      );
    }

    const visitorToken =
      request.headers.get("x-visitor-token") ||
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!visitorToken) {
      event.statusCode = 401;
      event.outcome = "denied";
      event.denialReason = "missing_visitor_token";
      event.code = WIDGET_VISITOR_TOKEN_MISSING_CODE;
      return jsonError(
        "Unauthorized",
        401,
        origin,
        WIDGET_VISITOR_TOKEN_MISSING_CODE
      );
    }

    const visitor = await verifyVisitorToken(visitorToken);
    event.visitorMatchesWorkspace = visitor?.workspaceId === workspaceId;
    if (!visitor) {
      event.statusCode = 403;
      event.outcome = "denied";
      event.denialReason = "invalid_visitor_token";
      event.code = WIDGET_VISITOR_TOKEN_INVALID_CODE;
      return jsonError(
        "Forbidden",
        403,
        origin,
        WIDGET_VISITOR_TOKEN_INVALID_CODE
      );
    }
    if (visitor.workspaceId !== workspaceId) {
      event.statusCode = 403;
      event.outcome = "denied";
      event.denialReason = "visitor_workspace_mismatch";
      event.code = WIDGET_VISITOR_WORKSPACE_MISMATCH_CODE;
      return jsonError(
        "Forbidden",
        403,
        origin,
        WIDGET_VISITOR_WORKSPACE_MISMATCH_CODE
      );
    }
    // Any visitor can mint a token for its own id, so the conversation must be
    // this visitor's widget thread, not merely one in the same workspace.
    const ownedByVisitor = await widgetVisitorOwnsConversation(
      conversationId,
      visitor
    );
    event.conversationOwnedByVisitor = ownedByVisitor;
    if (!ownedByVisitor) {
      event.statusCode = 404;
      event.outcome = "denied";
      event.denialReason = "widget_conversation_not_found";
      event.code = WIDGET_CONVERSATION_NOT_FOUND_CODE;
      return jsonError(
        "Conversation not found",
        404,
        origin,
        WIDGET_CONVERSATION_NOT_FOUND_CODE
      );
    }

    const issuedAtSeconds = Math.floor(Date.now() / 1_000);
    const token = await signRealtimeToken(
      {
        kind: "conversation",
        workspaceId,
        conversationId,
        source: "widget",
      },
      { expiresInSeconds: TOKEN_TTL_SECONDS, nowSeconds: issuedAtSeconds }
    );

    event.statusCode = 200;
    event.outcome = "success";
    return jsonTokenResponse(
      token,
      gatewayUrl,
      issuedAtSeconds,
      TOKEN_TTL_SECONDS,
      origin
    );
  } catch (error) {
    event.statusCode = 500;
    event.outcome = "error";
    event.denialReason = "token_exception";
    return jsonError(
      error instanceof Error ? error.message : "Token error",
      500,
      origin
    );
  } finally {
    event.durationMs = Date.now() - startedAt;
    emitRealtimeTokenLog(event);
  }
}

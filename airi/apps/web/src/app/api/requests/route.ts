import { validateOptionalConversationChannelParam } from "@/lib/api/conversation-channel-query";
import { parseRequestsListQuery } from "@/features/panel/requests/list-query";
import {
  getRequestsData,
  RequestsProjectionNotReadyError,
  type RequestQueryParams,
} from "@/features/panel/requests/data-projection";
import {
  getSupabaseRouteAuth,
  isSupabaseRouteAuthError,
} from "@/lib/supabase/route-auth";
import {
  createServerLogger,
  flushServerLogsAfterResponse,
  type ServerLogContext,
} from "@/lib/observability/server-logs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const requestsRealtimeLogger = createServerLogger("api.requests.realtime");

function getRequestId(request: Request): string | undefined {
  return (
    request.headers.get("x-vercel-id") ||
    request.headers.get("x-request-id") ||
    request.headers.get("x-correlation-id") ||
    undefined
  );
}

async function validateWorkspaceAccess(
  supabaseClient: SupabaseClient,
  userId: string,
  workspaceId: string
): Promise<boolean> {
  const { data: membership, error: membershipError } = await supabaseClient
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  return !membershipError && !!membership;
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const isRealtimeHydration =
    request.headers.get("x-airi-realtime-hydration") === "1";
  const logEvent: ServerLogContext = {
    method: "GET",
    route: "/api/requests",
    requestId: getRequestId(request),
    realtimeHydration: isRealtimeHydration,
    statusCode: 500,
    outcome: "error",
  };

  if (isRealtimeHydration) {
    flushServerLogsAfterResponse();
  }

  let caughtError: unknown;
  try {
    const { searchParams } = new URL(request.url);

    const auth = await getSupabaseRouteAuth(request);
    if (isSupabaseRouteAuthError(auth)) {
      logEvent.statusCode = 401;
      logEvent.outcome = "denied";
      logEvent.denialReason = "auth_failed";
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const supabaseClient = auth.supabase;
    const { user } = auth;

    const workspaceId = searchParams.get("workspaceId") || "";
    const includeChannels = searchParams.get("includeChannels") !== "false";
    logEvent.includeChannels = includeChannels;
    const countOnly =
      searchParams.get("countOnly") === "true" ||
      searchParams.get("countOnly") === "1";
    logEvent.countOnly = countOnly;
    const unread = searchParams.get("unread") === "true";
    const airiReplied = searchParams.get("airiReplied") === "true";
    const parsedPage = Number.parseInt(searchParams.get("page") || "", 10);
    const parsedLimit = Number.parseInt(searchParams.get("limit") || "", 10);
    const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 100)
        : 20;

    const conversationIdsParam = searchParams.get("conversationIds");
    const conversationIds =
      conversationIdsParam != null && conversationIdsParam.trim() !== ""
        ? conversationIdsParam
            .split(",")
            .map(id => id.trim())
            .filter(Boolean)
        : undefined;
    logEvent.conversationIdCount = conversationIds?.length || 0;
    logEvent.limit = limit;

    if (!workspaceId) {
      logEvent.statusCode = 400;
      logEvent.outcome = "denied";
      logEvent.denialReason = "missing_workspace_id";
      return NextResponse.json(
        { error: "workspaceId is required" },
        { status: 400 }
      );
    }

    const hasAccess = await validateWorkspaceAccess(
      supabaseClient,
      user.id,
      workspaceId
    );
    if (!hasAccess) {
      logEvent.statusCode = 403;
      logEvent.outcome = "denied";
      logEvent.denialReason = "workspace_access_denied";
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const channelCheck = validateOptionalConversationChannelParam(
      searchParams.get("channel")
    );
    if (!channelCheck.ok) {
      logEvent.statusCode = channelCheck.response.status;
      logEvent.outcome = "denied";
      logEvent.denialReason = "invalid_channel";
      return channelCheck.response;
    }

    const listQuery = parseRequestsListQuery(searchParams);

    const queryParams: Partial<RequestQueryParams> = {
      channel: channelCheck.value ?? null,
      filter: listQuery.filter,
      unread,
      category: searchParams.get("category"),
      internalLabel: searchParams.get("internalLabel"),
      status: listQuery.status,
      searchType: searchParams.get("searchType"),
      searchQuery: searchParams.get("searchQuery"),
      airiReplied,
      conversationIds,
      page,
      limit,
    };

    const response = await getRequestsData(
      workspaceId,
      queryParams,
      supabaseClient,
      {
        includeChannels,
        countOnly,
        bypassCache: isRealtimeHydration,
      }
    );
    logEvent.statusCode = 200;
    logEvent.outcome = "success";
    logEvent.returnedCount = Array.isArray(response.data)
      ? response.data.length
      : null;

    const cacheControl =
      isRealtimeHydration || countOnly || unread || airiReplied
        ? "private, no-store"
        : "private, max-age=5, stale-while-revalidate=10";

    return NextResponse.json(response, {
      headers: {
        "Cache-Control": cacheControl,
      },
    });
  } catch (error) {
    caughtError = error;
    const projectionNotReady =
      error instanceof RequestsProjectionNotReadyError ||
      (error instanceof Error &&
        (error as Error & { code?: string }).code ===
          "requests_projection_not_ready");
    logEvent.statusCode = projectionNotReady ? 503 : 500;
    logEvent.outcome = "error";
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: errorMessage },
      {
        status: projectionNotReady ? 503 : 500,
        headers: projectionNotReady
          ? { "Retry-After": "5", "Cache-Control": "private, no-store" }
          : undefined,
      }
    );
  } finally {
    if (isRealtimeHydration) {
      logEvent.durationMs = Date.now() - startedAt;
      if (logEvent.outcome === "error") {
        requestsRealtimeLogger.error(
          "Requests realtime hydration completed",
          caughtError,
          logEvent
        );
      } else if (logEvent.outcome === "denied") {
        requestsRealtimeLogger.warn(
          "Requests realtime hydration completed",
          logEvent
        );
      } else {
        requestsRealtimeLogger.info(
          "Requests realtime hydration completed",
          logEvent
        );
      }
    }
  }
}

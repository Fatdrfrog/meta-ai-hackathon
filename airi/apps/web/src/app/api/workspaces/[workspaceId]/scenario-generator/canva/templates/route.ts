import {
  buildCanvaTemplateSearchQuery,
  canvaConnectUrl,
  canvaCredentialsHaveBrandTemplateScope,
  canvaErrorRequiresReconnect,
  fetchCanvaBrandTemplates,
  normalizeCanvaBrandTemplatesResponse,
  readCanvaAccessToken,
  readCanvaRefreshToken,
  refreshCanvaAccessToken,
  mergeRefreshedCanvaCredentials,
} from "@/lib/canva/brand-templates";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { NextRequest, NextResponse } from "next/server";

type Params = Promise<{ workspaceId: string }>;

type TemplateSearchBody = {
  prompt?: string;
  blueprint?: {
    campaignName?: string;
  };
  query?: string;
  continuation?: string;
};

type CanvaSourceBuilder = {
  select: (columns: string) => CanvaSourceQuery;
};

type CanvaSourceQuery = {
  eq: (column: string, value: string) => CanvaSourceQuery;
  order: (column: string, options: { ascending: boolean }) => CanvaSourceQuery;
  limit: (count: number) => CanvaSourceQuery;
  maybeSingle: () => PromiseLike<{ data: unknown }>;
};

async function loadCanvaSource(supabase: unknown, workspaceId: string) {
  const client = supabase as { from: (table: string) => CanvaSourceBuilder };
  const { data } = await client
    .from("sources")
    .select("id, credentials")
    .eq("workspace_id", workspaceId)
    .eq("type", "canva")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data as {
    id: string;
    credentials?: Record<string, unknown> | null;
  } | null;
}

function connectionResponse(workspaceId: string, query: string) {
  return NextResponse.json({
    status: "connection_needed",
    query,
    items: [],
    continuation: null,
    connectUrl: canvaConnectUrl(workspaceId),
  });
}

function reconnectResponse(workspaceId: string, query: string) {
  return NextResponse.json({
    status: "reconnect_required",
    query,
    items: [],
    continuation: null,
    connectUrl: canvaConnectUrl(workspaceId),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;

  const body = (await request.json().catch(() => ({}))) as TemplateSearchBody;
  const query =
    String(body.query || "").trim() ||
    buildCanvaTemplateSearchQuery({
      prompt: String(body.prompt || ""),
      campaignName: body.blueprint?.campaignName,
    });
  const continuation = String(body.continuation || "").trim();

  const source = await loadCanvaSource(access.supabase, workspaceId);
  if (!source?.credentials) {
    return connectionResponse(workspaceId, query);
  }
  if (!canvaCredentialsHaveBrandTemplateScope(source.credentials)) {
    return reconnectResponse(workspaceId, query);
  }

  let credentials = source.credentials;
  let accessToken = readCanvaAccessToken(credentials);
  if (!accessToken) {
    return reconnectResponse(workspaceId, query);
  }

  let canvaResponse = await fetchCanvaBrandTemplates({
    accessToken,
    query,
    continuation,
  });

  if (canvaResponse.status === 401) {
    const refreshed = await refreshCanvaAccessToken({
      refreshToken: readCanvaRefreshToken(credentials),
    });
    if (!refreshed) return reconnectResponse(workspaceId, query);

    credentials = mergeRefreshedCanvaCredentials(credentials, refreshed);
    await access.supabase
      .from("sources")
      .update({ credentials })
      .eq("id", source.id)
      .eq("workspace_id", workspaceId);
    accessToken = refreshed.accessToken;
    canvaResponse = await fetchCanvaBrandTemplates({
      accessToken,
      query,
      continuation,
    });
  }

  if (!canvaResponse.ok) {
    const errorPayload = await canvaResponse.json().catch(() => null);
    if (canvaErrorRequiresReconnect(errorPayload)) {
      return reconnectResponse(workspaceId, query);
    }
    return NextResponse.json({
      status: "error",
      query,
      items: [],
      continuation: null,
      error: "Failed to fetch Canva brand templates",
    });
  }

  let normalized = normalizeCanvaBrandTemplatesResponse(
    await canvaResponse.json().catch(() => null)
  );

  if (!continuation && query && normalized.items.length === 0) {
    const fallbackResponse = await fetchCanvaBrandTemplates({
      accessToken,
    });
    if (fallbackResponse.ok) {
      normalized = normalizeCanvaBrandTemplatesResponse(
        await fallbackResponse.json().catch(() => null)
      );
    }
  }

  return NextResponse.json({
    status: "ok",
    query,
    ...normalized,
  });
}

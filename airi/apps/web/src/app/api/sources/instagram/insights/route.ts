import { decryptMaybeString } from "@/lib/crypto";
import { fetchSourceWithCredentials } from "@/lib/sources/utils";
import { createClient } from "@/lib/supabase/server";
import { resolveInstagramGraphBase } from "@icecore/shared/lib/meta/graph-version";
import { NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { requiredFieldResponse } from "@/lib/api/json-body";

const INSIGHTS_METRIC_SETS = [
  "views,reach,profile_views",
  "views,reach",
  "reach,profile_views",
  "views",
  "reach",
  "profile_views",
] as const;

function parseGrantedPermissions(raw: unknown): Set<string> {
  if (typeof raw !== "string") return new Set();
  return new Set(
    raw
      .split(/[,\s]+/)
      .map(value => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

function parseMetaErrorMessage(raw: string): string {
  if (!raw) return "Unknown Meta API error";
  try {
    const parsed = JSON.parse(raw) as {
      error?: {
        message?: string;
        type?: string;
        code?: number | string;
        error_subcode?: number | string;
      };
    };
    const message = parsed.error?.message?.trim();
    const type = String(parsed.error?.type || "").trim();
    const code = String(parsed.error?.code || "").trim();
    const subcode = String(parsed.error?.error_subcode || "").trim();
    const parts = [
      type,
      code ? `code ${code}` : "",
      subcode ? `subcode ${subcode}` : "",
      message,
    ]
      .filter(Boolean)
      .join(": ");
    return parts || raw.slice(0, 260);
  } catch {
    return raw.slice(0, 260);
  }
}

function isMetaPermissionDenied(details: string): boolean {
  const normalized = details.toLowerCase();
  return (
    normalized.includes("application does not have permission") ||
    normalized.includes("permission for this action") ||
    normalized.includes("code 10")
  );
}

function resolveInsightsGraphBase(authMethod: string): string {
  return resolveInstagramGraphBase(authMethod);
}

function resolveInsightsAccountId(
  authMethod: string,
  credentials: Record<string, unknown>
): string {
  const scopedId = String(credentials.instagram_scoped_id || "").trim();
  const businessId = String(
    credentials.instagram_business_account_id || ""
  ).trim();

  if (authMethod === "instagram_business_login") {
    return scopedId || businessId;
  }

  return businessId || scopedId;
}

function resolveRequiredInsightsPermissions(authMethod: string): string[] {
  if (authMethod === "instagram_business_login") {
    return ["instagram_business_manage_insights"];
  }
  return ["instagram_manage_insights", "pages_read_engagement"];
}

async function tryFetchInsights(params: {
  graphApiBase: string;
  instagramId: string;
  token: string;
  metrics: string;
}): Promise<{
  ok: boolean;
  data: unknown[];
  status: number;
  error?: string;
}> {
  const url = new URL(
    `${params.graphApiBase}/${encodeURIComponent(params.instagramId)}/insights`
  );
  url.searchParams.set("metric", params.metrics);
  url.searchParams.set("period", "day");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${params.token}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      ok: false,
      data: [],
      status: response.status,
      error: parseMetaErrorMessage(errorText),
    };
  }

  const payload = (await response.json().catch(() => ({}))) as {
    data?: unknown[];
  };
  return {
    ok: true,
    data: Array.isArray(payload.data) ? payload.data : [],
    status: response.status,
  };
}

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json(
        { error: "Forbidden or no workspace access" },
        { status: 403 }
      );
    }

    const source = await fetchSourceWithCredentials(undefined, "instagram", {
      workspace_id: workspaceId,
    });

    if (!source) {
      return NextResponse.json({ error: "No integration" }, { status: 404 });
    }

    const creds = source.credentials as Record<string, unknown>;
    const token = decryptMaybeString(creds.page_access_token);

    const authMethod = String(creds.auth_method || "");
    const grantedPermissions = parseGrantedPermissions(
      creds.granted_permissions
    );
    const requiredPermissions = resolveRequiredInsightsPermissions(authMethod);
    const missingPermissions = requiredPermissions.filter(
      permission =>
        grantedPermissions.size > 0 && !grantedPermissions.has(permission)
    );
    if (missingPermissions.length > 0) {
      return NextResponse.json({
        data: [],
        meta: {
          source: "local",
          status: 403,
          error: `Missing required permission(s): ${missingPermissions.join(", ")}. Reconnect Instagram and grant insights scopes.`,
          requiredPermissions,
          authMethod,
        },
      });
    }
    const instagramId = resolveInsightsAccountId(authMethod, creds);

    if (!token || !instagramId) {
      return NextResponse.json(
        { error: "Integration incomplete or missing IDs" },
        { status: 400 }
      );
    }

    const graphApiBase = resolveInsightsGraphBase(authMethod);

    let lastError:
      | {
          status: number;
          error: string;
          metrics: string;
        }
      | undefined;
    for (const metrics of INSIGHTS_METRIC_SETS) {
      const attempt = await tryFetchInsights({
        graphApiBase,
        instagramId,
        token,
        metrics,
      });
      if (attempt.ok) {
        return NextResponse.json({
          data: attempt.data,
          meta: {
            source: "meta",
            status: attempt.status,
            host: graphApiBase,
            metrics,
          },
        });
      }
      lastError = {
        status: attempt.status,
        error: attempt.error || "Unknown Meta API error",
        metrics,
      };
    }

    if (lastError) {
      console.warn("Instagram Insights API Error", {
        status: lastError.status,
        error: lastError.error,
        graphApiBase,
        metrics: lastError.metrics,
      });
      return NextResponse.json({
        data: [],
        meta: {
          source: "meta",
          status: lastError.status,
          error: isMetaPermissionDenied(lastError.error)
            ? `${lastError.error}. Required permission(s): ${requiredPermissions.join(", ")}. Reconnect Instagram to issue a token with these scopes. If app is in Development mode, connect with a Meta app role account (Admin/Developer/Tester).`
            : lastError.error,
          host: graphApiBase,
          metrics: lastError.metrics,
          requiredPermissions,
          authMethod,
        },
      });
    }

    return NextResponse.json({ data: [] });
  } catch (error: unknown) {
    console.error("Instagram Insights Error:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}

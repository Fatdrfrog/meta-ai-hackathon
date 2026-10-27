import { completeMetaAdsMcpOAuth } from "@/lib/meta-ads/mcp/complete-mcp-oauth";
import {
  META_ADS_MCP_OAUTH_COOKIE_PREFIX,
  META_ADS_SOURCE_TYPE,
} from "@/lib/meta-ads/meta-ads-source";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

function redirectToIntegrations(
  requestUrl: string,
  workspaceId: string,
  params: Record<string, string>
) {
  const url = new URL(
    `/panel/w/${workspaceId}/settings/integrations`,
    requestUrl
  );
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url.toString());
}

function clearMcpOAuthCookies(response: NextResponse) {
  response.cookies.delete(`${META_ADS_MCP_OAUTH_COOKIE_PREFIX}_oauth_state`);
  response.cookies.delete(
    `${META_ADS_MCP_OAUTH_COOKIE_PREFIX}_oauth_workspace_id`
  );
  response.cookies.delete(
    `${META_ADS_MCP_OAUTH_COOKIE_PREFIX}_oauth_redirect_uri`
  );
}

// OAuth providers redirect with GET; state cookie, user session, and workspace membership are verified before persistence.
// react-doctor-disable-next-line react-doctor/nextjs-no-side-effect-in-get-handler
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = (searchParams.get("code") || "").trim();
  const state = (searchParams.get("state") || "").trim();
  const cookieState =
    request.cookies.get(`${META_ADS_MCP_OAUTH_COOKIE_PREFIX}_oauth_state`)
      ?.value || "";
  const workspaceId =
    request.cookies.get(
      `${META_ADS_MCP_OAUTH_COOKIE_PREFIX}_oauth_workspace_id`
    )?.value || "";
  const redirectUri =
    request.cookies.get(
      `${META_ADS_MCP_OAUTH_COOKIE_PREFIX}_oauth_redirect_uri`
    )?.value || "";

  if (
    !code ||
    !state ||
    state !== cookieState ||
    !workspaceId ||
    !redirectUri
  ) {
    const response = redirectToIntegrations(request.url, workspaceId || "", {
      integration: META_ADS_SOURCE_TYPE,
      error: "mcp_oauth_failed",
    });
    clearMcpOAuthCookies(response);
    return response;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    const response = redirectToIntegrations(request.url, workspaceId, {
      integration: META_ADS_SOURCE_TYPE,
      error: "unauthorized",
    });
    clearMcpOAuthCookies(response);
    return response;
  }

  const hasAccess = await checkUserWorkspaceAccess(
    supabase,
    user.id,
    workspaceId
  );
  if (!hasAccess) {
    const response = redirectToIntegrations(request.url, workspaceId, {
      integration: META_ADS_SOURCE_TYPE,
      error: "forbidden",
    });
    clearMcpOAuthCookies(response);
    return response;
  }

  const result = await completeMetaAdsMcpOAuth({
    supabase,
    workspaceId,
    code,
    redirectUri,
    allowCreateGraphSource: false,
  });

  if (!result.ok) {
    const response = redirectToIntegrations(request.url, workspaceId, {
      integration: META_ADS_SOURCE_TYPE,
      error: result.error,
      ...(result.errorDetails
        ? { error_details: result.errorDetails }
        : {}),
    });
    clearMcpOAuthCookies(response);
    return response;
  }

  const response = redirectToIntegrations(request.url, workspaceId, {
    integration: META_ADS_SOURCE_TYPE,
    success: "mcp_connected",
  });
  clearMcpOAuthCookies(response);
  return response;
}

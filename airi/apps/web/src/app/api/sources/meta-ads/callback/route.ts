import {
  getMetaAdsAppConfig,
  resolveMetaAdsLoginConfigId,
} from "@/lib/meta-ads/meta-ads-login-config";
import {
  META_ADS_OAUTH_COOKIE_PREFIX,
  META_ADS_SOURCE_TYPE,
} from "@/lib/meta-ads/meta-ads-source";
import { completeMetaAdsMcpOAuth } from "@/lib/meta-ads/mcp/complete-mcp-oauth";
import {
  createServerLogger,
  flushServerLogsAfterResponse,
  type ServerLogContext,
} from "@/lib/observability/server-logs";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

const logger = createServerLogger("meta-ads.callback");

function redirectToIntegrations(
  requestUrl: string,
  workspaceId: string,
  params: Record<string, string>
) {
  const url = new URL(
    `/panel/w/${workspaceId}/settings/integrations`,
    requestUrl
  );
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  const response = NextResponse.redirect(url.toString());
  for (const suffix of ["state", "workspace_id", "redirect_uri"])
    response.cookies.delete(`${META_ADS_OAUTH_COOKIE_PREFIX}_oauth_${suffix}`);
  return response;
}

// OAuth providers redirect with GET; state, session and membership are checked before persistence.
// react-doctor-disable-next-line react-doctor/nextjs-no-side-effect-in-get-handler
export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const diagnostics: ServerLogContext = { outcome: "exception" };
  flushServerLogsAfterResponse();
  try {
    const response = await completeCallback(request, diagnostics);
    const location = response.headers.get("location");
    if (location) {
      const params = new URL(location).searchParams;
      diagnostics.outcome = params.get("error") || params.get("success");
    }
    return response;
  } finally {
    logger.info("meta_ads_callback_completed", {
      ...diagnostics,
      durationMs: Date.now() - startedAt,
    });
  }
}

async function completeCallback(
  request: NextRequest,
  diagnostics: ServerLogContext
) {
  const search = new URL(request.url).searchParams;
  const code = (search.get("code") || "").trim();
  const state = (search.get("state") || "").trim();
  const cookie = (suffix: string) =>
    request.cookies.get(`${META_ADS_OAUTH_COOKIE_PREFIX}_oauth_${suffix}`)
      ?.value || "";
  const workspaceId = cookie("workspace_id");
  const redirectUri = cookie("redirect_uri");
  const redirect = (params: Record<string, string>) =>
    redirectToIntegrations(request.url, workspaceId, {
      integration: META_ADS_SOURCE_TYPE,
      ...params,
    });
  if (
    !code ||
    !state ||
    state !== cookie("state") ||
    !workspaceId ||
    !redirectUri
  )
    return redirect({ error: "oauth_failed" });
  const config = getMetaAdsAppConfig();
  if (!config) return redirect({ error: "server_not_configured" });
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirect({ error: "unauthorized" });
  if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId)))
    return redirect({ error: "forbidden" });
  diagnostics.workspaceId = workspaceId;
  diagnostics.appId = config.appId;
  diagnostics.callbackLoginConfigId = resolveMetaAdsLoginConfigId();
  const result = await completeMetaAdsMcpOAuth({
    supabase,
    workspaceId,
    code,
    redirectUri,
    allowCreateGraphSource: true,
    intent: "reporting",
  });
  if (!result.ok) return redirect({ error: result.error });
  diagnostics.adAccountCount = result.adAccounts.length;
  return redirect({ success: "connected" });
}

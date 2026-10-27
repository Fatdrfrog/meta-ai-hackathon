import { CANVA_BRAND_TEMPLATE_SCOPE } from "@/lib/canva/brand-templates";
import { encryptString } from "@/lib/crypto";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getCompanyIdForWorkspace } from "@/lib/supabase/company-users";
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

type CanvaTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

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

async function exchangeCanvaCode(params: {
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<CanvaTokenResponse | null> {
  const clientId = (process.env.CANVA_CLIENT_ID || "").trim();
  const clientSecret = (process.env.CANVA_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) return null;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    code_verifier: params.verifier,
    redirect_uri: params.redirectUri,
  });
  const response = await fetch("https://api.canva.com/rest/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as CanvaTokenResponse | null;
}

// OAuth providers redirect with GET; state cookie, user session, and workspace membership are verified before persistence.
// react-doctor-disable-next-line react-doctor/nextjs-no-side-effect-in-get-handler
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = (searchParams.get("code") || "").trim();
  const state = (searchParams.get("state") || "").trim();
  const cookieState = request.cookies.get("canva_oauth_state")?.value || "";
  const verifier = request.cookies.get("canva_oauth_verifier")?.value || "";
  const workspaceId =
    request.cookies.get("canva_oauth_workspace_id")?.value || "";
  const redirectUri =
    request.cookies.get("canva_oauth_redirect_uri")?.value || "";

  if (
    !code ||
    !state ||
    state !== cookieState ||
    !workspaceId ||
    !verifier ||
    !redirectUri
  ) {
    return redirectToIntegrations(request.url, workspaceId || "", {
      integration: "canva",
      error: "oauth_failed",
    });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return redirectToIntegrations(request.url, workspaceId, {
      integration: "canva",
      error: "unauthorized",
    });
  }

  const hasAccess = await checkUserWorkspaceAccess(
    supabase,
    user.id,
    workspaceId
  );
  if (!hasAccess) {
    return redirectToIntegrations(request.url, workspaceId, {
      integration: "canva",
      error: "forbidden",
    });
  }

  const token = await exchangeCanvaCode({ code, verifier, redirectUri });
  if (!token?.access_token) {
    return redirectToIntegrations(request.url, workspaceId, {
      integration: "canva",
      error: "token_exchange_failed",
    });
  }

  const companyId = await getCompanyIdForWorkspace(supabase, workspaceId);
  if (!companyId) {
    return redirectToIntegrations(request.url, workspaceId, {
      integration: "canva",
      error: "workspace_missing",
    });
  }

  const connectedAt = new Date().toISOString();
  const credentials: Record<string, unknown> = {
    access_token: encryptString(token.access_token),
    expires_at: token.expires_in
      ? new Date(Date.now() + token.expires_in * 1000).toISOString()
      : null,
    scope: token.scope || CANVA_BRAND_TEMPLATE_SCOPE,
    token_type: token.token_type || "Bearer",
    connected_at: connectedAt,
  };
  if (token.refresh_token) {
    credentials.refresh_token = encryptString(token.refresh_token);
  }

  const { data: existingSource, error: existingSourceError } =
    await supabaseAdmin
      .from("sources")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("type", "canva")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

  if (existingSourceError) {
    console.error("[canva.callback] failed to load existing source", {
      workspaceId,
      code: existingSourceError.code,
      message: existingSourceError.message,
    });
    return redirectToIntegrations(request.url, workspaceId, {
      integration: "canva",
      error: "save_failed",
    });
  }

  const saveResult = existingSource?.id
    ? await supabaseAdmin
        .from("sources")
        .update({ name: "Canva", credentials })
        .eq("id", existingSource.id)
    : await supabaseAdmin.from("sources").insert({
        company_id: companyId,
        workspace_id: workspaceId,
        type: "canva",
        name: "Canva",
        credentials,
      });

  if (saveResult.error) {
    console.error("[canva.callback] failed to save source", {
      workspaceId,
      code: saveResult.error.code,
      message: saveResult.error.message,
    });
    return redirectToIntegrations(request.url, workspaceId, {
      integration: "canva",
      error: "save_failed",
    });
  }

  const response = redirectToIntegrations(request.url, workspaceId, {
    integration: "canva",
    success: "connected",
  });
  response.cookies.delete("canva_oauth_state");
  response.cookies.delete("canva_oauth_verifier");
  response.cookies.delete("canva_oauth_workspace_id");
  response.cookies.delete("canva_oauth_redirect_uri");
  return response;
}

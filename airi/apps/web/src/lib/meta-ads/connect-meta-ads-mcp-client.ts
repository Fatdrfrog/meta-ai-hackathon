import {
  createFacebookLoginCallback,
  loadFacebookSDK,
  type FacebookLoginResponse,
} from "@/lib/facebook-sdk";
import type {
  MetaAdsAdAccount,
  MetaAdsMcpReadiness,
} from "@icecore/shared/types/sources";
import type { MetaAdsReportingReadiness } from "./meta-ads-reporting-readiness";
import type { MetaAdsConnectionIntent } from "./mcp/complete-mcp-oauth";

export type MetaAdsMcpSessionPayload = {
  appConfigured: boolean;
  configId: string | null;
  reportingConfigId: string | null;
  reporting: MetaAdsReportingReadiness;
  adAccounts: MetaAdsAdAccount[];
  selectedAdAccountId: string | null;
  hasMetaAdsSource: boolean;
  canConnect: boolean;
  readiness: MetaAdsMcpReadiness;
};

export type ConnectMetaAdsMcpResult =
  | {
      ok: true;
      createdSource: boolean;
      readiness: MetaAdsMcpReadiness;
      reportingReady: boolean;
      reporting: MetaAdsReportingReadiness;
      adAccounts: MetaAdsAdAccount[];
      selectedAdAccountId: string;
    }
  | { ok: false; cancelled?: boolean; error: string; errorCode?: string };

type ApiErrorPayload = { error?: string; error_details?: string };

export function getMetaAdsMcpSessionSWRKey(workspaceId: string): string {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) return "";
  return `/api/sources/meta-ads/mcp/session?workspaceId=${encodeURIComponent(normalizedWorkspaceId)}`;
}

async function readJson<T>(response: Response): Promise<T | null> {
  return response.json().catch(() => null) as Promise<T | null>;
}

async function readSessionResponse(
  response: Response,
  fallbackError: string
): Promise<MetaAdsMcpSessionPayload> {
  const body = await readJson<MetaAdsMcpSessionPayload & ApiErrorPayload>(
    response
  );
  if (!response.ok || !body?.readiness) {
    throw new Error(body?.error_details || body?.error || fallbackError);
  }
  return body;
}

export async function fetchMetaAdsMcpSession(params: {
  workspaceId: string;
  probe?: boolean;
}): Promise<MetaAdsMcpSessionPayload> {
  const sessionKey = getMetaAdsMcpSessionSWRKey(params.workspaceId);
  if (!sessionKey) throw new Error("workspaceId is required");
  const url = params.probe ? `${sessionKey}&probe=1` : sessionKey;
  const response = await fetch(url, {
    cache: "no-store",
  });
  return readSessionResponse(response, "Failed to load Meta Ads MCP session");
}

export async function selectMetaAdsMcpAccount(params: {
  workspaceId: string;
  adAccountId: string;
}): Promise<MetaAdsMcpSessionPayload> {
  const workspaceId = params.workspaceId.trim();
  const adAccountId = params.adAccountId.trim();
  if (!workspaceId || !adAccountId) {
    throw new Error("workspaceId and adAccountId are required");
  }
  const response = await fetch("/api/sources/meta-ads/mcp/session", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ workspaceId, adAccountId }),
  });
  return readSessionResponse(response, "Failed to select Meta Ads account");
}

async function requestMetaAdsMcpAuthCode(configId: string): Promise<{
  code: string | null;
  cancelled: boolean;
  error?: string;
}> {
  try {
    const facebookSdk = await loadFacebookSDK();
    return await new Promise(resolve => {
      facebookSdk.login(
        createFacebookLoginCallback(
          async (response: FacebookLoginResponse) => {
            const code = response.authResponse?.code?.trim() || "";
            if (!code) {
              resolve({
                code: null,
                cancelled: true,
                error: "Meta login was cancelled",
              });
              return;
            }
            resolve({ code, cancelled: false });
          },
          error => {
            resolve({
              code: null,
              cancelled: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Facebook login failed",
            });
          }
        ),
        {
          config_id: configId,
          auth_type: "rerequest",
          response_type: "code",
          override_default_response_type: true,
        }
      );
    });
  } catch (error) {
    return {
      code: null,
      cancelled: false,
      error:
        error instanceof Error ? error.message : "Facebook SDK failed to load",
    };
  }
}

/**
 * In-page Meta Ads MCP connect via FB.login popup (same SDK pattern as
 * WhatsApp Embedded Signup, without WA extras / redirect away from the page).
 */
export async function connectMetaAdsMcpViaFacebookSdk(params: {
  workspaceId: string;
  /** When no Meta Ads source exists, create Graph + MCP from the same token. */
  allowCreateGraphSource?: boolean;
  intent?: MetaAdsConnectionIntent;
}): Promise<ConnectMetaAdsMcpResult> {
  const workspaceId = params.workspaceId.trim();
  if (!workspaceId) {
    return { ok: false, error: "workspaceId is required" };
  }

  let session: MetaAdsMcpSessionPayload;
  try {
    session = await fetchMetaAdsMcpSession({ workspaceId });
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to load Meta Ads MCP session",
    };
  }

  const intent = params.intent ?? "ai_ads";
  const configId = (
    (intent === "reporting" ? session.reportingConfigId : session.configId) ||
    ""
  ).trim();
  if (!configId) {
    return {
      ok: false,
      errorCode: "server_not_configured",
      error:
        "Meta Ads Login for Business is not configured. Set META_ADS_MCP_LOGIN_CONFIG_ID or META_ADS_LOGIN_CONFIG_ID.",
    };
  }

  const auth = await requestMetaAdsMcpAuthCode(configId);
  if (!auth.code) {
    return {
      ok: false,
      cancelled: auth.cancelled,
      error: auth.error || "Meta login failed",
    };
  }

  const completeResponse = await fetch("/api/sources/meta-ads/mcp/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId,
      code: auth.code,
      allowCreateGraphSource: params.allowCreateGraphSource === true,
      intent,
    }),
  });
  const complete = await readJson<
    {
      success?: boolean;
      createdSource?: boolean;
      readiness?: MetaAdsMcpReadiness;
      reportingReady?: boolean;
      reporting?: MetaAdsReportingReadiness;
      adAccounts?: MetaAdsAdAccount[];
      selectedAdAccountId?: string;
    } & ApiErrorPayload
  >(completeResponse);

  if (
    !completeResponse.ok ||
    !complete?.success ||
    !complete.readiness ||
    !complete.reporting ||
    !complete.selectedAdAccountId
  ) {
    return {
      ok: false,
      errorCode: complete?.error,
      error:
        complete?.error_details ||
        complete?.error ||
        "Failed to enable Meta Ads MCP",
    };
  }

  // Graph access is already committed. Optional provider availability must not
  // turn a successful reporting authorization into a failed connection.
  let readiness = complete.readiness;
  if (intent === "ai_ads" && readiness.missingReadScopes.length === 0) {
    try {
      readiness = (await fetchMetaAdsMcpSession({ workspaceId, probe: true }))
        .readiness;
    } catch {
      // The saved stale readiness accurately offers a later provider recheck.
    }
  }

  return {
    ok: true,
    createdSource: Boolean(complete.createdSource),
    readiness,
    reportingReady: complete.reporting.canRead,
    reporting: complete.reporting,
    adAccounts: complete.adAccounts ?? [],
    selectedAdAccountId: complete.selectedAdAccountId,
  };
}

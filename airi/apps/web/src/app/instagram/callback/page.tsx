"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

function extractWorkspaceIdFromState(state: string): string | null {
  const parts = state.split(":");
  if (parts.length < 2) {
    return null;
  }
  const workspaceId = parts[parts.length - 1];
  return workspaceId || null;
}

function buildIntegrationsRedirect(
  workspaceId: string | null,
  params: Record<string, string>
) {
  const query = new URLSearchParams({
    type: "instagram",
    integration: "instagram",
    ...params,
  });

  if (!workspaceId) {
    return `/panel?${query.toString()}`;
  }

  return `/panel/w/${workspaceId}/settings/integrations?${query.toString()}`;
}

export default function InstagramCallbackPage() {
  const [status, setStatus] = useState("Finishing Instagram connection...");

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const currentUrl = new URL(window.location.href);
      const hashParams = new URLSearchParams(currentUrl.hash.replace(/^#/, ""));
      const queryParams = currentUrl.searchParams;

      const hasHashAccessToken =
        !!hashParams.get("access_token") ||
        !!hashParams.get("long_lived_token");
      const hasQueryOAuthPayload =
        !!queryParams.get("code") ||
        !!queryParams.get("error") ||
        !!queryParams.get("error_reason") ||
        !!queryParams.get("error_description");

      // Instagram direct login returns query params (code/error) and must be
      // completed on the server callback.
      if (hasQueryOAuthPayload && !hasHashAccessToken) {
        window.location.replace(
          `/api/sources/instagram/callback${currentUrl.search || ""}`
        );
        return;
      }

      const getParam = (key: string) =>
        hashParams.get(key) || queryParams.get(key) || "";

      const state = getParam("state");
      const workspaceFromState = extractWorkspaceIdFromState(state);
      const oauthError = getParam("error");
      const oauthErrorDetails =
        getParam("error_description") ||
        getParam("error_reason") ||
        getParam("error_message");

      if (oauthError) {
        window.location.replace(
          buildIntegrationsRedirect(workspaceFromState, {
            error: "oauth_failed",
            ...(oauthErrorDetails
              ? { error_details: oauthErrorDetails.slice(0, 250) }
              : {}),
          })
        );
        return;
      }

      const payload = {
        state,
        access_token: getParam("access_token"),
        long_lived_token: getParam("long_lived_token"),
        expires_in: getParam("expires_in"),
        data_access_expiration_time: getParam("data_access_expiration_time"),
        page_id: getParam("page_id"),
        instagram_account_id: getParam("instagram_account_id"),
      };

      try {
        if (!cancelled) {
          setStatus("Saving connected account...");
        }

        const res = await fetch("/api/sources/instagram/facebook-callback", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        const data = (await res.json().catch(() => ({}))) as {
          workspaceId?: string;
          error?: string;
          error_details?: string;
          warning?: string;
          warning_details?: string;
        };

        const workspaceId = data.workspaceId || workspaceFromState;
        if (!res.ok || data.error) {
          window.location.replace(
            buildIntegrationsRedirect(workspaceId || null, {
              error: data.error || "facebook_login_failed",
              ...(data.error_details
                ? { error_details: data.error_details.slice(0, 250) }
                : {}),
            })
          );
          return;
        }

        const nextParams: Record<string, string> = { new: "true" };
        if (data.warning) {
          nextParams.warning = data.warning;
        }
        if (data.warning_details) {
          nextParams.warning_details = data.warning_details.slice(0, 250);
        }

        window.location.replace(
          buildIntegrationsRedirect(workspaceId || null, nextParams)
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "unknown_error";
        window.location.replace(
          buildIntegrationsRedirect(workspaceFromState, {
            error: "facebook_login_failed",
            error_details: message.slice(0, 250),
          })
        );
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{status}</span>
      </div>
    </div>
  );
}

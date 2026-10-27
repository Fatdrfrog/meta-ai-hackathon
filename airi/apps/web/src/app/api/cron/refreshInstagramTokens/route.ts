import { verifyCronAuth } from "@/lib/cron-auth";
import { decryptMaybeString, encryptString } from "@/lib/crypto";
import { checkTokenExpiryAndAlert } from "@/lib/notifications/check-token-expiry";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { META_GRAPH_BASE_URL } from "@icecore/shared/lib/meta/graph-version";
import type { InstagramSource } from "@icecore/shared/types/sources";
import { NextResponse } from "next/server";

// Meta recommends exchanging long-lived tokens before expiry to avoid interruption.
// For Instagram login, long-lived tokens are generally 60 days.

async function refreshInstagramLongLivedToken(
  currentToken: string
): Promise<{ access_token: string; expires_in?: number } | null> {
  try {
    const url = new URL("https://graph.instagram.com/refresh_access_token");
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", currentToken);
    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function refreshLegacyFacebookToken(
  currentToken: string
): Promise<{ access_token: string; expires_in?: number } | null> {
  try {
    const appId =
      process.env.NEXT_PUBLIC_INSTAGRAM_APP_ID ||
      process.env.NEXT_PUBLIC_META_APP_ID ||
      "";
    const appSecret =
      process.env.META_APP_SECRET ||
      process.env.NEXT_PUBLIC_META_APP_SECRET ||
      "";
    if (!appId || !appSecret) return null;

    const url = new URL(`${META_GRAPH_BASE_URL}/oauth/access_token`);
    url.searchParams.set("grant_type", "fb_exchange_token");
    url.searchParams.set("client_id", appId);
    url.searchParams.set("client_secret", appSecret);
    url.searchParams.set("fb_exchange_token", currentToken);
    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function refreshLongLivedToken(
  currentToken: string
): Promise<{ access_token: string; expires_in?: number } | null> {
  const instagramRefresh = await refreshInstagramLongLivedToken(currentToken);
  if (instagramRefresh?.access_token) return instagramRefresh;
  return refreshLegacyFacebookToken(currentToken);
}

export async function GET(request: Request) {
  const denied = verifyCronAuth(request);
  if (denied) return denied;

  try {
    const { data: sources } = await supabaseAdmin
      .from("sources")
      .select("id, workspace_id, credentials")
      .eq("type", "instagram");

    if (!sources || sources.length === 0)
      return NextResponse.json({ ok: true, refreshed: 0 });

    let refreshed = 0;
    let warnings = 0;
    for (const s of sources as InstagramSource[]) {
      const creds = s.credentials;
      if (!creds.page_access_token) continue;

      if (creds.token_expires_at) {
        const { alertSent } = await checkTokenExpiryAndAlert({
          tokenExpiresAt: creds.token_expires_at,
          workspaceId: s.workspace_id,
          integrationType: "instagram",
          logPrefix: "[Instagram Token]",
        });
        if (alertSent) warnings++;
      }

      if (creds.auth_method === "facebook_login") {
        // Facebook Login flow stores a Page token and does not support IG token refresh.
        continue;
      }

      const token = decryptMaybeString(creds.page_access_token);
      if (!token) {
        continue;
      }

      const exchanged = await refreshLongLivedToken(token);
      if (!exchanged?.access_token) continue;

      const newExpiresAt = exchanged.expires_in
        ? new Date(Date.now() + exchanged.expires_in * 1000).toISOString()
        : null;
      const tokenChanged = exchanged.access_token !== token;
      const expiryChanged =
        !!newExpiresAt && newExpiresAt !== creds.token_expires_at;

      if (!tokenChanged && !expiryChanged) continue;

      const updatedCredentials = {
        ...creds,
        page_access_token: tokenChanged
          ? encryptString(exchanged.access_token)
          : creds.page_access_token,
        ...(newExpiresAt && { token_expires_at: newExpiresAt }),
      };

      await supabaseAdmin
        .from("sources")
        .update({ credentials: updatedCredentials })
        .eq("id", s.id);

      refreshed++;
      console.log(
        `[Instagram Token] Refreshed for workspace ${s.workspace_id}, expires: ${newExpiresAt}`
      );
    }

    return NextResponse.json({ ok: true, refreshed, warnings });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
    });
  }
}

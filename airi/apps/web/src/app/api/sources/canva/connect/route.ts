import { CANVA_BRAND_TEMPLATE_SCOPE } from "@/lib/canva/brand-templates";
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { requiredFieldResponse } from "@/lib/api/json-body";

function resolveCanvaRedirectUri(origin: string): string {
  const configured = (process.env.CANVA_REDIRECT_URI || "").trim();
  if (configured) return configured;
  const base = (process.env.NEXT_PUBLIC_APP_URL || origin)
    .trim()
    .replace(/\/$/, "");
  return `${base}/api/sources/canva/callback`;
}

function base64Url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// OAuth initiation must be a navigable GET and only stores HttpOnly PKCE/state cookies after auth/workspace checks.
// react-doctor-disable-next-line react-doctor/nextjs-no-side-effect-in-get-handler
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const workspaceId = (searchParams.get("workspaceId") || "").trim();
  if (!workspaceId) return requiredFieldResponse("workspaceId");

  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;

  const clientId = (process.env.CANVA_CLIENT_ID || "").trim();
  if (!clientId) {
    return NextResponse.json(
      { error: "Canva OAuth is not configured" },
      { status: 500 }
    );
  }

  const verifier = base64Url(crypto.randomBytes(64));
  const challenge = base64Url(
    crypto.createHash("sha256").update(verifier).digest()
  );
  const state = base64Url(crypto.randomBytes(24));
  const redirectUri = resolveCanvaRedirectUri(origin);
  const url = new URL("https://www.canva.com/api/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", CANVA_BRAND_TEMPLATE_SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  const response = NextResponse.redirect(url.toString());
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 15,
  };
  response.cookies.set({
    ...cookieOptions,
    name: "canva_oauth_state",
    value: state,
  });
  response.cookies.set({
    ...cookieOptions,
    name: "canva_oauth_verifier",
    value: verifier,
  });
  response.cookies.set({
    ...cookieOptions,
    name: "canva_oauth_workspace_id",
    value: workspaceId,
  });
  response.cookies.set({
    ...cookieOptions,
    name: "canva_oauth_redirect_uri",
    value: redirectUri,
  });
  return response;
}

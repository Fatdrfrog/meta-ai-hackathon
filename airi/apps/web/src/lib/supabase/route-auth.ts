import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createClient as createCookieClient } from "./server";
import { getSupabasePublicKey } from "./public-key";

export type SupabaseRouteAuthContext = {
  supabase: SupabaseClient;
  user: User;
  accessToken?: string;
  authType: "bearer" | "cookie";
};

export type SupabaseRouteAuthResult =
  | SupabaseRouteAuthContext
  | {
      error: "Unauthorized";
      status: 401;
    };

function getBearerToken(request?: Request): string | null {
  const authorization = request?.headers.get("authorization")?.trim();
  if (!authorization) return null;

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token || null;
}

function createBearerClient(accessToken: string): SupabaseClient {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    getSupabasePublicKey(),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    }
  );
}

export async function getSupabaseRouteAuth(
  request?: Request
): Promise<SupabaseRouteAuthResult> {
  const accessToken = getBearerToken(request);

  if (accessToken) {
    const supabase = createBearerClient(accessToken);
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(accessToken);

    if (error || !user) {
      return { error: "Unauthorized", status: 401 };
    }

    return {
      supabase,
      user,
      accessToken,
      authType: "bearer",
    };
  }

  const supabase = await createCookieClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Unauthorized", status: 401 };
  }

  return {
    supabase,
    user,
    authType: "cookie",
  };
}

export function isSupabaseRouteAuthError(
  result: SupabaseRouteAuthResult
): result is Extract<SupabaseRouteAuthResult, { error: string }> {
  return "error" in result;
}

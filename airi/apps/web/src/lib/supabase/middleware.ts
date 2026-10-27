import { createServerClient } from "@supabase/ssr";
import { isAuthRetryableFetchError, type User } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabasePublicKey } from "./public-key";

/**
 * Asks once more when the auth server could not be reached or failed (a
 * network error or 5xx), never for a missing or invalid session, so one
 * transient failure does not send a signed-in user to login. A failed token
 * refresh is not asked again: auth-js already retried it with backoff and
 * keeps that answer on this client for a moment.
 */
async function getUserAllowingOneTransientFailure(
  supabase: ReturnType<typeof createServerClient>
): Promise<User | null> {
  const first = await supabase.auth.getUser();
  if (first.data.user || !isAuthRetryableFetchError(first.error)) {
    return first.data.user;
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function updateSessionWithUser(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });
  const supabaseHeaders = new Headers();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    getSupabasePublicKey(),
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options?: object }[],
          headers?: Record<string, string>
        ) {
          cookiesToSet.forEach(
            ({ name, value }: { name: string; value: string }) =>
              request.cookies.set(name, value)
          );
          // The SDK sends cache headers only with its first cookie write.
          // Keep them when a later refresh replaces this request's response.
          if (headers) {
            Object.entries(headers).forEach(([key, value]) => {
              supabaseHeaders.set(key, value);
            });
          }
          supabaseResponse = NextResponse.next({
            request,
            headers: supabaseHeaders,
          });
          cookiesToSet.forEach(
            ({
              name,
              value,
              options,
            }: {
              name: string;
              value: string;
              options?: object;
            }) => supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );
  // Do not run code between createServerClient and
  // supabase.auth.getUser(). A simple mistake could make it very hard to debug
  // issues with users being randomly logged out.
  // IMPORTANT: DO NOT REMOVE auth.getUser()
  const user = await getUserAllowingOneTransientFailure(supabase);

  // Middleware session sync should not enforce route-level auth.
  // Access control is handled in proxy.ts (e.g. /panel only).
  return {
    supabase,
    user,
    // Later queries on this same client may refresh cookies again. Always
    // expose the latest response built by setAll, including its cache headers.
    get response() {
      return supabaseResponse;
    },
  };
}

export async function updateSession(request: NextRequest) {
  const session = await updateSessionWithUser(request);
  return session.response;
}

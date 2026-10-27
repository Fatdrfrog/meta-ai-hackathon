import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabasePublicKey } from "./public-key";

// Utility function to safely get cookies
async function getCookieStore() {
  try {
    return await cookies();
  } catch {
    return null;
  }
}

// Safe cookie setter that won't throw errors
function safeSetCookie(
  cookieStore: unknown,
  name: string,
  value: string,
  options: unknown
) {
  try {
    // Type-safe way to call set method
    if (
      cookieStore &&
      typeof cookieStore === "object" &&
      "set" in cookieStore &&
      typeof cookieStore.set === "function"
    ) {
      cookieStore.set(name, value, options);
    }
  } catch {}
}

export async function createClient() {
  const cookieStore = await getCookieStore();

  // Always create a client with safe cookie handling
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    getSupabasePublicKey(),
    {
      cookies: {
        getAll: () => {
          try {
            return cookieStore?.getAll() || [];
          } catch {
            return [];
          }
        },
        setAll: (
          cookies: { name: string; value: string; options?: unknown }[]
        ) => {
          // Only attempt to set cookies if we have a cookie store
          if (cookieStore) {
            cookies.forEach(
              ({
                name,
                value,
                options,
              }: {
                name: string;
                value: string;
                options?: unknown;
              }) => {
                safeSetCookie(cookieStore, name, value, options);
              }
            );
          }
          // If no cookie store available, silently skip cookie setting
        },
      },
      auth: {
        persistSession: false,
      },
    }
  );
}

// Create a read-only client for server components that only need to read auth state
export async function createReadOnlyClient() {
  const cookieStore = await getCookieStore();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    getSupabasePublicKey(),
    {
      cookies: {
        getAll: () => {
          try {
            return cookieStore?.getAll() || [];
          } catch {
            return [];
          }
        },
        setAll: () => {
          // Never attempt to set cookies in read-only mode
          // This prevents the "Cookies can only be modified" error
        },
      },
      auth: {
        persistSession: false,
      },
    }
  );
}

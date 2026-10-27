// /src/lib/supabase/client.ts
"use client";
import { createBrowserClient } from "@supabase/ssr";
import { getSupabasePublicKey } from "./public-key";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    getSupabasePublicKey(),
    {
      auth: {
        detectSessionInUrl: true,
        autoRefreshToken: true,
        persistSession: true,
      },
    }
  );
}

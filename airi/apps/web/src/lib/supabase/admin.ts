import "server-only";

import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client (no cookies, no `next/headers`).
 * Import from `@/lib/supabase/admin` — not from `server.ts` — so RAG/lib code does not pull App Router APIs into unrelated bundles.
 */
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

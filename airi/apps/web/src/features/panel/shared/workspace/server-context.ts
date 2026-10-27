import "server-only";

import { cache } from "react";
import { createReadOnlyClient } from "@/lib/supabase/server";

/**
 * One cookie-scoped client per request. Row-level security checks the
 * session's JWT on every query, so reads may start before getUser returns.
 */
export const getReadOnlySupabaseClient = cache(createReadOnlyClient);

export const getReadOnlySupabaseContext = cache(async () => {
  const supabase = await getReadOnlySupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { supabase, user };
});

export const getReadOnlySupabaseUser = cache(async () => {
  const { user } = await getReadOnlySupabaseContext();

  return user;
});

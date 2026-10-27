import "server-only";

import { createReadOnlyClient } from "@/lib/supabase/server";
import { cookies } from "next/headers";
import { getLandingHeaderViewer } from "./landing-header-viewer";

export async function getLandingHeaderViewerForRequest() {
  const cookieStore = await cookies();
  let supabasePromise: ReturnType<typeof createReadOnlyClient> | null = null;

  const getSupabase = () => {
    supabasePromise ??= createReadOnlyClient();
    return supabasePromise;
  };

  return getLandingHeaderViewer({
    cookies: cookieStore.getAll(),
    getUser: async () => {
      const supabase = await getSupabase();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      return user ? { id: user.id } : null;
    },
  });
}

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Resolve company slug for a workspace (via workspaces -> companies).
 * Returns null if not found.
 */
export async function getCompanySlugByWorkspaceId(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<string | null> {
  const { data: ws } = await supabase
    .from("workspaces")
    .select("companies!inner(slug)")
    .eq("id", workspaceId)
    .maybeSingle();

  const companies = (
    ws as { companies?: { slug: string } | { slug: string }[] } | null
  )?.companies;
  if (!companies) return null;
  return Array.isArray(companies)
    ? (companies[0]?.slug ?? null)
    : ((companies as { slug?: string }).slug ?? null);
}

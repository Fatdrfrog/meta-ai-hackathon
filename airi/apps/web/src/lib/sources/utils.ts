import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Source, TypedSource } from "@icecore/shared/types/sources";
import type { SupabaseClient } from "@supabase/supabase-js";

export type SourceWithCredentialsLookupResult =
  | {
      ok: true;
      source: Source | null;
    }
  | {
      ok: false;
      error: unknown;
    };

/**
 * Verifies that a user has access to a workspace.
 * This is a shared utility used across all source operations.
 * Reuses the existing checkUserWorkspaceAccess from queries.ts.
 *
 * @param supabase - Supabase client (regular, not admin)
 * @param userId - User ID to verify
 * @param workspaceId - Workspace ID to check access for
 * @returns True if user has access, false otherwise
 */
export async function verifyWorkspaceAccess(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string
): Promise<boolean> {
  return checkUserWorkspaceAccess(supabase, userId, workspaceId);
}

/**
 * Fetches a source from Supabase with credentials.
 * Uses admin client to bypass RLS and access credentials.
 *
 * @param sourceId - The source ID to fetch (optional if filters provided)
 * @param sourceType - Optional source type filter (e.g., 'telegram', 'whatsapp')
 * @param filters - Optional additional filters (e.g., {'credentials->>phone_number_id': '123'})
 * @returns A typed lookup result that keeps confirmed absence separate from
 * query failures.
 */
export async function fetchSourceWithCredentialsResult(
  sourceId?: string,
  sourceType?: string,
  filters?: Record<string, string>
): Promise<SourceWithCredentialsLookupResult> {
  try {
    let query = supabaseAdmin.from("sources").select("*");

    if (sourceId) {
      query = query.eq("id", sourceId);
    }

    if (sourceType) {
      query = query.eq("type", sourceType);
    }

    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        query = query.eq(key, value);
      }
    }

    // Order by created_at desc to get the most recent if multiple match
    const { data: source, error } = await query
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      return { ok: false, error };
    }

    return {
      ok: true,
      source: source ? (source as Source) : null,
    };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Compatibility wrapper for callers that intentionally treat lookup failures
 * and confirmed absence alike.
 */
export async function fetchSourceWithCredentials(
  sourceId?: string,
  sourceType?: string,
  filters?: Record<string, string>
): Promise<Source | null> {
  const result = await fetchSourceWithCredentialsResult(
    sourceId,
    sourceType,
    filters
  );
  return result.ok ? result.source : null;
}

/**
 * Fetches a source and verifies user has access to its workspace.
 * This combines source fetching with workspace access verification.
 *
 * @param sourceId - The source ID to fetch
 * @param userId - User ID to verify workspace access
 * @param sourceType - Optional source type filter
 * @returns Object with source and access verification result
 */
export async function fetchSourceWithAccessCheck(
  sourceId: string,
  userId: string,
  sourceType?: string
): Promise<{
  source: Source | null;
  hasAccess: boolean;
  error?: string;
}> {
  // Fetch source with credentials using admin client
  const source = await fetchSourceWithCredentials(sourceId, sourceType);

  if (!source) {
    return {
      source: null,
      hasAccess: false,
      error: "Source not found",
    };
  }

  // Verify user has access to the workspace
  const supabase = await createClient();
  const hasAccess = await verifyWorkspaceAccess(
    supabase,
    userId,
    source.workspace_id
  );

  if (!hasAccess) {
    return {
      source: null,
      hasAccess: false,
      error: "Access denied to this workspace",
    };
  }

  return {
    source,
    hasAccess: true,
  };
}

/**
 * Type guard helper to check if a source matches a specific type.
 * This is a generic version that can be used with any source type guard.
 *
 * @param source - Source to check
 * @param typeGuard - Type guard function (e.g., isTelegramSource, isWhatsAppSource)
 * @returns True if source matches the type
 */
export function isSourceOfType<T extends TypedSource>(
  source: Source | null,
  typeGuard: (source: Source) => source is T
): source is T {
  return source !== null && typeGuard(source);
}

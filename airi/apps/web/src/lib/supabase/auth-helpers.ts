import { SupabaseClient, User } from "@supabase/supabase-js";

/**
 * Get authenticated user with automatic session refresh
 * Handles cases where the session might be expired but refreshable
 */
export async function getAuthenticatedUser(
  supabase: SupabaseClient
): Promise<{ user: User | null; error: Error | null }> {
  try {
    // Rely on getUser() which internally handles session refresh via the Supabase client
    const {
      data: { user },
      error: getUserError,
    } = await supabase.auth.getUser();

    if (user && !getUserError) {
      return { user, error: null };
    }

    // Handle common "silent" auth errors that just mean "not logged in"
    if (getUserError) {
      const isExpectedError =
        getUserError.message?.includes("refresh_token_not_found") ||
        getUserError.message?.includes("Invalid Refresh Token") ||
        getUserError.message?.includes("Auth session missing") ||
        getUserError.message?.includes("JWT");

      if (isExpectedError) {
        return { user: null, error: null };
      }

      return { user: null, error: getUserError };
    }

    return { user: null, error: null };
  } catch (error) {
    return {
      user: null,
      error:
        error instanceof Error
          ? error
          : new Error("Unexpected authentication error"),
    };
  }
}

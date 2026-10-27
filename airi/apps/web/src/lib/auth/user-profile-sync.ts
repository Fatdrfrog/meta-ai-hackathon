import { supabaseAdmin } from "@/lib/supabase/admin";
import type { User } from "@supabase/supabase-js";

type PublicProfileUser = Pick<User, "id" | "email"> &
  Partial<Pick<User, "user_metadata">>;

export async function syncPublicUserProfile(
  user: PublicProfileUser
): Promise<void> {
  const metadata = user.user_metadata as Record<string, unknown> | undefined;
  const fullName = (metadata?.full_name || metadata?.name) as
    | string
    | undefined;
  const avatarUrl = metadata?.avatar_url as string | undefined;

  const { error } = await supabaseAdmin.from("users").upsert(
    {
      id: user.id,
      full_name: fullName ?? null,
      avatar_url: avatarUrl ?? null,
    },
    { onConflict: "id" }
  );

  if (error) {
    throw error;
  }
}

"use server";

import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export async function saveSetupProfile(fullNameInput: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const fullName = fullNameInput.trim().replace(/\s+/g, " ");

  if (fullName.length < 2) {
    return { success: false, error: "Name must be at least 2 characters." };
  }

  if (fullName.length > 100) {
    return { success: false, error: "Name is too long." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, error: "Session expired. Please sign in again." };
  }

  const { error: updateError } = await supabase.auth.updateUser({
    data: { full_name: fullName },
  });

  if (updateError) {
    return {
      success: false,
      error: "Failed to update profile. Please try again.",
    };
  }

  const metadata = user.user_metadata as Record<string, unknown> | undefined;
  const avatarUrl = metadata?.avatar_url as string | undefined;

  await supabaseAdmin.from("users").upsert(
    {
      id: user.id,
      full_name: fullName,
      avatar_url: avatarUrl ?? null,
    },
    { onConflict: "id" }
  );

  revalidatePath("/", "layout");
  return { success: true };
}

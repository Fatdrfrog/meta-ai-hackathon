"use server";

import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { syncPublicUserProfile } from "@/lib/auth/user-profile-sync";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import {
  createProfileSchema,
  getAvatarValidationError,
} from "./schema";

type FormState = {
  error: string | null;
  success: boolean;
};

export async function updateProfile(
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  const t = await getTranslations("Settings");
  const parsed = createProfileSchema(t).safeParse({
    fullName: formData.get("fullName"),
  });
  if (!parsed.success)
    return { error: parsed.error.issues[0].message, success: false };
  const avatarInput = formData.get("avatar");
  if (typeof avatarInput === "string")
    return { error: t("avatarTypeError"), success: false };
  const avatarFile = avatarInput as File | null;
  if (avatarFile) {
    const error = getAvatarValidationError(avatarFile);
    if (error) return { error: t(error), success: false };
  }
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      error: t("profileUnavailable"),
      success: false,
    };
  }

  const fullName = parsed.data.fullName;

  let avatarUrl = user.user_metadata.avatar_url;

  if (avatarFile && avatarFile.size > 0) {
    const filePath = `${user.id}/profile`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from("avatars")
      .upload(filePath, avatarFile, {
        upsert: true,
        contentType: avatarFile.type,
        cacheControl: "0",
      });

    if (uploadError) {
      return {
        error: t("profileUploadError"),
        success: false,
      };
    }

    const {
      data: { publicUrl },
    } = supabaseAdmin.storage.from("avatars").getPublicUrl(filePath);

    avatarUrl = publicUrl;
  }

  const { error: updateError } = await supabase.auth.updateUser({
    data: {
      full_name: fullName,
      avatar_url: avatarUrl,
    },
  });

  if (updateError) {
    return {
      error: t("profileSaveError"),
      success: false,
    };
  }

  try {
    await syncPublicUserProfile({
      ...user,
      user_metadata: {
        ...user.user_metadata,
        full_name: fullName,
        avatar_url: avatarUrl,
      },
    });
  } catch {
    return { error: t("profileSyncError"), success: false };
  }

  // Revalidate the entire site to ensure the new user info is displayed everywhere
  revalidatePath("/", "layout");

  return { success: true, error: null };
}

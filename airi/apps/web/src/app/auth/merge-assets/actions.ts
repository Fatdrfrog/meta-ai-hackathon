"use server";

import {
  getSafeAccountMergeNextPath,
  mergeAccountAssetsForUser,
  rememberAccountMergeSkip,
} from "@/lib/auth/account-merge";
import { createClient } from "@/lib/supabase/server";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

function getNextPath(formData: FormData): string {
  return getSafeAccountMergeNextPath(String(formData.get("next") || ""));
}

function getErrorRedirect(nextPath: string, message: string): string {
  const params = new URLSearchParams({
    next: nextPath,
    error: message,
  });

  return `/auth/merge-assets?${params.toString()}`;
}

export async function mergeAssetsAction(formData: FormData): Promise<never> {
  const t = await getTranslations("MergeAssetsPage");
  const nextPath = getNextPath(formData);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  let redirectPath = nextPath;
  try {
    await mergeAccountAssetsForUser(user, { supabase });
  } catch {
    redirectPath = getErrorRedirect(nextPath, t("mergeError"));
  }

  redirect(redirectPath);
}

export async function skipMergeAssetsAction(
  formData: FormData
): Promise<never> {
  const t = await getTranslations("MergeAssetsPage");
  const nextPath = getNextPath(formData);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  let redirectPath = nextPath;
  try {
    await rememberAccountMergeSkip(user, { supabase });
  } catch {
    redirectPath = getErrorRedirect(nextPath, t("skipError"));
  }

  redirect(redirectPath);
}

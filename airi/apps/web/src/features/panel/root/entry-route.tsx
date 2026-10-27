import { getPanelEntryRedirectPath } from "@/features/panel/shared/routing";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { redirect } from "next/navigation";

export default async function PanelIndex() {
  const { supabase, user } = await getReadOnlySupabaseContext();
  if (!user) {
    redirect("/login");
  }

  const redirectPath = await getPanelEntryRedirectPath(supabase, user);
  if (!redirectPath) {
    redirect("/onboarding");
  }

  redirect(redirectPath);
}

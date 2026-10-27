"use server";

import { createReadOnlyClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { resolveSetupRouterRedirect } from "./setup-router";

export default async function SetupRouter() {
  const supabase = await createReadOnlyClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: firstWorkspace } = await supabase
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1);

  if (!firstWorkspace || firstWorkspace.length === 0) {
    redirect(
      resolveSetupRouterRedirect({
        user,
        firstWorkspaceId: null,
      })
    );
  }

  const workspaceId = firstWorkspace[0].workspace_id as string;

  redirect(
    resolveSetupRouterRedirect({
      user,
      firstWorkspaceId: workspaceId,
    })
  );
}

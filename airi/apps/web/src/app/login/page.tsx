// /app/login/page.tsx  (Server Component)
import { getPanelEntryRedirectPath } from "@/features/panel/shared/routing";
import { redirect } from "next/navigation";
import { createReadOnlyClient } from "@/lib/supabase/server";
import { resolveTeamInviteContext } from "@/lib/auth/team-invite-context";
import { getAccountMergeRedirectPath } from "@/lib/auth/account-merge";
import { getSafeAuthReturnPath } from "@/lib/auth/safe-return-path";
import LoginForm from "./LoginForm";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ invite_token?: string; next?: string }>;
}) {
  const { invite_token: inviteToken, next: requestedNextPath } =
    await searchParams;
  const nextPath = getSafeAuthReturnPath(requestedNextPath);
  const supabase = await createReadOnlyClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user && inviteToken) {
    redirect(`/auth/joined?token=${encodeURIComponent(inviteToken)}`);
  }

  if (user) {
    const redirectPath = await getPanelEntryRedirectPath(supabase, user);
    if (!redirectPath) {
      const mergeRedirectPath = await getAccountMergeRedirectPath(
        user,
        "/onboarding",
        { supabase }
      );
      if (mergeRedirectPath) {
        redirect(mergeRedirectPath);
      }

      redirect("/onboarding");
    }

    const destinationPath = nextPath ?? redirectPath;
    const mergeRedirectPath = await getAccountMergeRedirectPath(
      user,
      destinationPath,
      { supabase }
    );
    if (mergeRedirectPath) {
      redirect(mergeRedirectPath);
    }

    redirect(destinationPath);
  }

  const inviteContext = inviteToken
    ? await resolveTeamInviteContext(supabase, inviteToken)
    : null;

  return (
    <LoginForm
      inviteToken={inviteToken}
      inviteContext={inviteContext}
      nextPath={nextPath ?? undefined}
    />
  );
}

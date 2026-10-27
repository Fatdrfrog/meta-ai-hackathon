import { processInvite } from "@/lib/auth/invite-processor";
import { panelWorkspaceAiriHref } from "@/features/panel/shared/routing/hrefs";
import { getUserCompany } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import type { User } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

function userHasNonEmailProvider(user: Pick<User, "app_metadata">): boolean {
  const providers = user.app_metadata?.providers;
  return (
    Array.isArray(providers) && providers.some(provider => provider !== "email")
  );
}

function getWorkspaceAiriPath(workspaceId: string): string {
  return panelWorkspaceAiriHref(workspaceId);
}

function shouldCompleteInviteProfile(
  user: Pick<User, "app_metadata">,
  inviteResult: Awaited<ReturnType<typeof processInvite>>
): boolean {
  return Boolean(
    inviteResult.workspaceId &&
      !inviteResult.alreadyProcessed &&
      !userHasNonEmailProvider(user)
  );
}

export async function GET(request: Request) {
  const { origin } = new URL(request.url);
  const supabase = await createClient();

  // Get the user from the established session
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    const params = new URLSearchParams({
      reason: "Session not found",
      raw: userError?.message || "No user in session",
    });
    return NextResponse.redirect(
      `${origin}/auth/auth-code-error?${params.toString()}`
    );
  }

  const inviteResult = await processInvite(user);

  if (!inviteResult.success) {
    return NextResponse.redirect(
      `${origin}/auth/auth-code-error?reason=${encodeURIComponent(inviteResult.error || "Unknown error")}`
    );
  }

  if (inviteResult.workspaceId) {
    if (!shouldCompleteInviteProfile(user, inviteResult)) {
      return NextResponse.redirect(
        `${origin}${getWorkspaceAiriPath(inviteResult.workspaceId)}`
      );
    }

    return NextResponse.redirect(
      `${origin}/auth/complete-invite?workspaceId=${encodeURIComponent(inviteResult.workspaceId)}`
    );
  }

  const companyData = await getUserCompany(supabase, user.id);
  if (companyData?.company_id) {
    const ws = (
      companyData as unknown as {
        workspaces: { id: string } | { id: string }[] | null;
      }
    ).workspaces;
    const workspace = Array.isArray(ws) ? ws[0] : ws;
    if (workspace?.id) {
      return NextResponse.redirect(
        `${origin}${getWorkspaceAiriPath(workspace.id)}`
      );
    }
  }
  return NextResponse.redirect(`${origin}/onboarding`);
}

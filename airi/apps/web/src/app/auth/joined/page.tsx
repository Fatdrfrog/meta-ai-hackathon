import { resolveTeamInviteContext } from "@/lib/auth/team-invite-context";
import { createReadOnlyClient } from "@/lib/supabase/server";
import { JoinedClient } from "./joined-client";

export default async function JoinedPage({
  searchParams,
}: {
  searchParams: Promise<{
    token?: string;
    invite_token?: string;
    workspaceId?: string;
  }>;
}) {
  const params = await searchParams;
  const token = params.token || params.invite_token || "";
  const supabase = await createReadOnlyClient();
  const inviteContext = token
    ? await resolveTeamInviteContext(supabase, token)
    : null;

  return (
    <JoinedClient
      token={token}
      workspaceId={params.workspaceId}
      inviteContext={inviteContext}
    />
  );
}

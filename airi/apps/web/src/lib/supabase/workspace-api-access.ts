import "server-only";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";

type WorkspaceApiSupabaseClient = Awaited<ReturnType<typeof createClient>>;

type WorkspaceApiAccessGranted = {
  ok: true;
  supabase: WorkspaceApiSupabaseClient;
  userId: string;
  accessToken: string | null;
};

type WorkspaceApiAccessDenied = {
  ok: false;
  response: NextResponse;
};

type WorkspaceApiAccessResult =
  | WorkspaceApiAccessGranted
  | WorkspaceApiAccessDenied;

function denyWorkspaceApiAccess(
  error: "Unauthorized" | "Forbidden"
): WorkspaceApiAccessDenied {
  return {
    ok: false,
    response: NextResponse.json(
      { error },
      { status: error === "Unauthorized" ? 401 : 403 }
    ),
  };
}

async function readWorkspaceApiUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

async function grantWorkspaceApiAccess(
  supabase: WorkspaceApiSupabaseClient,
  userId: string
): Promise<WorkspaceApiAccessGranted> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  return {
    ok: true,
    supabase,
    userId,
    accessToken: session?.access_token || null,
  };
}

export async function requireWorkspaceApiAccess(
  workspaceId: string
): Promise<WorkspaceApiAccessResult> {
  const { supabase, user } = await readWorkspaceApiUser();
  if (!user) return denyWorkspaceApiAccess("Unauthorized");

  const hasAccess = await checkUserWorkspaceAccess(
    supabase,
    user.id,
    workspaceId
  );
  if (!hasAccess) return denyWorkspaceApiAccess("Forbidden");

  return grantWorkspaceApiAccess(supabase, user.id);
}

/**
 * The same check as `requireWorkspaceApiAccess`, with one read overlapping
 * the membership query. `startRead` runs only once the caller is signed in,
 * so an anonymous caller never triggers it, and its result is handed back
 * only when access passes; a denial discards it, rejection included.
 */
export async function requireWorkspaceApiAccessWithRead<T>(
  workspaceId: string,
  startRead: () => Promise<T>
): Promise<
  (WorkspaceApiAccessGranted & { read: Promise<T> }) | WorkspaceApiAccessDenied
> {
  const { supabase, user } = await readWorkspaceApiUser();
  if (!user) return denyWorkspaceApiAccess("Unauthorized");

  const read = startRead();
  read.catch(() => undefined);
  const hasAccess = await checkUserWorkspaceAccess(
    supabase,
    user.id,
    workspaceId
  );
  if (!hasAccess) return denyWorkspaceApiAccess("Forbidden");

  return { ...(await grantWorkspaceApiAccess(supabase, user.id)), read };
}

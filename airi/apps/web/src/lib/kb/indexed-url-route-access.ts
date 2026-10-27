import "server-only";

import { getCompanyIdForUserWorkspace } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export type IndexedUrlWorkspaceAccess =
  | { ok: true; userId: string; companyId: string }
  | { ok: false; response: NextResponse };

export async function requireIndexedUrlWorkspaceAccess(
  workspaceId: string
): Promise<IndexedUrlWorkspaceAccess> {
  const authClient = await createClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  const companyId = await getCompanyIdForUserWorkspace(
    authClient,
    user.id,
    workspaceId
  );
  if (!companyId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "No company association for this workspace" },
        { status: 403 }
      ),
    };
  }
  return { ok: true, userId: user.id, companyId };
}

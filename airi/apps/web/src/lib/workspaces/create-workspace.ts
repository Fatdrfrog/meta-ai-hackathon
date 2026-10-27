import { ensureNewWorkspaceAiriDefaults } from "@/lib/airi/workspace-bot-default";
import { trackWorkspaceCreated } from "@/lib/analytics";
import { readServerTrackingConsent } from "@/lib/tracking-consent-server";
import { emitWorkspaceUsageDeltaBestEffort } from "@/lib/limits/company-usage-events";
import {
  ensureCompanyWorkspaceCapacity,
  type CompanyConversationLimitSnapshot,
} from "@/lib/limits/company-limits";
import {
  getSingleRelation,
  isCompanyAdminRole,
} from "@/lib/supabase/company-users";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase/admin";
import "server-only";

type WorkspaceRow = {
  id: string;
  name: string;
  created_at?: string | null;
  company_id: string;
};

type WorkspaceMembershipRow = {
  role?: string | null;
  workspace_id?: string | null;
  workspaces?:
    | { company_id?: string | null }
    | Array<{ company_id?: string | null }>
    | null;
};

export type CreateWorkspaceForCompanyResult =
  | { ok: true; workspace: WorkspaceRow }
  | { ok: false; status: 403; error: "Forbidden" | "Insufficient permissions" }
  | {
      ok: false;
      status: 402;
      error: "Company workspace limit exceeded";
      limit: CompanyConversationLimitSnapshot;
    }
  | { ok: false; status: 500; error: string };

export async function createWorkspaceForCompany(params: {
  supabase: SupabaseClient;
  user: Pick<User, "id" | "email">;
  name: string;
  companyId: string;
}): Promise<CreateWorkspaceForCompanyResult> {
  const { supabase, user, name, companyId } = params;

  const { data: memberships, error: memberErr } = await supabase
    .from("company_users")
    .select("role, workspace_id, workspaces!fk_workspace(company_id)")
    .eq("user_id", user.id);

  if (memberErr) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  const companyMemberships = (
    (memberships || []) as WorkspaceMembershipRow[]
  ).filter(row => getSingleRelation(row.workspaces)?.company_id === companyId);
  if (!companyMemberships.length) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const member = companyMemberships.find(row => isCompanyAdminRole(row.role));
  if (!member) {
    return { ok: false, status: 403, error: "Insufficient permissions" };
  }
  const memberWorkspaceId = member.workspace_id;
  if (!memberWorkspaceId) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  // Counted with the trusted client: an admin may not see every workspace.
  const workspaceCapacity = await ensureCompanyWorkspaceCapacity(
    supabaseAdmin,
    memberWorkspaceId
  );
  if (!workspaceCapacity.allowed) {
    return {
      ok: false,
      status: 402,
      error: "Company workspace limit exceeded",
      limit: workspaceCapacity.limit,
    };
  }

  // Recheck the actor's current role in the same transaction that creates the
  // workspace and membership, so a stale precheck cannot assign privileges.
  const { data: workspaceRows, error: wsErr } = await supabaseAdmin.rpc(
    "create_authorized_company_workspace",
    {
      input_actor_id: user.id,
      input_company_id: companyId,
      input_name: name,
      input_email: user.email ?? null,
    }
  );
  if (wsErr?.code === "42501") {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const workspace = (workspaceRows as WorkspaceRow[] | null)?.[0];

  if (wsErr || !workspace) {
    return {
      ok: false,
      status: 500,
      error: wsErr?.message || "Failed to create workspace",
    };
  }

  const createdWorkspace = workspace;

  try {
    trackWorkspaceCreated(
      companyId,
      createdWorkspace.id,
      createdWorkspace.name,
      user.id,
      { consent: await readServerTrackingConsent() }
    );
  } catch {}

  emitWorkspaceUsageDeltaBestEffort(
    {
      workspaceId: createdWorkspace.id,
      companyId,
      metric: "workspace_count",
      delta: 1,
      objectId: createdWorkspace.id,
      source: "workspace_route",
    },
    { supabase, logContext: "workspaces.createWorkspaceForCompany" }
  );

  try {
    await ensureNewWorkspaceAiriDefaults({
      workspaceId: createdWorkspace.id,
      updatedBy: user.id,
    });
  } catch (error) {
    console.warn("Workspace Airi defaults seed skipped", {
      workspaceId: createdWorkspace.id,
      error,
    });
  }

  return { ok: true, workspace: createdWorkspace };
}

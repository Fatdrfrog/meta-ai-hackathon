import { buildCompanyWorkspaceLimitExceededResponse } from "@/lib/limits/company-limits";
import { createClient } from "@/lib/supabase/server";
import {
  getSupabaseRouteAuth,
  isSupabaseRouteAuthError,
} from "@/lib/supabase/route-auth";
import { createWorkspaceForCompany } from "@/lib/workspaces/create-workspace";
import type { Workspace } from "@/types/supabase";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const CreateWorkspaceBody = z.object({
  name: z.string().min(2).max(100),
  companyId: z.string().uuid(),
});

export async function GET(request: NextRequest) {
  const auth = await getSupabaseRouteAuth(request);
  if (isSupabaseRouteAuthError(auth)) {
    return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }
  const { supabase, user } = auth;

  const { data, error } = await supabase
    .from("company_users")
    .select(
      `
      role,
      workspace_id,
      workspaces!fk_workspace ( id, name, created_at, company_id )
    `
    )
    .eq("user_id", user.id);

  if (error) {
    return new NextResponse(JSON.stringify({ error: error.message }), {
      status: 500,
    });
  }

  type Row = {
    role: string;
    workspace_id: string;
    workspaces:
      | (Workspace & { company_id: string })
      | Array<Workspace & { company_id: string }>
      | null;
  };

  const rows = (data ?? []) as unknown as Row[];
  const workspaces = rows.flatMap(row => {
    const ws = row.workspaces;
    const list: Array<Workspace & { company_id: string }> = Array.isArray(ws)
      ? ws
      : ws
        ? [ws]
        : [];
    return list.map(w => ({
      id: w.id || row.workspace_id,
      name: w.name,
      created_at: w.created_at,
      role: row.role,
      company_id: w.company_id,
    }));
  });

  return NextResponse.json({ workspaces });
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }

  const body = await req.json().catch(() => null);
  const parsed = CreateWorkspaceBody.safeParse(body);
  if (!parsed.success) {
    return new NextResponse(
      JSON.stringify({ error: "Invalid body", details: parsed.error.message }),
      { status: 400 }
    );
  }
  const { name, companyId } = parsed.data;

  const result = await createWorkspaceForCompany({
    supabase,
    user,
    name,
    companyId,
  });

  if (result.ok) {
    return NextResponse.json({ workspace: result.workspace });
  }

  if (result.status === 402) {
    return buildCompanyWorkspaceLimitExceededResponse(result.limit);
  }

  return new NextResponse(JSON.stringify({ error: result.error }), {
    status: result.status,
  });
}

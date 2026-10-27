import { createClient } from "@/lib/supabase/server";
import { isCompanyAdminRole } from "@/lib/supabase/company-users";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";

export type TelegramSubscriberRouteAccess = {
  ok: true;
  userId: string;
  role: string;
  workspaceId: string;
  source: {
    id: string;
    name?: string | null;
    workspace_id: string;
    type: "telegram";
  };
};

export type TelegramSubscriberRouteAccessDenied = {
  ok: false;
  response: NextResponse;
};

export async function requireTelegramSubscriberSourceAccess(params: {
  request: Request;
  sourceId: string;
  requireAdmin?: boolean;
}): Promise<
  TelegramSubscriberRouteAccess | TelegramSubscriberRouteAccessDenied
> {
  const sourceId = params.sourceId?.trim();
  if (!sourceId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "sourceId is required" },
        { status: 400 }
      ),
    };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const { data: source, error: sourceError } = await supabaseAdmin
    .from("sources")
    .select("id, name, type, workspace_id")
    .eq("id", sourceId)
    .eq("type", "telegram")
    .maybeSingle();

  if (sourceError || !source?.workspace_id) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Telegram source not found" },
        { status: 404 }
      ),
    };
  }

  const workspaceIdFromQuery = new URL(params.request.url).searchParams
    .get("workspaceId")
    ?.trim();
  if (workspaceIdFromQuery && workspaceIdFromQuery !== source.workspace_id) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Source does not belong to this workspace" },
        { status: 403 }
      ),
    };
  }

  const { data: membership } = await supabase
    .from("company_users")
    .select("role")
    .eq("user_id", user.id)
    .eq("workspace_id", source.workspace_id)
    .maybeSingle();

  const role =
    membership?.role && typeof membership.role === "string"
      ? membership.role
      : "";
  if (!role) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  if (params.requireAdmin && !isCompanyAdminRole(role)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Only admins can import Telegram subscribers" },
        { status: 403 }
      ),
    };
  }

  return {
    ok: true,
    userId: user.id,
    role,
    workspaceId: source.workspace_id,
    source: {
      id: source.id,
      name: source.name,
      workspace_id: source.workspace_id,
      type: "telegram",
    },
  };
}

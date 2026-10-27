import { createClient } from "@/lib/supabase/server";
import { isWorkspaceManagerRole } from "@/lib/supabase/company-users";
import { NextResponse } from "next/server";
import { getWorkspaceMemberRole } from "@/lib/supabase/queries";
import { requiredFieldResponse } from "@/lib/api/json-body";

type InternalLabelPayload = {
  workspaceId: string;
  id?: string;
  name?: string;
  color?: string | null;
  description?: string | null;
  isActive?: boolean;
};

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");
    const activeOnly = searchParams.get("activeOnly") === "true";

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    const role = await getWorkspaceMemberRole(supabase, user.id, workspaceId);
    if (!role) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    let query = supabase
      .from("internal_labels")
      .select("id,name,color,description,is_active,created_at,updated_at")
      .eq("workspace_id", workspaceId)
      .order("name", { ascending: true });

    if (activeOnly) {
      query = query.eq("is_active", true);
    }

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ labels: data || [] });
  } catch (error) {
    console.error("Get internal labels error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as InternalLabelPayload;
    const workspaceId = body.workspaceId;
    const name = typeof body.name === "string" ? body.name.trim() : "";

    if (!workspaceId || !name) {
      return NextResponse.json(
        { error: "workspaceId and name are required" },
        { status: 400 }
      );
    }

    if (name.length > 80) {
      return NextResponse.json(
        { error: "Label name must be 80 characters or less" },
        { status: 400 }
      );
    }

    const role = await getWorkspaceMemberRole(supabase, user.id, workspaceId);
    if (!role) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!isWorkspaceManagerRole(role)) {
      return NextResponse.json(
        { error: "Only managers and admins can create labels" },
        { status: 403 }
      );
    }

    const { data, error } = await supabase
      .from("internal_labels")
      .insert({
        workspace_id: workspaceId,
        name,
        color: body.color ?? null,
        description: body.description ?? null,
        is_active: body.isActive ?? true,
        updated_at: new Date().toISOString(),
      })
      .select("id,name,color,description,is_active,created_at,updated_at")
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ label: data }, { status: 201 });
  } catch (error) {
    console.error("Create internal label error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as InternalLabelPayload;
    const workspaceId = body.workspaceId;
    const id = body.id;

    if (!workspaceId || !id) {
      return NextResponse.json(
        { error: "workspaceId and id are required" },
        { status: 400 }
      );
    }

    const role = await getWorkspaceMemberRole(supabase, user.id, workspaceId);
    if (!role) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!isWorkspaceManagerRole(role)) {
      return NextResponse.json(
        { error: "Only managers and admins can update labels" },
        { status: 403 }
      );
    }

    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (body.name !== undefined) {
      const trimmed = String(body.name).trim();
      if (!trimmed) {
        return NextResponse.json(
          { error: "Label name cannot be empty" },
          { status: 400 }
        );
      }
      update.name = trimmed;
    }

    if (body.color !== undefined) update.color = body.color;
    if (body.description !== undefined) update.description = body.description;
    if (body.isActive !== undefined) update.is_active = body.isActive;

    const { data, error } = await supabase
      .from("internal_labels")
      .update(update)
      .eq("id", id)
      .eq("workspace_id", workspaceId)
      .select("id,name,color,description,is_active,created_at,updated_at")
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ label: data });
  } catch (error) {
    console.error("Update internal label error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");
    const id = searchParams.get("id");

    if (!workspaceId || !id) {
      return NextResponse.json(
        { error: "workspaceId and id are required" },
        { status: 400 }
      );
    }

    const role = await getWorkspaceMemberRole(supabase, user.id, workspaceId);
    if (!role) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!isWorkspaceManagerRole(role)) {
      return NextResponse.json(
        { error: "Only managers and admins can delete labels" },
        { status: 403 }
      );
    }

    const { error } = await supabase
      .from("internal_labels")
      .delete()
      .eq("id", id)
      .eq("workspace_id", workspaceId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete internal label error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

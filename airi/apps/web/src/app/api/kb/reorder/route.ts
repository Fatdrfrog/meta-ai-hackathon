import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

// Validation schema for reordering
const reorderItemSchema = z.object({
  id: z.string().uuid(),
  sort_order: z.number().int().min(0),
});

const reorderSchema = z.object({
  type: z.enum(["article"]), // Removed "space" - only articles can be reordered now
  items: z.array(reorderItemSchema).min(1),
  // For articles, optionally update parent_id for moving between parents
  parent_id: z.string().uuid().nullable().optional(),
});

export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const validationResult = reorderSchema.safeParse(body);

    if (!validationResult.success) {
      const errorMessage =
        validationResult.error.errors[0]?.message || "Validation failed";
      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    const { type, items, parent_id } = validationResult.data;

    const { data: memberships, error: membershipError } = await supabase
      .from("company_users")
      .select("workspace_id")
      .eq("user_id", user.id);

    if (membershipError) throw membershipError;

    const workspaceIds = memberships?.map(m => m.workspace_id) ?? [];
    if (workspaceIds.length === 0) {
      return NextResponse.json(
        { error: "No workspace access" },
        { status: 403 }
      );
    }

    // Update-only path (no upsert) avoids RLS insert-path failures.
    const updatePromises = items.map(item => {
      const updateData: { sort_order: number; parent_id?: string | null } = {
        sort_order: item.sort_order,
      };

      if (type === "article" && parent_id !== undefined) {
        updateData.parent_id = parent_id;
      }

      return supabase
        .from("kb_articles")
        .update(updateData)
        .eq("id", item.id)
        .in("workspace_id", workspaceIds)
        .select("id")
        .maybeSingle();
    });

    const updateResults = await Promise.all(updatePromises);
    const firstErrorResult = updateResults.find(result => result.error);

    if (firstErrorResult?.error) {
      throw firstErrorResult.error;
    }

    const notUpdatedCount = updateResults.filter(result => !result.data).length;
    if (notUpdatedCount > 0) {
      return NextResponse.json(
        {
          error:
            "Some articles were not found or you do not have access to them.",
        },
        { status: 403 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "object" &&
            error !== null &&
            "message" in error &&
            typeof (error as { message?: unknown }).message === "string"
          ? String((error as { message: string }).message)
          : "Unknown error";
    console.error("Error reordering KB items:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

import type { AiriLanguage } from "@/lib/airi/shared/language-policy";
import { isAiriLanguage } from "@/lib/airi/shared/language-policy";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { isCompanyAdminRole } from "@/lib/supabase/company-users";
import { resolveUserWorkspaceMembership } from "@/lib/supabase/queries";

function getCompanyFromMembershipRow(
  row:
    | {
        workspaces?:
          | {
              companies?:
                | {
                    id?: string | null;
                    slug?: string | null;
                    dynamic_context_tags?: string[] | null;
                    airi_language?: string | null;
                  }
                | Array<{
                    id?: string | null;
                    slug?: string | null;
                    dynamic_context_tags?: string[] | null;
                    airi_language?: string | null;
                  }>
                | null;
            }
          | Array<{
              companies?:
                | {
                    id?: string | null;
                    slug?: string | null;
                    dynamic_context_tags?: string[] | null;
                    airi_language?: string | null;
                  }
                | Array<{
                    id?: string | null;
                    slug?: string | null;
                    dynamic_context_tags?: string[] | null;
                    airi_language?: string | null;
                  }>
                | null;
            }>
          | null;
      }
    | null
    | undefined
) {
  const workspace = Array.isArray(row?.workspaces)
    ? row?.workspaces[0]
    : row?.workspaces;
  const company = Array.isArray(workspace?.companies)
    ? workspace?.companies[0]
    : workspace?.companies;

  return company || null;
}

export async function GET(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }

  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get("workspaceId");

  try {
    const selection = await resolveUserWorkspaceMembership(
      supabase,
      user.id,
      workspaceId
    );
    if (!selection.ok)
      return NextResponse.json(
        { error: selection.error },
        { status: selection.status }
      );
    let companyUserQuery = supabase
      .from("company_users")
      .select(
        "workspaces!fk_workspace(companies!workspaces_company_id_fkey(id, slug, dynamic_context_tags))"
      )
      .eq("user_id", user.id);

    companyUserQuery = companyUserQuery.eq(
      "workspace_id",
      selection.workspaceId
    );

    const { data: companyUser, error: companyUserError } =
      await companyUserQuery.maybeSingle();

    if (companyUserError || !companyUser) {
      return new Response(
        JSON.stringify({ error: "Company not found for user" }),
        { status: 404 }
      );
    }

    const companyData = getCompanyFromMembershipRow(companyUser);

    return NextResponse.json({
      tags: companyData?.dynamic_context_tags || [],
      companyId: companyData?.id || null,
      companySlug: companyData?.slug || null,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
    });
  }
}

export async function PATCH(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }

  const body = await request.json();
  const { tags, airiLanguage, workspaceId } = body;

  if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
    return new Response(
      JSON.stringify({ error: "workspaceId is required for updates" }),
      { status: 400 }
    );
  }

  if (tags !== undefined && !Array.isArray(tags)) {
    return new Response(JSON.stringify({ error: "Tags must be an array" }), {
      status: 400,
    });
  }

  if (airiLanguage !== undefined && !isAiriLanguage(airiLanguage)) {
    return new Response(
      JSON.stringify({
        error: "Invalid language. Must be one of: en, ru, kz, uz",
      }),
      { status: 400 }
    );
  }

  try {
    const companyUserQuery = supabase
      .from("company_users")
      .select(
        "role, workspaces!fk_workspace(companies!workspaces_company_id_fkey(id, airi_language))"
      )
      .eq("user_id", user.id)
      .eq("workspace_id", workspaceId);

    const { data: companyUser, error: companyUserError } =
      await companyUserQuery.maybeSingle();

    if (companyUserError || !companyUser) {
      return new Response(
        JSON.stringify({ error: "Company not found for user" }),
        { status: 404 }
      );
    }

    const companyData = getCompanyFromMembershipRow(companyUser);
    if (!companyData?.id) {
      return new Response(
        JSON.stringify({ error: "Company not found for user" }),
        { status: 404 }
      );
    }

    if (!isCompanyAdminRole(companyUser.role)) {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 }
      );
    }

    const updateData: {
      dynamic_context_tags?: string[];
      airi_language?: AiriLanguage;
    } = {};
    if (tags !== undefined) updateData.dynamic_context_tags = tags;
    if (airiLanguage !== undefined) updateData.airi_language = airiLanguage;

    if (Object.keys(updateData).length === 0) {
      return new Response(
        JSON.stringify({ error: "No update data provided" }),
        { status: 400 }
      );
    }

    // First, verify the current value before update
    const { data: companyBeforeUpdate } = await supabase
      .from("companies")
      .select("id, name, airi_language")
      .eq("id", companyData.id)
      .single();

    console.log("BEFORE UPDATE:", {
      companyId: companyData.id,
      currentLanguage: companyBeforeUpdate?.airi_language,
      updateData,
      workspaceId,
    });

    const { data: updatedCompany, error: updateError } = await supabase
      .from("companies")
      .update(updateData)
      .eq("id", companyData.id)
      .select("id, name, airi_language, dynamic_context_tags")
      .single();

    if (updateError) {
      console.error("UPDATE ERROR:", updateError);
      throw updateError;
    }

    console.log("AFTER UPDATE (immediate):", updatedCompany);

    // Double-check by reading it back after a tiny delay
    await new Promise(resolve => setTimeout(resolve, 100));
    const { data: companyAfterDelay } = await supabase
      .from("companies")
      .select("id, name, airi_language")
      .eq("id", companyData.id)
      .single();

    console.log("AFTER UPDATE (100ms delay):", companyAfterDelay);

    if (
      airiLanguage !== undefined &&
      companyAfterDelay?.airi_language !== airiLanguage
    ) {
      console.error("LANGUAGE WAS RESET!", {
        expected: airiLanguage,
        actual: companyAfterDelay?.airi_language,
      });
      return NextResponse.json(
        {
          success: false,
          error:
            "Language was updated but appears to have been reset. Check database triggers or constraints.",
          before: companyBeforeUpdate?.airi_language,
          after: updatedCompany?.airi_language,
          afterDelay: companyAfterDelay?.airi_language,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Settings updated successfully.",
      data: updatedCompany,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
    });
  }
}

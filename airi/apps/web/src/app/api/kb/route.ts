import { sanitizeBrokenImages } from "@/lib/kb/sanitize-content";
import { getAuthenticatedUser } from "@/lib/supabase/auth-helpers";
import { createClient } from "@/lib/supabase/server";
import { getLocaleFromCookie } from "@/i18n/message-loader";
import { isLocale } from "@/i18n/locales";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const { user, error: authError } = await getAuthenticatedUser(supabase);
    if (authError || !user) {
      return NextResponse.json(
        { error: authError?.message || "Unauthorized" },
        { status: 401 }
      );
    }

    const { data: memberships } = await supabase
      .from("company_users")
      .select("workspace_id")
      .eq("user_id", user.id);

    if (!memberships || memberships.length === 0) {
      return NextResponse.json({ items: [], total: 0 }, { status: 200 });
    }

    const workspaceIds = memberships.map(m => m.workspace_id);

    const url = new URL(request.url);
    const status = url.searchParams.get("status") || "published";
    const page = Math.max(1, Number(url.searchParams.get("page") || "1"));
    const pageSize = Math.min(
      100,
      Math.max(1, Number(url.searchParams.get("pageSize") || "20"))
    );
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const base = supabase
      .from("kb_articles")
      .select(
        "id, title, draft_title, status, published_at, updated_at, parent_id, sort_order, workspace_id",
        { count: "exact" }
      )
      .in("workspace_id", workspaceIds)
      .eq("status", status)
      .order("sort_order", { ascending: true });

    const { data, error, count } = await base.range(from, to);
    if (error) throw error;

    const items = (data ?? []).map(item => ({
      ...item,
      title: item.draft_title ?? item.title,
    }));

    return NextResponse.json({ items, total: count ?? 0 }, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();

    const { user, error: authError } = await getAuthenticatedUser(supabase);
    if (authError || !user) {
      return NextResponse.json(
        {
          error:
            authError?.message ||
            "Unauthorized. Please refresh the page and try again.",
        },
        { status: 401 }
      );
    }

    const { data: memberships } = await supabase
      .from("company_users")
      .select("workspace_id")
      .eq("user_id", user.id);

    if (!memberships || memberships.length === 0) {
      return NextResponse.json(
        { error: "No workspace access" },
        { status: 403 }
      );
    }

    const workspaceId = memberships[0].workspace_id;

    const body = await request.json();
    const {
      title,
      content_mdx,
      parent_id,
      locale,
      workspace_id: providedWorkspaceId,
    } = body ?? {};
    const cookieLocale = await getLocaleFromCookie();
    const articleLocale =
      typeof locale === "string" && isLocale(locale) ? locale : cookieLocale;

    const targetWorkspaceId =
      providedWorkspaceId &&
      memberships.some(m => m.workspace_id === providedWorkspaceId)
        ? providedWorkspaceId
        : workspaceId;

    if (typeof title !== "string") {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }

    const [parentCheck, maxSortOrderResult] = await Promise.all([
      parent_id
        ? supabase
            .from("kb_articles")
            .select("id")
            .eq("id", parent_id)
            .eq("workspace_id", targetWorkspaceId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      (() => {
        const q = supabase
          .from("kb_articles")
          .select("sort_order")
          .eq("workspace_id", targetWorkspaceId)
          .order("sort_order", { ascending: false })
          .limit(1);
        return (
          parent_id ? q.eq("parent_id", parent_id) : q.is("parent_id", null)
        ).maybeSingle();
      })(),
    ]).then(
      ([parentRes, sortRes]) =>
        [
          parent_id ? parentRes.data : true,
          sortRes.data as { sort_order?: number } | null,
        ] as const
    );

    if (parent_id && !parentCheck) {
      return NextResponse.json(
        { error: "Parent article not found in this workspace" },
        { status: 400 }
      );
    }

    const nextSortOrder = (maxSortOrderResult?.sort_order ?? 0) + 1;
    const sanitizedContent =
      typeof content_mdx === "string" && content_mdx.trim().length > 0
        ? sanitizeBrokenImages(content_mdx)
        : null;

    const { data: article, error: insertErr } = await supabase
      .from("kb_articles")
      .insert({
        workspace_id: targetWorkspaceId,
        title,
        draft_title: title,
        draft_content_mdx: sanitizedContent,
        parent_id: parent_id || null,
        sort_order: nextSortOrder,
        status: "draft",
        default_locale: articleLocale,
        updated_by: user.id,
      })
      .select(
        "id, title, draft_title, status, parent_id, sort_order, workspace_id, updated_at"
      )
      .single();

    if (insertErr) {
      console.error("[KB Article Create] Insert error:", insertErr);
      return NextResponse.json(
        {
          error: "Failed to create article",
          message: insertErr.message,
          code: insertErr.code,
        },
        { status: 500 }
      );
    }

    const { error: localizationInsertErr } = await supabase
      .from("kb_article_localizations")
      .insert({
        article_id: article.id,
        locale: articleLocale,
        title,
        draft_title: title,
        draft_content_mdx: sanitizedContent,
        status: "draft",
        updated_by: user.id,
      });

    if (localizationInsertErr) {
      await supabase.from("kb_articles").delete().eq("id", article.id);
      console.error(
        "[KB Article Create] Localization insert error:",
        localizationInsertErr
      );
      return NextResponse.json(
        {
          error: "Failed to create article localization",
          message: localizationInsertErr.message,
          code: localizationInsertErr.code,
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        article: {
          ...article,
          title: article.draft_title ?? article.title,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[KB Article Create] Unexpected error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        stack:
          process.env.NODE_ENV === "development"
            ? (error as Error).stack
            : undefined,
      },
      { status: 500 }
    );
  }
}

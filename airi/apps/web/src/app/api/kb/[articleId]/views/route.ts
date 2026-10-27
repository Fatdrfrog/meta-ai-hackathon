import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
};

async function hasPublicArticle(articleId: string): Promise<boolean | null> {
  const { data, error } = await supabaseAdmin
    .from("kb_articles")
    .select("id")
    .eq("id", articleId)
    .eq("status", "published")
    .not("published_at", "is", null)
    .maybeSingle();

  if (error) {
    console.error("[KB Views] Failed to verify public article:", error);
    return null;
  }

  return Boolean(data);
}

export async function GET() {
  return NextResponse.json(
    { error: "Method not allowed. Use POST to record a view." },
    {
      status: 405,
      headers: {
        ...NO_STORE_HEADERS,
        Allow: "POST",
      },
    }
  );
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ articleId: string }> }
) {
  try {
    const { articleId } = await context.params;

    if (!articleId)
      return NextResponse.json(
        { error: "Article not found" },
        { status: 404, headers: NO_STORE_HEADERS }
      );

    const isPublicArticle = await hasPublicArticle(articleId);
    if (isPublicArticle === false) {
      return NextResponse.json(
        { error: "Article not found" },
        { status: 404, headers: NO_STORE_HEADERS }
      );
    }
    if (isPublicArticle === null) {
      return NextResponse.json(
        { success: false, recorded: false },
        { status: 202, headers: NO_STORE_HEADERS }
      );
    }

    const day = new Date().toISOString().slice(0, 10);
    const { error } = await supabaseAdmin.rpc("kb_increment_view", {
      p_article_id: articleId,
      p_day: day,
    });
    if (error) {
      console.error("[KB Views] Failed to record article view:", error);
      return NextResponse.json(
        { success: false, recorded: false },
        { status: 202, headers: NO_STORE_HEADERS }
      );
    }

    return NextResponse.json(
      { success: true, recorded: true },
      { status: 201, headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    console.error("[KB Views] Unexpected view route failure:", error);
    return NextResponse.json(
      { success: false, recorded: false },
      { status: 202, headers: NO_STORE_HEADERS }
    );
  }
}

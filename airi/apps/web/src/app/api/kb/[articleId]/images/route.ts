import { getAuthenticatedUser } from "@/lib/supabase/auth-helpers";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  storeSupabaseWorkspaceBuffer,
  StorageQuotaError,
} from "@icecore/airi-runtime/storage-quota";
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function getStoragePathFromPublicUrl(
  publicUrl: string,
  bucket: string
): string | null {
  try {
    const { pathname } = new URL(publicUrl);
    const marker = `/storage/v1/object/public/${bucket}/`;
    const markerIndex = pathname.indexOf(marker);

    if (markerIndex === -1) {
      return null;
    }

    return decodeURIComponent(pathname.slice(markerIndex + marker.length));
  } catch {
    return null;
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ articleId: string }> }
) {
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

    const { articleId } = await context.params;

    if (!articleId)
      return NextResponse.json({ error: "Article not found" }, { status: 404 });

    const { data: article } = await supabase
      .from("kb_articles")
      .select("workspace_id")
      .eq("id", articleId)
      .single();
    if (!article?.workspace_id)
      return NextResponse.json({ error: "Article not found" }, { status: 404 });

    const formData = await request.formData();
    const file = formData.get("file") as File;
    const title = formData.get("title") as string;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const allowedTypes = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/gif",
      "image/webp",
    ];
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json(
        {
          error:
            "Invalid file type. Only JPEG, PNG, GIF, and WebP images are allowed.",
        },
        { status: 400 }
      );
    }

    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      return NextResponse.json(
        {
          error: "File too large. Maximum size is 10MB.",
        },
        { status: 400 }
      );
    }

    const fileExt = file.name.split(".").pop();
    const fileName = `${Date.now()}-${Math.random().toString(36).substring(2)}.${fileExt}`;
    const filePath = `kb/${articleId}/${fileName}`;

    const fileBuffer = Buffer.from(await file.arrayBuffer());
    await storeSupabaseWorkspaceBuffer({
      storage: supabaseAdmin.storage,
      workspaceId: article.workspace_id,
      bucket: "kb-attachments",
      path: filePath,
      buffer: fileBuffer,
      mimeType: file.type,
    });

    const {
      data: { publicUrl },
    } = supabaseAdmin.storage.from("kb-attachments").getPublicUrl(filePath);

    const { data: attachment, error: dbError } = await supabase
      .from("kb_attachments")
      .insert({
        article_id: articleId,
        file_url: publicUrl,
        title: title || file.name,
        size: file.size,
      })
      .select("id, file_url, title, size, created_at")
      .single();

    if (dbError) {
      await supabaseAdmin.storage.from("kb-attachments").remove([filePath]);

      return NextResponse.json(
        { error: "Failed to save attachment record" },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        attachment,
        message: "Image uploaded successfully",
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof StorageQuotaError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ articleId: string }> }
) {
  try {
    const { articleId } = await context.params;

    if (!articleId)
      return NextResponse.json({ error: "Article not found" }, { status: 404 });

    const supabase = await createClient();

    const { data: attachments, error } = await supabase
      .from("kb_attachments")
      .select("id, file_url, title, size, created_at")
      .eq("article_id", articleId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return NextResponse.json(
      { attachments: attachments || [] },
      { status: 200 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ articleId: string }> }
) {
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

    const { articleId } = await context.params;
    const url = new URL(request.url);
    const attachmentId = url.searchParams.get("id");

    if (!attachmentId) {
      return NextResponse.json(
        { error: "Attachment ID required" },
        { status: 400 }
      );
    }

    if (!articleId)
      return NextResponse.json({ error: "Article not found" }, { status: 404 });

    const { data: attachment, error: fetchError } = await supabase
      .from("kb_attachments")
      .select("file_url")
      .eq("id", attachmentId)
      .eq("article_id", articleId)
      .single();

    if (fetchError || !attachment) {
      return NextResponse.json(
        { error: "Attachment not found" },
        { status: 404 }
      );
    }

    const filePath = getStoragePathFromPublicUrl(
      attachment.file_url,
      "kb-attachments"
    );

    if (!filePath) {
      return NextResponse.json(
        { error: "Attachment storage path is invalid" },
        { status: 400 }
      );
    }

    await supabaseAdmin.storage.from("kb-attachments").remove([filePath]);

    const { error: dbError } = await supabase
      .from("kb_attachments")
      .delete()
      .eq("id", attachmentId)
      .eq("article_id", articleId);

    if (dbError) throw dbError;

    return NextResponse.json(
      { message: "Attachment deleted successfully" },
      { status: 200 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

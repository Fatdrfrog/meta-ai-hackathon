import { createClient } from "@/lib/supabase/server";
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function hashIp(ip: string) {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error("ENCRYPTION_SECRET is required to hash KB feedback IPs");
  }
  return crypto.createHmac("sha256", secret).update(ip).digest("hex");
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ articleId: string }> }
) {
  try {
    const [supabase, { articleId }, body] = await Promise.all([
      createClient(),
      context.params,
      request.json(),
    ]);
    const { vote, comment } = body;
    if (!articleId || ![1, -1].includes(vote)) {
      return NextResponse.json(
        { error: "article_id and vote (1 or -1) required" },
        { status: 400 }
      );
    }

    const ip =
      (request.headers.get("x-forwarded-for") || "").split(",")[0] || "0.0.0.0";
    const ipHash = hashIp(ip);
    const userAgent = request.headers.get("user-agent") || "";

    const { error: insErr } = await supabase
      .from("kb_article_feedback")
      .insert({
        article_id: articleId,
        vote,
        comment,
        user_agent: userAgent,
        ip_hash: ipHash,
      });
    if (insErr) throw insErr;

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

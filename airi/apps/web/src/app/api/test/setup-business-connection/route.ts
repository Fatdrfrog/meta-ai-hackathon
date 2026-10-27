/**
 * Test API endpoint to setup business connection for E2E tests
 */

import { supabaseAdmin } from "@/lib/supabase/admin";
import { verifyTestApiAccess } from "@/lib/internal-api-auth";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const denied = verifyTestApiAccess(req);
  if (denied) return denied;

  try {
    const {
      business_connection_id,
      telegram_user_id,
      workspace_id,
      can_reply,
    } = await req.json();

    if (!business_connection_id || !telegram_user_id || !workspace_id) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Insert or update business connection
    const { data, error } = await supabaseAdmin
      .from("telegram_business_connections")
      .upsert({
        business_connection_id,
        telegram_user_id,
        workspace_id,
        can_reply: can_reply ?? true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        { error: "Failed to setup business connection" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, data });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

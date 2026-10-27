/**
 * Test API endpoint to cleanup business connection for E2E tests
 */

import { supabaseAdmin } from "@/lib/supabase/admin";
import { verifyTestApiAccess } from "@/lib/internal-api-auth";
import { NextRequest, NextResponse } from "next/server";

export async function DELETE(req: NextRequest) {
  const denied = verifyTestApiAccess(req);
  if (denied) return denied;

  try {
    const { business_connection_id } = await req.json();

    if (!business_connection_id) {
      return NextResponse.json(
        { error: "Missing business_connection_id" },
        { status: 400 }
      );
    }

    // Delete business connection
    const { error } = await supabaseAdmin
      .from("telegram_business_connections")
      .delete()
      .eq("business_connection_id", business_connection_id);

    if (error) {
      return NextResponse.json(
        { error: "Failed to cleanup business connection" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

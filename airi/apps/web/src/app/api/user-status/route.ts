import { createClient } from "@/lib/supabase/server";

import { NextResponse } from "next/server";

export async function GET() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }

  try {
    const { count } = await supabase
      .from("company_users")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id);

    const userHasCompany = (count ?? 0) > 0;

    return NextResponse.json({ hasCompany: userHasCompany });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
    });
  }
}

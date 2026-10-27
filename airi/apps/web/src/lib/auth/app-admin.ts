import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

type AppAdminSupabase = Awaited<ReturnType<typeof createClient>>;

export type AppAdminAccess =
  | {
      userId: null;
      response: NextResponse;
      supabase: AppAdminSupabase;
    }
  | {
      userId: string;
      response: NextResponse;
      supabase: AppAdminSupabase;
    }
  | {
      userId: string;
      response: null;
      supabase: AppAdminSupabase;
    };

export async function requireAppAdmin(
  supabase?: AppAdminSupabase
): Promise<AppAdminAccess> {
  const client = supabase ?? (await createClient());
  const {
    data: { user },
  } = await client.auth.getUser();

  if (!user) {
    return {
      userId: null,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      supabase: client,
    };
  }

  if (user.app_metadata?.platform_role !== "admin") {
    return {
      userId: user.id,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      supabase: client,
    };
  }

  return { userId: user.id, response: null, supabase: client };
}

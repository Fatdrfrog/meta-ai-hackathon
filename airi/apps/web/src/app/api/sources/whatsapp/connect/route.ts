import { resolveUserWorkspaceMembership } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

/**
 * Legacy standard OAuth launcher — **removed**.
 * Redirects to the integrations page with a clear message.
 */
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

  const access = await resolveUserWorkspaceMembership(
    supabase,
    user.id,
    new URL(request.url).searchParams.get("workspaceId")
  );
  if (!access.ok)
    return NextResponse.json(
      { error: access.error },
      { status: access.status }
    );
  const { origin } = new URL(request.url);

  const url = new URL(
    `/panel/w/${access.workspaceId}/settings/integrations`,
    origin
  );
  url.searchParams.set("type", "whatsapp");
  url.searchParams.set("error", "legacy_oauth_removed");
  url.searchParams.set(
    "message",
    "Standard WhatsApp OAuth is no longer available. Use QR code or Embedded Signup."
  );
  return NextResponse.redirect(url);
}

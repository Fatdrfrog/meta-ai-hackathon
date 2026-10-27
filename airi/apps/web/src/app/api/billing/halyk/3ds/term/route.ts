import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const formData = await request.formData().catch(() => null);
  const payload = formData ? Object.fromEntries(formData.entries()) : {};

  logger.info("billing.halyk.3ds_term_received", {
    event: "billing.halyk.3ds_term_received",
    workspaceId: workspaceId || undefined,
    keys: Object.keys(payload),
  });

  const redirectUrl = workspaceId
    ? `/panel/w/${encodeURIComponent(workspaceId)}/settings/billing`
    : "/";
  return NextResponse.redirect(new URL(redirectUrl, request.url), 303);
}

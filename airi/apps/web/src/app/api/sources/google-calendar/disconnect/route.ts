import { decryptMaybeString } from "@/lib/crypto";
import { GOOGLE_CALENDAR_SOURCE_TYPE } from "@/lib/google-calendar/google-calendar-source";
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { requiredFieldResponse } from "@/lib/api/json-body";

function tokenFromCredentials(credentials: unknown): string {
  if (!credentials || typeof credentials !== "object") return "";
  const raw = credentials as Record<string, unknown>;
  return (
    decryptMaybeString(raw.refresh_token) ||
    decryptMaybeString(raw.access_token)
  );
}

async function revokeGoogleToken(token: string): Promise<void> {
  if (!token) return;
  const body = new URLSearchParams({ token });
  const response = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    console.warn("[google-calendar.disconnect] token revoke failed", {
      status: response.status,
    });
  }
}

async function disconnect(request: NextRequest | Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = (searchParams.get("workspaceId") || "").trim();
  if (!workspaceId) return requiredFieldResponse("workspaceId");

  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;
  const { supabase } = access;

  const { data: source, error: sourceError } = await supabase
    .from("sources")
    .select("id, credentials")
    .eq("workspace_id", workspaceId)
    .eq("type", GOOGLE_CALENDAR_SOURCE_TYPE)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (sourceError) {
    return NextResponse.json(
      { error: "Failed to load Google Calendar source" },
      { status: 500 }
    );
  }

  if (!source?.id) {
    return NextResponse.json({ success: true });
  }

  await revokeGoogleToken(tokenFromCredentials(source.credentials));

  const deleteResult = await supabase
    .from("sources")
    .delete()
    .eq("id", source.id)
    .eq("workspace_id", workspaceId);

  if (deleteResult.error) {
    return NextResponse.json(
      { error: "Failed to disconnect Google Calendar" },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest | Request) {
  return disconnect(request);
}

export async function POST(request: NextRequest | Request) {
  return disconnect(request);
}

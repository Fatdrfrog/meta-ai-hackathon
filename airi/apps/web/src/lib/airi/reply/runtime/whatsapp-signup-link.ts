import { supabaseAdmin } from "@/lib/supabase/admin";
import { readNonEmptyString } from "@icecore/shared/lib/value-utils";

type JsonRecord = Record<string, unknown>;

export type WhatsAppSignupLinkRuntimeRecord = {
  id: string;
  metaSignupId: string | null;
  deepLinkUrl: string;
  displayName: string | null;
  status: "ACTIVE" | "DISABLED";
};

function mapSignupLink(row: JsonRecord): WhatsAppSignupLinkRuntimeRecord {
  return {
    id: String(row.id || ""),
    metaSignupId: readNonEmptyString(row.meta_signup_id),
    deepLinkUrl: String(row.deep_link_url || ""),
    displayName: readNonEmptyString(row.display_name),
    status:
      String(row.status || "ACTIVE").toUpperCase() === "DISABLED"
        ? "DISABLED"
        : "ACTIVE",
  };
}

export async function resolveWhatsAppSignupLinkForScenario(params: {
  workspaceId: string;
  signupLinkId?: string | null;
  sourceId?: string | null;
}): Promise<WhatsAppSignupLinkRuntimeRecord | null> {
  const signupLinkId = readNonEmptyString(params.signupLinkId);
  if (!signupLinkId) return null;

  let query = supabaseAdmin
    .from("whatsapp_signup_links")
    .select("id,meta_signup_id,deep_link_url,display_name,status")
    .eq("workspace_id", params.workspaceId)
    .eq("id", signupLinkId);

  const sourceId = readNonEmptyString(params.sourceId);
  if (sourceId) {
    query = query.eq("source_id", sourceId);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  return mapSignupLink(data as JsonRecord);
}

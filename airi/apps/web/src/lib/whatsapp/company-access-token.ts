import { supabaseAdmin } from "@/lib/supabase/admin";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import { getWhatsAppConnectionMaintenanceStatus } from "@/lib/whatsapp/token-lifecycle";
import { compactWhatsAppAccountString } from "@icecore/shared/lib/whatsapp/account-identifiers";
import { isWhatsAppCloudApiMessagingSuspended } from "@icecore/shared/lib/whatsapp/source-state";
import { asRecord } from "@icecore/shared/lib/value-utils";

/**
 * A stored token can only stand in for the company when Meta still lets it
 * act: a suspended source (offboarded or partner removed) or a token Meta
 * confirmed invalid or expired would offer inventory nobody can connect.
 * Tokens that merely expire soon still work and stay usable.
 */
function isUsableStoredWhatsAppToken(
  credentials: Record<string, unknown>
): boolean {
  if (isWhatsAppCloudApiMessagingSuspended(credentials)) return false;
  if (credentials.token_is_valid === false) return false;
  return (
    getWhatsAppConnectionMaintenanceStatus(credentials).state !== "expired"
  );
}

export async function resolveCompanyWhatsAppAccessToken(params: {
  companyId?: string | null;
  explicitAccessToken?: string | null;
}): Promise<string | null> {
  const explicitAccessToken = params.explicitAccessToken?.trim();
  if (explicitAccessToken) return explicitAccessToken;

  const companyId = compactWhatsAppAccountString(params.companyId);
  if (!companyId) return null;

  const { data, error } = await supabaseAdmin
    .from("sources")
    .select("id, credentials, updated_at, created_at")
    .eq("company_id", companyId)
    .eq("type", "whatsapp")
    .order("updated_at", { ascending: false })
    .limit(20);

  if (error || !Array.isArray(data)) return null;

  for (const row of data) {
    const credentials = asRecord(asRecord(row).credentials);
    if (!isUsableStoredWhatsAppToken(credentials)) continue;
    const { accessToken } = normalizeWhatsAppCredentials(credentials);
    if (accessToken) return accessToken;
  }

  return null;
}

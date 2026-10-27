import { supabaseAdmin } from "@/lib/supabase/admin";
import { isWorkspaceManagerRole } from "@/lib/supabase/company-users";
import { getWhatsAppReconnectStatus } from "@/lib/whatsapp/reconnect-status";
import { WhatsAppReconnectBannerClient } from "./reconnect-banner-client";

interface WhatsAppReconnectBannerProps {
  workspaceId: string;
  userId: string;
}

/**
 * Panel-wide banner that surfaces expiring or expired WhatsApp tokens
 * on every page (not just on the integrations settings page) so agents
 * never miss a reconnect prompt mid-shift.
 *
 * Keeps a lightweight client status monitor mounted for connected sources so
 * a partner removal can surface while the user remains on the same page.
 * Renders nothing only when the workspace has no WhatsApp source.
 */
export async function WhatsAppReconnectBanner({
  workspaceId,
  userId,
}: WhatsAppReconnectBannerProps) {
  const { data: membership } = await supabaseAdmin
    .from("company_users")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();

  const role = membership?.role;
  if (!isWorkspaceManagerRole(role)) {
    return null;
  }

  // Read alongside the status lookup; only a connected banner needs it.
  const workspaceRead = Promise.resolve(
    supabaseAdmin
      .from("workspaces")
      .select("company_id")
      .eq("id", workspaceId)
      .maybeSingle()
  );
  workspaceRead.catch(() => undefined);
  const status = await getWhatsAppReconnectStatus(workspaceId);

  if (status.state === "not_connected") return null;

  const { data: workspace } = await workspaceRead;

  return (
    <WhatsAppReconnectBannerClient
      workspaceId={workspaceId}
      companyId={workspace?.company_id ?? undefined}
      status={status}
    />
  );
}

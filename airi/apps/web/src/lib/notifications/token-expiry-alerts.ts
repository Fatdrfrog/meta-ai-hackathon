/**
 * Token expiry notification system
 * Sends alerts to the workspace team when integration tokens are expiring soon
 */

import { realtime } from "@/lib/realtime/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { WORKSPACE_ROLES } from "@/lib/supabase/company-users";

interface TokenExpiryAlert {
  workspaceId: string;
  integrationType: "instagram" | "whatsapp";
  daysUntilExpiry: number;
}

/**
 * Send token expiry alert to the workspace's admins and managers
 */
export async function sendTokenExpiryAlert({
  workspaceId,
  integrationType,
  daysUntilExpiry,
}: TokenExpiryAlert) {
  try {
    const { data: members } = await supabaseAdmin
      .from("company_users")
      .select("user_id, email")
      .eq("workspace_id", workspaceId)
      .in("role", [...WORKSPACE_ROLES]);

    if (!members || members.length === 0) {
      console.warn(
        `No team members found for workspace ${workspaceId} to notify about token expiry`
      );
      return;
    }

    const integrationName =
      integrationType === "instagram" ? "Instagram" : "WhatsApp";
    const isWhatsApp = integrationType === "whatsapp";

    // Send real-time alert via Realtime
    await realtime.trigger(`private-${workspaceId}-alerts`, "alert", {
      type: "warning",
      title: isWhatsApp
        ? "Restore your WhatsApp connection"
        : `${integrationName} Token Expiring Soon`,
      message: isWhatsApp
        ? "WhatsApp needs your confirmation to keep this connection working. Open settings to restore the connection."
        : `Your ${integrationName} integration token expires in ${daysUntilExpiry} day${daysUntilExpiry > 1 ? "s" : ""}. Please reconnect to avoid service interruption.`,
      action: {
        label: isWhatsApp ? "Restore connection" : "Reconnect Now",
        url: `/panel/w/${workspaceId}/settings/integrations?type=${integrationType}${isWhatsApp ? "&reconnect=1" : ""}`,
      },
      timestamp: new Date(),
    });

    console.log(
      `📧 Sent token expiry alert for ${integrationName} to workspace ${workspaceId} (${daysUntilExpiry} days)`
    );

    // TODO: Send email notification
    // For now, we're using realtime alerts. Email notifications can be added here:
    // - Use Postmark to send email to the workspace's admins and managers
    // - Include reconnect link in email
    // - Track email delivery status
  } catch (error) {
    console.error("Failed to send token expiry alert:", error);
  }
}

/**
 * Check if alert should be sent based on days until expiry
 * Send alerts at: 7 days, 3 days, 1 day, and when expired
 */
export function shouldSendExpiryAlert(daysUntilExpiry: number): boolean {
  return (
    daysUntilExpiry === 7 ||
    daysUntilExpiry === 3 ||
    daysUntilExpiry === 1 ||
    daysUntilExpiry === 0
  );
}

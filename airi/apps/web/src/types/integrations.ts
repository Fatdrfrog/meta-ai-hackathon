import type { Source } from "@/types/supabase";

export type EmailProviderStatus = "disconnected" | "pending_dns" | "connected";

export interface EmailIntegrationSource {
  id: string;
  local_part: string;
  full_address: string;
  created_at: string;
  status: string;
  kind: string;
  postmark_stream_outbound: string;
}

export interface WorkspaceIntegrationsData {
  sources: Source[];
  /**
   * The workspace's partner-removed WhatsApp source, returned only so settings
   * can offer a reconnect. It is never a usable channel.
   */
  removedWhatsAppSource: Source | null;
  emailSources: EmailIntegrationSource[];
  emailIntegrationEnabled: boolean;
  emailProviderStatus: EmailProviderStatus;
  emailProviderConnected: boolean;
  /** True when any company WhatsApp source has a usable Meta access token. */
  hasCompanyWhatsAppInventory: boolean;
}

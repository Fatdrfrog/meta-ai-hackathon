import {
  getEmailSourceConnectionStatus,
  getWorkspaceEmailSource,
} from "@/lib/email/email-source";
import { getWorkspaceEmailProviderStatus } from "@/lib/email/provider-config";
import type { EmailProviderStatus } from "@/types/integrations";

export type WorkspaceEmailConnectionStatus = {
  connected: boolean;
  providerStatus: EmailProviderStatus;
  activeAddressCount: number;
};

export async function getWorkspaceEmailConnectionStatus(
  workspaceId: string
): Promise<WorkspaceEmailConnectionStatus> {
  const [providerStatus, emailSource] = await Promise.all([
    getWorkspaceEmailProviderStatus(workspaceId),
    getWorkspaceEmailSource(workspaceId),
  ]);

  const connection = getEmailSourceConnectionStatus(
    emailSource,
    providerStatus
  );

  return {
    connected: connection.connected || providerStatus === "connected",
    providerStatus,
    activeAddressCount: connection.activeAddressCount,
  };
}

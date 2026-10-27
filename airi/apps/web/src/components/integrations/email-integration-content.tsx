"use client";

import type { EmailProviderStatus } from "@/types/integrations";
import { EmailProviderConfigForm } from "./email-provider-config-form";

interface EmailIntegrationContentProps {
  workspaceId: string;
  emailProviderStatus: EmailProviderStatus;
  connectionActionsDisabled?: boolean;
}

export function EmailIntegrationContent({
  workspaceId,
  emailProviderStatus,
  connectionActionsDisabled = false,
}: EmailIntegrationContentProps) {
  return (
    <div className="space-y-4">
      <EmailProviderConfigForm
        workspaceId={workspaceId}
        emailProviderStatus={emailProviderStatus}
        connectionActionsDisabled={connectionActionsDisabled}
      />
    </div>
  );
}

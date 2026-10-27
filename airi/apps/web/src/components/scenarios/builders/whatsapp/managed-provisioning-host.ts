import type { EditableWhatsAppFlowConfig } from "@icecore/scenario-contracts";

import type { provisionWhatsAppFlow } from "@/lib/whatsapp/flows/client";

type ManagedWhatsAppFlowProvisioningSource = {
  id: string;
  label: string;
};

export type ManagedWhatsAppFlowPublication = {
  response: Awaited<ReturnType<typeof provisionWhatsAppFlow>>;
  adopted: boolean;
};

export type ManagedWhatsAppFlowProvisioningHost = {
  ownerKey: string;
  sources: readonly ManagedWhatsAppFlowProvisioningSource[];
  publishing: boolean;
  publish(params: {
    sourceId: string;
    editableConfig: EditableWhatsAppFlowConfig;
  }): Promise<ManagedWhatsAppFlowPublication | null>;
};

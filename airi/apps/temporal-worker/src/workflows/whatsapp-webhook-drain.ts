import {
  assertContractVersion,
  WHATSAPP_WEBHOOK_DRAIN_ACTIVITY,
  WHATSAPP_WEBHOOK_DRAIN_WORKFLOW_CONTRACT_VERSION,
  type WhatsAppWebhookDrainActivityInput,
  type WhatsAppWebhookDrainActivityResult,
  type WhatsAppWebhookDrainWorkflowInput,
  type WhatsAppWebhookDrainWorkflowResult,
} from "@icecore/temporal";
import { proxyActivities, setWorkflowOptions } from "@temporalio/workflow";

const activities = proxyActivities<{
  [WHATSAPP_WEBHOOK_DRAIN_ACTIVITY]: (
    input: WhatsAppWebhookDrainActivityInput,
  ) => Promise<WhatsAppWebhookDrainActivityResult>;
}>({
  startToCloseTimeout: "300s",
  heartbeatTimeout: "30s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "5s",
    backoffCoefficient: 2,
    maximumInterval: "60s",
  },
});

const drainActivity = activities[WHATSAPP_WEBHOOK_DRAIN_ACTIVITY] as (
  input: WhatsAppWebhookDrainActivityInput,
) => Promise<WhatsAppWebhookDrainActivityResult>;

export async function whatsappWebhookDrainWorkflow(
  input: WhatsAppWebhookDrainWorkflowInput,
): Promise<WhatsAppWebhookDrainWorkflowResult> {
  assertContractVersion(
    input.contractVersion,
    { exact: WHATSAPP_WEBHOOK_DRAIN_WORKFLOW_CONTRACT_VERSION },
    "WhatsApp webhook drain workflow",
  );

  return drainActivity(input);
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  whatsappWebhookDrainWorkflow,
);

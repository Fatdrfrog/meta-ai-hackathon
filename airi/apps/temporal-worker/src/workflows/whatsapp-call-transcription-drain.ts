import {
  assertContractVersion,
  WHATSAPP_CALL_TRANSCRIPTION_DRAIN_ACTIVITY,
  WHATSAPP_CALL_TRANSCRIPTION_DRAIN_WORKFLOW_CONTRACT_VERSION,
  type WhatsAppCallTranscriptionDrainActivityInput,
  type WhatsAppCallTranscriptionDrainActivityResult,
  type WhatsAppCallTranscriptionDrainWorkflowInput,
  type WhatsAppCallTranscriptionDrainWorkflowResult,
} from "@icecore/temporal";
import { proxyActivities, setWorkflowOptions } from "@temporalio/workflow";

const activities = proxyActivities<{
  [WHATSAPP_CALL_TRANSCRIPTION_DRAIN_ACTIVITY]: (
    input: WhatsAppCallTranscriptionDrainActivityInput,
  ) => Promise<WhatsAppCallTranscriptionDrainActivityResult>;
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

const drainActivity = activities[
  WHATSAPP_CALL_TRANSCRIPTION_DRAIN_ACTIVITY
] as (
  input: WhatsAppCallTranscriptionDrainActivityInput,
) => Promise<WhatsAppCallTranscriptionDrainActivityResult>;

export async function whatsappCallTranscriptionDrainWorkflow(
  input: WhatsAppCallTranscriptionDrainWorkflowInput,
): Promise<WhatsAppCallTranscriptionDrainWorkflowResult> {
  assertContractVersion(
    input.contractVersion,
    { exact: WHATSAPP_CALL_TRANSCRIPTION_DRAIN_WORKFLOW_CONTRACT_VERSION },
    "WhatsApp call transcription drain workflow",
  );

  return drainActivity(input);
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  whatsappCallTranscriptionDrainWorkflow,
);

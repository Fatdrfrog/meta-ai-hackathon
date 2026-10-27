import {
  WHATSAPP_OTP_DELIVER_CHALLENGE_ACTIVITY,
  WHATSAPP_OTP_DELIVER_CHALLENGE_SCHEDULE_TO_CLOSE_TIMEOUT,
  WHATSAPP_OTP_DELIVER_CHALLENGE_START_TO_CLOSE_TIMEOUT,
  WHATSAPP_OTP_DELIVERY_NON_RETRYABLE_ERROR_TYPES,
  isSupportedWhatsAppOtpDeliveryContractVersion,
  type WhatsAppOtpDeliverChallengeActivityInput,
  type WhatsAppOtpDeliverChallengeActivityResult,
  type WhatsAppOtpDeliveryWorkflowInput,
} from "@icecore/temporal";
import { proxyActivities, setWorkflowOptions } from "@temporalio/workflow";

const activities = proxyActivities<{
  [WHATSAPP_OTP_DELIVER_CHALLENGE_ACTIVITY]: (
    input: WhatsAppOtpDeliverChallengeActivityInput,
  ) => Promise<WhatsAppOtpDeliverChallengeActivityResult>;
}>({
  startToCloseTimeout: WHATSAPP_OTP_DELIVER_CHALLENGE_START_TO_CLOSE_TIMEOUT,
  scheduleToCloseTimeout: WHATSAPP_OTP_DELIVER_CHALLENGE_SCHEDULE_TO_CLOSE_TIMEOUT,
  retry: {
    maximumAttempts: 6,
    initialInterval: "2s",
    backoffCoefficient: 2,
    maximumInterval: "30s",
    nonRetryableErrorTypes: [...WHATSAPP_OTP_DELIVERY_NON_RETRYABLE_ERROR_TYPES],
  },
});

const deliverChallenge = activities[WHATSAPP_OTP_DELIVER_CHALLENGE_ACTIVITY] as (
  input: WhatsAppOtpDeliverChallengeActivityInput,
) => Promise<WhatsAppOtpDeliverChallengeActivityResult>;

export async function whatsappOtpDeliveryWorkflow(
  input: WhatsAppOtpDeliveryWorkflowInput,
): Promise<WhatsAppOtpDeliverChallengeActivityResult> {
  if (!isSupportedWhatsAppOtpDeliveryContractVersion(input.contractVersion)) {
    throw new Error(
      `Unsupported WhatsApp OTP delivery workflow contract version: ${input.contractVersion}`,
    );
  }

  return deliverChallenge({
    workspaceId: input.workspaceId,
    challengeId: input.challengeId,
    correlationId: input.correlationId,
  });
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  whatsappOtpDeliveryWorkflow,
);

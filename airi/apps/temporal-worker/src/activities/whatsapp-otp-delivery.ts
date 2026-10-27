import { activityInfo, ApplicationFailure } from "@temporalio/activity";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  WHATSAPP_OTP_DELIVER_CHALLENGE_ACTIVITY,
  type WhatsAppOtpDeliverChallengeActivityInput,
  type WhatsAppOtpDeliverChallengeActivityResult,
  type WhatsAppOtpDeliveryStatus,
} from "@icecore/temporal";
import {
  deliverWhatsAppOtpChallenge,
  installDefaultOtpRuntime,
} from "@icecore/otp-runtime";

type DeliveryOutcome = {
  status: WhatsAppOtpDeliveryStatus;
  challengeId: string;
  providerMessageId?: string;
};

function nonRetryable(message: string, type: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, type);
}

function readActivityAttempt(): number | null {
  try {
    return activityInfo().attempt;
  } catch {
    return null;
  }
}

export function classifyWhatsAppOtpDeliveryError(
  error: unknown,
): ApplicationFailure | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/credentials are incomplete/i.test(message)) {
    return nonRetryable(message, "WhatsAppOtpMissingCredentials");
  }
  if (/missing encrypted delivery code/i.test(message)) {
    return nonRetryable(message, "WhatsAppOtpMissingCode");
  }
  if (/no longer approved|no active whatsapp otp template/i.test(message)) {
    return nonRetryable(message, "WhatsAppOtpMissingTemplate");
  }
  return null;
}

export function mapWhatsAppOtpDeliveryOutcome(
  result: DeliveryOutcome,
): WhatsAppOtpDeliverChallengeActivityResult {
  switch (result.status) {
    case "sent":
    case "already_sent":
    case "skipped":
      return result;
    case "expired":
      throw nonRetryable(
        "OTP challenge expired before delivery",
        "WhatsAppOtpExpired",
      );
    case "not_found":
      throw nonRetryable("OTP challenge was not found", "WhatsAppOtpNotFound");
    default: {
      const unexpected: never = result.status;
      throw new Error(`Unhandled OTP delivery status: ${String(unexpected)}`);
    }
  }
}

export const whatsappOtpDeliveryActivityHandlers = {
  [WHATSAPP_OTP_DELIVER_CHALLENGE_ACTIVITY]: async (
    input: WhatsAppOtpDeliverChallengeActivityInput,
  ): Promise<WhatsAppOtpDeliverChallengeActivityResult> => {
    installDefaultOtpRuntime();
    const startedAt = Date.now();
    const attempt = readActivityAttempt();
    try {
      const result = mapWhatsAppOtpDeliveryOutcome(
        await deliverWhatsAppOtpChallenge({
          workspaceId: input.workspaceId,
          challengeId: input.challengeId,
        }),
      );
      airiWorkerLogger.info("whatsapp.otp.temporal.activity", {
        note: result.status,
        workspaceId: input.workspaceId,
        challengeId: input.challengeId,
        correlationId: input.correlationId || null,
        outcome: result.status,
        attempt,
        durationMs: Date.now() - startedAt,
        providerMessageId: result.providerMessageId || null,
      });
      return result;
    } catch (error) {
      if (error instanceof ApplicationFailure) {
        airiWorkerLogger.warn("whatsapp.otp.temporal.activity", {
          note: "permanent_failure",
          workspaceId: input.workspaceId,
          challengeId: input.challengeId,
          correlationId: input.correlationId || null,
          outcome: error.type || "permanent_failure",
          attempt,
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
      const classified = classifyWhatsAppOtpDeliveryError(error);
      if (classified) {
        airiWorkerLogger.warn("whatsapp.otp.temporal.activity", {
          note: "permanent_failure",
          workspaceId: input.workspaceId,
          challengeId: input.challengeId,
          correlationId: input.correlationId || null,
          outcome: classified.type || "permanent_failure",
          attempt,
          durationMs: Date.now() - startedAt,
        });
        throw classified;
      }
      airiWorkerLogger.error("whatsapp.otp.temporal.activity", error, {
        note: "retryable_failure",
        workspaceId: input.workspaceId,
        challengeId: input.challengeId,
        correlationId: input.correlationId || null,
        outcome: "retryable_failure",
        attempt,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  },
};

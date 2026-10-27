import { createLogger } from "@icecore/shared/lib/logger";

import {
  getWhatsAppOtpDeliveryMode,
  getWhatsAppOtpTemporalWorkspaceAllowlist,
  shouldUseTemporalWhatsAppOtpDelivery,
} from "./delivery-mode";
import { publishWhatsAppOtpDeliveryToPubSub } from "./pubsub-publisher";
import type {
  WhatsAppOtpDeliveryMessage,
  WhatsAppOtpEnqueueResult,
} from "./runtime";
import { startWhatsAppOtpDeliveryWorkflow } from "./temporal-starter";

const logger = createLogger("otp-runtime");

export type WhatsAppOtpEnqueueTransport = "temporal" | "pubsub";

export type EnqueueWhatsAppOtpDeliveryDeps = {
  startWorkflow?: (
    message: WhatsAppOtpDeliveryMessage
  ) => Promise<WhatsAppOtpEnqueueResult>;
  publishToPubSub?: (
    message: WhatsAppOtpDeliveryMessage
  ) => Promise<WhatsAppOtpEnqueueResult>;
};

export function resolveWhatsAppOtpEnqueueTransport(
  workspaceId: string
): WhatsAppOtpEnqueueTransport {
  return shouldUseTemporalWhatsAppOtpDelivery(workspaceId)
    ? "temporal"
    : "pubsub";
}

export async function enqueueWhatsAppOtpDelivery(
  message: WhatsAppOtpDeliveryMessage,
  deps: EnqueueWhatsAppOtpDeliveryDeps = {}
): Promise<WhatsAppOtpEnqueueResult> {
  const transport = resolveWhatsAppOtpEnqueueTransport(message.workspaceId);
  logger.info("whatsapp.otp.enqueue", {
    note: "selected",
    workspaceId: message.workspaceId,
    challengeId: message.challengeId,
    correlationId: message.correlationId,
    mode: getWhatsAppOtpDeliveryMode(),
    transport,
    allowlistSize: getWhatsAppOtpTemporalWorkspaceAllowlist().length,
  });

  if (transport === "temporal") {
    const startWorkflow =
      deps.startWorkflow || startWhatsAppOtpDeliveryWorkflow;
    return startWorkflow(message);
  }

  const publishToPubSub =
    deps.publishToPubSub || publishWhatsAppOtpDeliveryToPubSub;
  return publishToPubSub(message);
}

import type { AiriScenarioRuntimeConfig } from "@icecore/airi-runtime/scenario-runtime-types";
import { airiOrchestrationLogger } from "@/lib/airi/reply/runtime/reply-logging";
import {
  getScenarioWhatsAppServiceBodySource,
  type ScenarioWhatsAppServiceMessage,
  type ScenarioWhatsAppSessionChoice,
} from "@icecore/scenario-contracts";

export type ScenarioReplyExecutionDecision =
  | { kind: "non_reply" }
  | { kind: "ai_context" }
  | { kind: "direct_fixed"; replyText: string };

export type ScenarioWhatsAppDeliveryProjection = {
  whatsappServiceMessage?: ScenarioWhatsAppServiceMessage;
  whatsappServiceAppointmentChoices?: ScenarioWhatsAppSessionChoice[];
};

export function resolveScenarioWhatsAppDeliveryProjection(params: {
  runtime?: Pick<
    AiriScenarioRuntimeConfig,
    "actionWhatsAppServiceMessage"
  > | null;
  appointmentChoices?: ScenarioWhatsAppSessionChoice[];
}): ScenarioWhatsAppDeliveryProjection {
  const serviceMessage = params.runtime?.actionWhatsAppServiceMessage;
  return {
    whatsappServiceMessage: serviceMessage,
    whatsappServiceAppointmentChoices: serviceMessage
      ? params.appointmentChoices
      : undefined,
  };
}

/**
 * Fixed scenario replies must never fall through to the AI/RAG path.
 * Empty fixed copy still returns `direct_fixed` so orchestration can skip
 * or fail the send without invoking model work.
 *
 * Canonical WhatsApp service messages own their body mode. Fixed and bodyless
 * messages dispatch directly; AI bodies must reach generation so compilation
 * receives the generated body.
 */
export function resolveScenarioReplyExecutionDecision(
  runtime?: Pick<
    AiriScenarioRuntimeConfig,
    | "actionType"
    | "actionReplyMode"
    | "actionReplyText"
    | "actionWhatsAppServiceMessage"
  > | null
): ScenarioReplyExecutionDecision {
  if (!runtime || runtime.actionType !== "reply") {
    return { kind: "non_reply" };
  }

  const serviceBody = runtime.actionWhatsAppServiceMessage
    ? getScenarioWhatsAppServiceBodySource(runtime.actionWhatsAppServiceMessage)
    : undefined;
  if (serviceBody?.mode === "ai") {
    return { kind: "ai_context" };
  }
  if (runtime.actionWhatsAppServiceMessage) {
    return {
      kind: "direct_fixed",
      replyText: serviceBody?.mode === "fixed" ? serviceBody.text.trim() : "",
    };
  }

  const replyText = (runtime.actionReplyText || "").trim();
  const replyMode = runtime.actionReplyMode === "fixed" ? "fixed" : "ai";

  if (replyMode === "fixed") {
    if (!replyText) {
      airiOrchestrationLogger.warn("airi.orchestration.scenario", {
        note: "fixed_reply_empty_skip_ai",
      });
    }
    return {
      kind: "direct_fixed",
      replyText,
    };
  }

  return { kind: "ai_context" };
}

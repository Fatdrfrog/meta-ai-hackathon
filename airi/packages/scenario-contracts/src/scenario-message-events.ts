export type ScenarioMessageIngressEventKind =
  | "inbound_message"
  | "telegram_quick_reply"
  | "instagram_quick_reply"
  | "whatsapp_button_reply"
  | "whatsapp_flow_reply";

export type ScenarioPostActionEventKind =
  | "payment_detected"
  | "no_human_reply_timeout"
  | "post_action_user_reply";

export type ScenarioRuntimeEventKind =
  | ScenarioMessageIngressEventKind
  | ScenarioPostActionEventKind;

export type ScenarioTriggerEventKind = ScenarioRuntimeEventKind;

export const SCENARIO_TRIGGER_EVENT_KIND = {
  inboundMessage: "inbound_message",
  paymentDetected: "payment_detected",
  noHumanReplyTimeout: "no_human_reply_timeout",
  postActionUserReply: "post_action_user_reply",
  telegramQuickReply: "telegram_quick_reply",
  instagramQuickReply: "instagram_quick_reply",
  whatsAppButtonReply: "whatsapp_button_reply",
  whatsAppFlowReply: "whatsapp_flow_reply",
} as const satisfies Record<string, ScenarioRuntimeEventKind>;

export const SCENARIO_QUICK_REPLY_EVENT_KINDS = [
  SCENARIO_TRIGGER_EVENT_KIND.telegramQuickReply,
  SCENARIO_TRIGGER_EVENT_KIND.instagramQuickReply,
  SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
] as const;

export const SCENARIO_INTERACTIVE_REPLY_EVENT_KINDS = [
  ...SCENARIO_QUICK_REPLY_EVENT_KINDS,
  SCENARIO_TRIGGER_EVENT_KIND.whatsAppFlowReply,
] as const;

const SCENARIO_QUICK_REPLY_EVENT_KIND_SET = new Set<string>(
  SCENARIO_QUICK_REPLY_EVENT_KINDS,
);
const SCENARIO_INTERACTIVE_REPLY_EVENT_KIND_SET = new Set<string>(
  SCENARIO_INTERACTIVE_REPLY_EVENT_KINDS,
);
const SCENARIO_MESSAGE_INGRESS_EVENT_KIND_SET = new Set<string>([
  SCENARIO_TRIGGER_EVENT_KIND.inboundMessage,
  ...SCENARIO_INTERACTIVE_REPLY_EVENT_KINDS,
]);
const SCENARIO_POST_ACTION_EVENT_KIND_SET = new Set<string>([
  SCENARIO_TRIGGER_EVENT_KIND.paymentDetected,
  SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout,
  SCENARIO_TRIGGER_EVENT_KIND.postActionUserReply,
]);

export function isScenarioQuickReplyEventKind(
  value: unknown,
): value is (typeof SCENARIO_QUICK_REPLY_EVENT_KINDS)[number] {
  return (
    typeof value === "string" &&
    SCENARIO_QUICK_REPLY_EVENT_KIND_SET.has(value.trim())
  );
}

export function isScenarioInteractiveReplyEventKind(
  value: unknown,
): value is (typeof SCENARIO_INTERACTIVE_REPLY_EVENT_KINDS)[number] {
  return (
    typeof value === "string" &&
    SCENARIO_INTERACTIVE_REPLY_EVENT_KIND_SET.has(value.trim())
  );
}

export function isScenarioMessageIngressEventKind(
  value: unknown,
): value is ScenarioMessageIngressEventKind {
  return (
    typeof value === "string" &&
    SCENARIO_MESSAGE_INGRESS_EVENT_KIND_SET.has(value.trim())
  );
}

export function isScenarioPostActionEventKind(
  value: unknown,
): value is ScenarioPostActionEventKind {
  return (
    typeof value === "string" &&
    SCENARIO_POST_ACTION_EVENT_KIND_SET.has(value.trim())
  );
}

export function isScenarioInboundTriggerEventKind(
  value: unknown,
): value is ScenarioMessageIngressEventKind {
  return isScenarioMessageIngressEventKind(value);
}

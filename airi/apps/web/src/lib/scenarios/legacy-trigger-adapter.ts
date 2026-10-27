import {
  createClientMessageTriggerData,
  normalizeClientMessageTriggerConfig,
  SCENARIO_TRIGGER_EVENT_KIND,
  type ScenarioMessageMatchMode,
  type ScenarioNodeData,
} from "@icecore/scenario-contracts";
import { readTrimmedString } from "@icecore/shared/lib/value-utils";

const LEGACY_EXACT_MESSAGE_TRIGGER_TYPE = "exact_incoming_message";
const LEGACY_CONTAINS_MESSAGE_TRIGGER_TYPE = "customer_message_contains";
const LEGACY_CHANNEL_MESSAGE_TRIGGER_TYPE = "channel_is";
const CURRENT_CLIENT_MESSAGE_TRIGGER_TYPE = "incoming_customer_message";

const RETIRED_ROOT_TRIGGER_TYPES = new Set<string>([
  "payment_detected",
  "no_human_reply_timeout",
  "user_replied_after_parent_action",
  "customer_intent_or_classification",
  "business_hours_window",
  "user_inactive_for_period",
  "funnel_stage_changed",
  "checkout_incomplete",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function migrateLegacyTriggerNodeData(raw: unknown): ScenarioNodeData {
  const input = asRecord(raw);
  const rawTriggerConfig = asRecord(input.triggerConfig);
  const rawTriggerType = readTrimmedString(input.triggerType);
  const linkedConditionId = readTrimmedString(input.linkedConditionId);
  const isLegacyTelegramQuickReply =
    rawTriggerType === SCENARIO_TRIGGER_EVENT_KIND.telegramQuickReply;
  const isSupportedLegacyType =
    rawTriggerType === LEGACY_EXACT_MESSAGE_TRIGGER_TYPE ||
    rawTriggerType === LEGACY_CONTAINS_MESSAGE_TRIGGER_TYPE ||
    rawTriggerType === LEGACY_CHANNEL_MESSAGE_TRIGGER_TYPE ||
    isLegacyTelegramQuickReply;
  const isUnknownType =
    rawTriggerType.length > 0 &&
    rawTriggerType !== CURRENT_CLIENT_MESSAGE_TRIGGER_TYPE &&
    !isSupportedLegacyType &&
    !RETIRED_ROOT_TRIGGER_TYPES.has(rawTriggerType);
  const isAutomationWithoutType =
    rawTriggerType.length === 0 &&
    readTrimmedString(input.source).toLowerCase() === "automation";
  const mustFailClosed =
    linkedConditionId.length === 0 &&
    (RETIRED_ROOT_TRIGGER_TYPES.has(rawTriggerType) ||
      isUnknownType ||
      isAutomationWithoutType);
  const legacyMessageMatchMode: ScenarioMessageMatchMode | undefined =
    rawTriggerType === LEGACY_EXACT_MESSAGE_TRIGGER_TYPE
      ? "exact"
      : rawTriggerType === LEGACY_CONTAINS_MESSAGE_TRIGGER_TYPE
        ? "contains"
        : undefined;
  const normalizedExistingChannels = normalizeClientMessageTriggerConfig({
    channelFilter: rawTriggerConfig.channelFilter,
  }).channelFilter;
  const telegramChannelFilter = isLegacyTelegramQuickReply
    ? Array.from(new Set([...(normalizedExistingChannels ?? []), "telegram"]))
    : rawTriggerConfig.channelFilter;
  const triggerConfig = normalizeClientMessageTriggerConfig({
    ...rawTriggerConfig,
    ...(legacyMessageMatchMode
      ? { messageMatchMode: legacyMessageMatchMode }
      : {}),
    ...(isLegacyTelegramQuickReply
      ? { channelFilter: telegramChannelFilter }
      : {}),
    ...(mustFailClosed ? { enabled: false } : {}),
  });
  const {
    kind: _kind,
    triggerConfig: _triggerConfig,
    triggerType: _triggerType,
    ...data
  } = input;

  return createClientMessageTriggerData({
    ...(data as Partial<ScenarioNodeData>),
    triggerConfig,
  });
}

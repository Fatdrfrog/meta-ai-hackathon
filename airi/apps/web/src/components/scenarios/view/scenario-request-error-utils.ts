import { ScenarioRequestError } from "@/lib/scenarios/client";
import { TranslateFn } from "../types";

const TRANSLATABLE_SCENARIO_ERROR_CODES = new Set([
  "condition_branch_requires_action_source",
  "condition_branch_allows_single_target",
  "oneTriggerRequired",
  "onlyOneTriggerAllowed",
  "singleFlowRequired",
  "telegramBranchIncomplete",
  "instagramBranchIncomplete",
  "ambiguousNextActionFork",
  "bulkPrimaryActionAlreadyConnected",
  "bulkPrimaryActionRequiresAction",
  "whatsappContactIncomplete",
  "whatsappLocationIncomplete",
  "whatsappServiceMessageInvalid",
  "whatsappTemplateRequired",
  "whatsappTemplateBindingsInvalid",
  "whatsappTemplateBindingsRequireConversation",
  "whatsappTemplateFormRouteUnavailable",
  "whatsappTemplateFormRouteConditionTarget",
  "whatsappTemplateFormRouteInBulk",
  "messageTriggerIncomplete",
  "businessEventIntegrationPending",
  "whatsappQrEntryPointIncomplete",
  "actionTypeInvalid",
  "handoffNotificationInvalid",
  "generativeAIConfigInvalid",
  "generativeAIPromptInputUnavailable",
  "generativeAIPickedOptionUnavailable",
  "generativeAIPickedCardImageInvalid",
  "formAnswerUnavailable",
  "formAnswersKeyDuplicate",
  "promptInputChoiceWaitUnsupported",
  "generativeAIUnsupportedInBulk",
  "stackedInteractiveActions",
  "scenario_updated_conflict",
  "reserved_persisted_node_id",
  "unsupported_action_run_conditions_version",
  "unsupported_action_outcomes_version",
  "mixed_action_outcome_ownership",
  "duplicate_action_answer_rule_id",
  "duplicate_action_exact_answer",
  "multiple_action_outcome_targets",
  "malformed_action_outcome_handle",
  "invalid_generative_ai_output_handle",
  "multiple_generative_ai_output_targets",
  "unsupported_action_branch_delay_handle",
  "multiple_action_branch_delay_targets",
  "duplicate_action_location_route_id",
  "legacy_action_routing_invalid_request",
  "legacy_action_routing_not_eligible",
  "legacy_action_routing_transaction_failed",
  "legacy_action_routing_pending_timer_identity_invalid",
  "legacy_action_routing_external_state_invalid",
  "legacy_action_routing_timer_ingress_unavailable",
  "scenario_asset_upload_too_large",
  "scenario_asset_upload_unsupported_file",
  "scenario_asset_upload_network_failed",
  "scenario_asset_upload_auth_required",
  "scenario_asset_upload_forbidden",
  "scenario_asset_upload_rejected",
  "scenario_asset_upload_unavailable",
  "company_scenario_limit_exceeded",
  "company_conversation_limit_exceeded",
]);

/** Localize a validation code, falling back when it has no dedicated message. */
export function translateScenarioErrorCode(
  code: string,
  t: TranslateFn,
  fallbackKey: string
): string {
  return TRANSLATABLE_SCENARIO_ERROR_CODES.has(code) ? t(code) : t(fallbackKey);
}

export function resolveScenarioRequestErrorMessage(
  error: unknown,
  t: TranslateFn,
  fallbackKey: string
): string {
  const isAssetUpload = fallbackKey === "actionImageUploadFailed";
  if (error instanceof ScenarioRequestError) {
    const translatableCode = [error.code, ...error.codes].find(
      code => code && TRANSLATABLE_SCENARIO_ERROR_CODES.has(code)
    );
    if (translatableCode) {
      return t(translatableCode);
    }

    if (isAssetUpload) {
      // An upstream proxy can reject an upload without a JSON response body.
      switch (error.status) {
        case 401:
          return t("scenario_asset_upload_auth_required");
        case 403:
          return t("scenario_asset_upload_forbidden");
        case 413:
          return t("scenario_asset_upload_too_large");
        case 502:
        case 503:
        case 504:
          return t("scenario_asset_upload_unavailable");
        default:
          return t(fallbackKey);
      }
    }

    if (error.code || error.codes.length > 0) {
      // Unknown structured codes can carry raw server text with internal
      // identifiers, so show the localized fallback instead.
      return t(fallbackKey);
    }
    if (error.message.trim()) return error.message;
  }

  // Upload errors may contain storage names, credentials or provider details.
  if (isAssetUpload) return t(fallbackKey);

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return t(fallbackKey);
}

/**
 * A known refusal in the person's language, otherwise the fallback. Never the
 * server's own text, which is English and can name internal records.
 */
export function resolveScenarioRequestErrorCodeMessage(
  error: unknown,
  t: TranslateFn,
  fallbackKey: string
): string {
  if (error instanceof ScenarioRequestError) {
    const translatableCode = [error.code, ...error.codes].find(
      code => code && TRANSLATABLE_SCENARIO_ERROR_CODES.has(code)
    );
    if (translatableCode) return t(translatableCode);
  }
  return t(fallbackKey);
}

/** Blocks the failed request named as the cause, for the editor to reveal. */
export function getScenarioRequestErrorBlockNodeIds(error: unknown): string[] {
  return error instanceof ScenarioRequestError ? error.nodeIds : [];
}

/** The primary server code of a failed request, for analytics. */
export function getScenarioRequestErrorCode(error: unknown): string | null {
  if (!(error instanceof ScenarioRequestError)) return null;
  return error.code ?? error.codes[0] ?? null;
}

export function isScenarioRequestErrorWithCode(
  error: unknown,
  code: string
): error is ScenarioRequestError {
  return (
    typeof code === "string" &&
    error instanceof Error &&
    error.name === "ScenarioRequestError" &&
    ((error as ScenarioRequestError).code === code ||
      (error as ScenarioRequestError).codes.includes(code))
  );
}

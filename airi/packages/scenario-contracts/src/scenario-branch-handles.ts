import {
  normalizeScenarioActionOutcomes,
  normalizeScenarioActionRuleId,
  visitScenarioActionOutcomeBranches,
} from "./scenario-action-routing";
import { normalizeScenarioLocationRouteId } from "./scenario-location-routing";
import {
  SCENARIO_POST_ACTION_CONDITION_TYPES,
  type ScenarioPostActionConditionType,
} from "./scenario-triggers";
export {
  GENERATIVE_AI_FAILURE_HANDLE,
  GENERATIVE_AI_SUCCESS_HANDLE,
} from "./scenario-generative-ai";

export const ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID = "right-source-flow-branch";
export const ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID =
  "right-source-telegram-branch";
export const ACTION_INSTAGRAM_BRANCH_OUTPUT_HANDLE_ID =
  "right-source-instagram-branch";
export const ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID =
  "right-source-whatsapp-session-choice-branch";
export const ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID =
  "right-source-whatsapp-template-button-branch";
export const ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID =
  "right-source-interactive-no-reply";
/**
 * A WhatsApp template's "Form submitted" route, taken when the customer
 * submits the form its one FLOW button opens. It names no button: a template
 * has at most one FLOW button and the form's reply carries no payload. It is
 * not a quick-reply route, so it has no button id and no `stb:` payload.
 */
export const ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID =
  "right-source-whatsapp-template-form-submitted";

export const BULK_CAMPAIGN_ACTION_SOURCE_HANDLE_ID = "top-source-bulk-action";
export const BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID = "right-source";

const BRANCH_HANDLE_SEPARATOR = "::";

export const ACTION_OUTCOME_HANDLE_PREFIX = "right-source-action-outcome";
export const ACTION_ANY_REPLY_OUTCOME_HANDLE_ID = `${ACTION_OUTCOME_HANDLE_PREFIX}::any-reply`;
export const ACTION_NO_REPLY_OUTCOME_HANDLE_ID = `${ACTION_OUTCOME_HANDLE_PREFIX}::no-reply`;
export const ACTION_PAYMENT_OUTCOME_HANDLE_ID = `${ACTION_OUTCOME_HANDLE_PREFIX}::payment-detected`;
/** A shared location whose nearest office no route groups. */
export const ACTION_LOCATION_ANY_OFFICE_OUTCOME_HANDLE_ID = `${ACTION_OUTCOME_HANDLE_PREFIX}::location-any-office`;
/** A shared location farther than the step's cutoff from every office. */
export const ACTION_LOCATION_OUTSIDE_OUTCOME_HANDLE_ID = `${ACTION_OUTCOME_HANDLE_PREFIX}::location-outside`;
const ACTION_LOCATION_ROUTE_OUTCOME_HANDLE_PREFIX = `${ACTION_OUTCOME_HANDLE_PREFIX}::location::`;

export function buildScenarioActionLocationRouteOutcomeHandleId(
  routeId: string,
): string {
  return `${ACTION_LOCATION_ROUTE_OUTCOME_HANDLE_PREFIX}${encodeURIComponent(
    normalizeScenarioLocationRouteId(routeId),
  )}`;
}

export function buildScenarioActionAnswerOutcomeHandleId(
  ruleId: string,
): string {
  return `${ACTION_OUTCOME_HANDLE_PREFIX}::answer::${encodeURIComponent(
    normalizeScenarioActionRuleId(ruleId),
  )}`;
}

export function buildScenarioActionOutcomeHandleId(
  outcome:
    | "any_reply"
    | "no_reply"
    | "payment_detected"
    | "location_any_office"
    | "location_outside"
    | { type: "answer"; ruleId: string }
    | { type: "location_route"; routeId: string },
): string {
  if (typeof outcome === "object") {
    return outcome.type === "answer"
      ? buildScenarioActionAnswerOutcomeHandleId(outcome.ruleId)
      : buildScenarioActionLocationRouteOutcomeHandleId(outcome.routeId);
  }
  switch (outcome) {
    case "any_reply":
      return ACTION_ANY_REPLY_OUTCOME_HANDLE_ID;
    case "no_reply":
      return ACTION_NO_REPLY_OUTCOME_HANDLE_ID;
    case "payment_detected":
      return ACTION_PAYMENT_OUTCOME_HANDLE_ID;
    case "location_any_office":
      return ACTION_LOCATION_ANY_OFFICE_OUTCOME_HANDLE_ID;
    case "location_outside":
      return ACTION_LOCATION_OUTSIDE_OUTCOME_HANDLE_ID;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

export type ScenarioActionOutcomeHandle =
  | { type: "any_reply" }
  | { type: "no_reply" }
  | { type: "payment_detected" }
  | { type: "answer"; ruleId: string }
  | { type: "location_route"; routeId: string }
  | { type: "location_any_office" }
  | { type: "location_outside" };

export function parseScenarioActionOutcomeHandleId(
  handleId: string | null | undefined,
): ScenarioActionOutcomeHandle | null {
  const normalizedHandleId =
    typeof handleId === "string" ? handleId.trim() : "";
  if (normalizedHandleId === ACTION_ANY_REPLY_OUTCOME_HANDLE_ID) {
    return { type: "any_reply" };
  }
  if (normalizedHandleId === ACTION_NO_REPLY_OUTCOME_HANDLE_ID) {
    return { type: "no_reply" };
  }
  if (normalizedHandleId === ACTION_PAYMENT_OUTCOME_HANDLE_ID) {
    return { type: "payment_detected" };
  }
  if (normalizedHandleId === ACTION_LOCATION_ANY_OFFICE_OUTCOME_HANDLE_ID) {
    return { type: "location_any_office" };
  }
  if (normalizedHandleId === ACTION_LOCATION_OUTSIDE_OUTCOME_HANDLE_ID) {
    return { type: "location_outside" };
  }
  if (
    normalizedHandleId.startsWith(ACTION_LOCATION_ROUTE_OUTCOME_HANDLE_PREFIX)
  ) {
    try {
      const decodedRouteId = decodeURIComponent(
        normalizedHandleId.slice(
          ACTION_LOCATION_ROUTE_OUTCOME_HANDLE_PREFIX.length,
        ),
      );
      return decodedRouteId &&
        decodedRouteId === normalizeScenarioLocationRouteId(decodedRouteId)
        ? { type: "location_route", routeId: decodedRouteId }
        : null;
    } catch {
      return null;
    }
  }

  const prefix = `${ACTION_OUTCOME_HANDLE_PREFIX}::answer::`;
  if (!normalizedHandleId.startsWith(prefix)) return null;

  try {
    const decodedRuleId = decodeURIComponent(
      normalizedHandleId.slice(prefix.length),
    );
    const ruleId = normalizeScenarioActionRuleId(decodedRuleId);
    return decodedRuleId === ruleId ? { type: "answer", ruleId } : null;
  } catch {
    return null;
  }
}

export function getConfiguredScenarioActionOutcomeHandleIds(
  value: unknown,
): string[] {
  const normalized = normalizeScenarioActionOutcomes(value);
  if (normalized.status !== "supported") return [];

  const handles: string[] = [];
  visitScenarioActionOutcomeBranches({
    anyReply: () => {
      if (normalized.value.anyReply?.enabled) {
        handles.push(ACTION_ANY_REPLY_OUTCOME_HANDLE_ID);
      }
    },
    noReply: () => {
      if (normalized.value.noReply?.enabled) {
        handles.push(ACTION_NO_REPLY_OUTCOME_HANDLE_ID);
      }
    },
    answerMatches: () => {
      for (const rule of normalized.value.answerMatches ?? []) {
        handles.push(buildScenarioActionAnswerOutcomeHandleId(rule.id));
      }
    },
    paymentDetected: () => {
      if (normalized.value.paymentDetected?.enabled) {
        handles.push(ACTION_PAYMENT_OUTCOME_HANDLE_ID);
      }
    },
    branchDelays: () => {
      // Delays reuse the handles of the CTAs they delay.
    },
    locationRoutes: () => {
      const locationRoutes = normalized.value.locationRoutes;
      if (!locationRoutes) return;
      for (const route of locationRoutes.routes) {
        handles.push(buildScenarioActionLocationRouteOutcomeHandleId(route.id));
      }
      handles.push(ACTION_LOCATION_ANY_OFFICE_OUTCOME_HANDLE_ID);
      if (locationRoutes.outside) {
        handles.push(ACTION_LOCATION_OUTSIDE_OUTCOME_HANDLE_ID);
      }
    },
  });
  return handles;
}

export function buildFlowBranchOptionKey(
  fieldId: string,
  optionId: string,
): string {
  return JSON.stringify([fieldId.trim(), optionId.trim()]);
}

export function parseFlowBranchOptionKey(
  key: string,
): { fieldId: string; optionId: string } | null {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;

    const [fieldId, optionId] = parsed;
    if (typeof fieldId !== "string" || typeof optionId !== "string") {
      return null;
    }

    const normalizedFieldId = fieldId.trim();
    const normalizedOptionId = optionId.trim();
    if (!normalizedFieldId || !normalizedOptionId) return null;

    return {
      fieldId: normalizedFieldId,
      optionId: normalizedOptionId,
    };
  } catch {
    return null;
  }
}

export function buildFlowBranchSourceHandleId(
  fieldId: string,
  optionId: string,
): string {
  return [
    ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
    encodeURIComponent(fieldId.trim()),
    encodeURIComponent(optionId.trim()),
  ].join(BRANCH_HANDLE_SEPARATOR);
}

export function parseFlowBranchSourceHandleId(
  handleId: string | null | undefined,
): { fieldId: string; optionId: string } | null {
  const normalizedHandleId =
    typeof handleId === "string" ? handleId.trim() : "";
  if (!normalizedHandleId) return null;

  const prefix = `${ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID}${BRANCH_HANDLE_SEPARATOR}`;
  if (!normalizedHandleId.startsWith(prefix)) return null;

  const parts = normalizedHandleId
    .slice(prefix.length)
    .split(BRANCH_HANDLE_SEPARATOR);
  if (parts.length !== 2) return null;
  const [encodedFieldId, encodedOptionId] = parts;
  if (!encodedFieldId || !encodedOptionId) return null;

  try {
    const fieldId = decodeURIComponent(encodedFieldId).trim();
    const optionId = decodeURIComponent(encodedOptionId).trim();
    if (!fieldId || !optionId) return null;

    return { fieldId, optionId };
  } catch {
    return null;
  }
}

export function buildTelegramBranchSourceHandleId(payload: string): string {
  const normalizedPayload = payload.trim();
  return [
    ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID,
    encodeURIComponent(normalizedPayload),
  ].join(BRANCH_HANDLE_SEPARATOR);
}

export function parseTelegramBranchSourceHandleId(
  handleId: string | null | undefined,
): { payload: string } | null {
  const normalizedHandleId =
    typeof handleId === "string" ? handleId.trim() : "";
  if (!normalizedHandleId) return null;

  const prefix = `${ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID}${BRANCH_HANDLE_SEPARATOR}`;
  if (!normalizedHandleId.startsWith(prefix)) return null;

  try {
    const payload = decodeURIComponent(normalizedHandleId.slice(prefix.length));
    return payload ? { payload } : null;
  } catch {
    return null;
  }
}

export function isTelegramBranchSourceHandleId(
  handleId: string | null | undefined,
): boolean {
  const normalizedHandleId =
    typeof handleId === "string" ? handleId.trim() : "";
  return (
    normalizedHandleId === ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID ||
    parseTelegramBranchSourceHandleId(normalizedHandleId) !== null
  );
}

export function buildWhatsAppSessionChoiceSourceHandleId(
  payload: string,
): string {
  return [
    ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
    encodeURIComponent(payload),
  ].join(BRANCH_HANDLE_SEPARATOR);
}

export function parseWhatsAppSessionChoiceSourceHandleId(
  handleId: string | null | undefined,
): { payload: string } | null {
  const normalized = typeof handleId === "string" ? handleId.trim() : "";
  const prefix = `${ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID}${BRANCH_HANDLE_SEPARATOR}`;
  if (!normalized.startsWith(prefix)) return null;

  try {
    const payload = decodeURIComponent(normalized.slice(prefix.length)).trim();
    return payload ? { payload } : null;
  } catch {
    return null;
  }
}

export function isWhatsAppSessionChoiceSourceHandleId(
  handleId: string | null | undefined,
): boolean {
  const normalized = typeof handleId === "string" ? handleId.trim() : "";
  return (
    normalized === ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID ||
    parseWhatsAppSessionChoiceSourceHandleId(normalized) !== null
  );
}

/**
 * `buttonId` is the step's id for the button (whatsapp-template-button-ids.ts).
 * Routes saved before the step had ids carry the position, which is that
 * button's id.
 */
export function buildWhatsAppTemplateButtonSourceHandleId(
  buttonId: number,
): string {
  return [
    ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID,
    String(Math.max(0, Math.trunc(buttonId))),
  ].join(BRANCH_HANDLE_SEPARATOR);
}

export function parseWhatsAppTemplateButtonSourceHandleId(
  handleId: string | null | undefined,
): { buttonId: number } | null {
  const normalizedHandleId =
    typeof handleId === "string" ? handleId.trim() : "";
  if (!normalizedHandleId) return null;

  const prefix = `${ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID}${BRANCH_HANDLE_SEPARATOR}`;
  if (!normalizedHandleId.startsWith(prefix)) return null;

  const buttonId = Number.parseInt(normalizedHandleId.slice(prefix.length), 10);
  if (!Number.isInteger(buttonId) || buttonId < 0) return null;

  return { buttonId };
}

export function isWhatsAppTemplateFormSubmittedSourceHandleId(
  handleId: string | null | undefined,
): boolean {
  const normalizedHandleId =
    typeof handleId === "string" ? handleId.trim() : "";
  return (
    normalizedHandleId === ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID
  );
}

/**
 * Only a specific WhatsApp template quick-reply button or session choice can
 * delay its follow-up. Generic output handles and other channels cannot.
 */
export function isScenarioActionBranchDelaySourceHandle(
  handleId: string | null | undefined,
): boolean {
  return (
    parseWhatsAppTemplateButtonSourceHandleId(handleId) !== null ||
    parseWhatsAppSessionChoiceSourceHandleId(handleId) !== null
  );
}

export const POST_ACTION_CONDITION_HANDLE_PREFIX = "right-source-condition";
export const POST_ACTION_ANSWER_MATCH_HANDLE_PREFIX = `${POST_ACTION_CONDITION_HANDLE_PREFIX}-answer`;

function normalizePostActionHandleRuleId(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export function buildPostActionConditionHandleId(
  type: ScenarioPostActionConditionType,
): string {
  return `${POST_ACTION_CONDITION_HANDLE_PREFIX}-${type}`;
}

export function parsePostActionConditionHandleId(
  handleId: string | null | undefined,
): ScenarioPostActionConditionType | null {
  const normalized = typeof handleId === "string" ? handleId.trim() : "";
  if (!normalized) return null;

  for (const type of SCENARIO_POST_ACTION_CONDITION_TYPES) {
    if (normalized === buildPostActionConditionHandleId(type)) return type;
  }

  return null;
}

export function buildPostActionAnswerMatchHandleId(ruleId: string): string {
  return `${POST_ACTION_ANSWER_MATCH_HANDLE_PREFIX}-${normalizeScenarioActionRuleId(ruleId)}`;
}

export function parsePostActionAnswerMatchHandleId(
  handleId: string | null | undefined,
): string | null {
  const normalized = typeof handleId === "string" ? handleId.trim() : "";
  const prefix = `${POST_ACTION_ANSWER_MATCH_HANDLE_PREFIX}-`;
  if (!normalized.startsWith(prefix)) return null;
  const ruleId = normalizePostActionHandleRuleId(normalized.slice(prefix.length));
  return ruleId || null;
}

/**
 * The compiled wait's handles for location routes. The `route-` segment keeps
 * a route id from ever spelling a fixed handle.
 */
const POST_ACTION_LOCATION_HANDLE_PREFIX = `${POST_ACTION_CONDITION_HANDLE_PREFIX}-location`;
const POST_ACTION_LOCATION_ROUTE_HANDLE_PREFIX = `${POST_ACTION_LOCATION_HANDLE_PREFIX}-route-`;
export const POST_ACTION_LOCATION_ANY_OFFICE_HANDLE_ID = `${POST_ACTION_LOCATION_HANDLE_PREFIX}-any-office`;
export const POST_ACTION_LOCATION_OUTSIDE_HANDLE_ID = `${POST_ACTION_LOCATION_HANDLE_PREFIX}-outside`;

export function buildPostActionLocationRouteHandleId(routeId: string): string {
  return `${POST_ACTION_LOCATION_ROUTE_HANDLE_PREFIX}${normalizeScenarioLocationRouteId(routeId)}`;
}

export type PostActionLocationHandle =
  | { type: "location_route"; routeId: string }
  | { type: "location_any_office" }
  | { type: "location_outside" };

export function buildPostActionLocationHandleId(
  handle: PostActionLocationHandle,
): string {
  switch (handle.type) {
    case "location_route":
      return buildPostActionLocationRouteHandleId(handle.routeId);
    case "location_any_office":
      return POST_ACTION_LOCATION_ANY_OFFICE_HANDLE_ID;
    case "location_outside":
      return POST_ACTION_LOCATION_OUTSIDE_HANDLE_ID;
    default: {
      const exhaustive: never = handle;
      return exhaustive;
    }
  }
}

export function parsePostActionLocationHandleId(
  handleId: string | null | undefined,
): PostActionLocationHandle | null {
  const normalized = typeof handleId === "string" ? handleId.trim() : "";
  if (normalized === POST_ACTION_LOCATION_ANY_OFFICE_HANDLE_ID) {
    return { type: "location_any_office" };
  }
  if (normalized === POST_ACTION_LOCATION_OUTSIDE_HANDLE_ID) {
    return { type: "location_outside" };
  }
  if (!normalized.startsWith(POST_ACTION_LOCATION_ROUTE_HANDLE_PREFIX)) {
    return null;
  }
  const routeId = normalized.slice(
    POST_ACTION_LOCATION_ROUTE_HANDLE_PREFIX.length,
  );
  return routeId && routeId === normalizeScenarioLocationRouteId(routeId)
    ? { type: "location_route", routeId }
    : null;
}

/**
 * A compiled wait handle that a customer reply claims by its content: an
 * answer rule or a location route. Such a branch continues as a reply.
 */
export function isPostActionReplyClaimHandleId(
  handleId: string | null | undefined,
): boolean {
  return (
    parsePostActionAnswerMatchHandleId(handleId) !== null ||
    parsePostActionLocationHandleId(handleId) !== null
  );
}

/**
 * The step's own handle for a compiled wait handle, so a preview can name the
 * route the step's card shows.
 */
export function mapPostActionConditionHandleToActionOutcomeHandle(
  handleId: string | null | undefined,
): string | null {
  const location = parsePostActionLocationHandleId(handleId);
  if (location) {
    return location.type === "location_route"
      ? buildScenarioActionLocationRouteOutcomeHandleId(location.routeId)
      : location.type === "location_any_office"
        ? ACTION_LOCATION_ANY_OFFICE_OUTCOME_HANDLE_ID
        : ACTION_LOCATION_OUTSIDE_OUTCOME_HANDLE_ID;
  }
  const answerRuleId = parsePostActionAnswerMatchHandleId(handleId);
  if (answerRuleId) {
    return buildScenarioActionAnswerOutcomeHandleId(answerRuleId);
  }
  switch (parsePostActionConditionHandleId(handleId)) {
    case "user_replied":
      return ACTION_ANY_REPLY_OUTCOME_HANDLE_ID;
    case "no_reply_timeout":
      return ACTION_NO_REPLY_OUTCOME_HANDLE_ID;
    case "payment_detected":
      return ACTION_PAYMENT_OUTCOME_HANDLE_ID;
    default:
      return null;
  }
}

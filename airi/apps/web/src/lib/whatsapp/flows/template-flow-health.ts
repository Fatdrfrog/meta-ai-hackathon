import { pickWhatsAppTemplateFlowIdentifier } from "@icecore/shared/types/whatsapp-flows";
import { isRecord } from "@icecore/shared/lib/value-utils";
import type { TemplateFormAnswerSchema } from "./template-form-answer-schema";

/**
 * Whether customers can open a message template's Flow buttons.
 *
 * Meta accepts a template send even when its Flow button can't open: the
 * button targets a screen the Flow's JSON no longer has, or the Flow is not
 * published. The send payload can't override the screen, so the template and
 * the Flow have to agree. These rules run in the browser and on the server
 * over facts read from Meta (see template-flow-facts.ts).
 */

/** Largest number of Flows checked in one request. */
export const TEMPLATE_FLOW_CHECK_MAX_FLOWS = 25;

const WHATSAPP_FLOW_GRAPH_ID_PATTERN = /^\d{1,32}$/;

export function isWhatsAppFlowGraphId(value: unknown): value is string {
  return (
    typeof value === "string" && WHATSAPP_FLOW_GRAPH_ID_PATTERN.test(value)
  );
}

export type TemplateFlowButton = {
  /** Position inside the template's BUTTONS component. */
  index: number;
  text: string;
  flowId: string;
  action: "navigate" | "data_exchange";
  navigateScreen: string | null;
};

/** What Meta reported about one Flow, reduced to what the rules need. */
export type TemplateFlowFacts =
  | {
      flowId: string;
      state: "found";
      name: string | null;
      status: string;
      /** Null when the Flow JSON couldn't be read. */
      screenIds: string[] | null;
      /**
       * The answers the Flow sends; null when its JSON couldn't be read. The
       * shape guard doesn't check it: validate it before saving it.
       */
      answerSchema?: TemplateFormAnswerSchema | null;
      checkedAt: string;
    }
  | { flowId: string; state: "missing"; checkedAt: string }
  | { flowId: string; state: "unavailable"; checkedAt: string };

export type TemplateFlowIssueCode =
  | "flow_missing"
  | "flow_not_published"
  | "flow_deprecated"
  | "flow_blocked"
  | "flow_screen_missing";

export type TemplateFlowButtonCheck =
  | { result: "pending"; button: TemplateFlowButton }
  | { result: "ok"; button: TemplateFlowButton; flowName: string | null }
  | {
      result: "unverified";
      button: TemplateFlowButton;
      flowName: string | null;
    }
  | {
      result: "issue";
      button: TemplateFlowButton;
      code: TemplateFlowIssueCode;
      flowName: string | null;
      screenIds: string[] | null;
    };

export type TemplateFlowIssue = Extract<
  TemplateFlowButtonCheck,
  { result: "issue" }
>;

export type TemplateFlowHealthState =
  | "none"
  | "pending"
  | "ok"
  | "unverified"
  | "issue";

export type TemplateFlowHealth = {
  state: TemplateFlowHealthState;
  checks: TemplateFlowButtonCheck[];
  issues: TemplateFlowIssue[];
};

export type TemplateFlowFactsByFlowId = Readonly<
  Record<string, TemplateFlowFacts | undefined>
>;

// THROTTLED Flows still open; Meta only limits how many can be sent.
const OPENABLE_FLOW_STATUSES = new Set(["PUBLISHED", "THROTTLED"]);

export function isOpenableTemplateFlowStatus(status: unknown): boolean {
  return OPENABLE_FLOW_STATUSES.has(upper(status));
}

function upper(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function normalizeTemplateFlowAction(
  value: unknown
): TemplateFlowButton["action"] {
  // Template snapshots store "NAVIGATE" while the editor writes "navigate";
  // Meta treats a missing action as navigate.
  return upper(value) === "DATA_EXCHANGE" ? "data_exchange" : "navigate";
}

/** FLOW buttons that reference a Flow by id. Name/JSON references are skipped. */
export function collectTemplateFlowButtons(
  components: unknown
): TemplateFlowButton[] {
  if (!Array.isArray(components)) return [];
  const buttons: TemplateFlowButton[] = [];
  for (const component of components) {
    if (!isRecord(component) || upper(component.type) !== "BUTTONS") continue;
    if (!Array.isArray(component.buttons)) continue;
    component.buttons.forEach((button: unknown, index: number) => {
      if (!isRecord(button) || upper(button.type) !== "FLOW") return;
      const identifier = pickWhatsAppTemplateFlowIdentifier(button);
      if (identifier?.kind !== "flow_id") return;
      const navigateScreen =
        typeof button.navigate_screen === "string"
          ? button.navigate_screen.trim()
          : "";
      buttons.push({
        index,
        text: typeof button.text === "string" ? button.text.trim() : "",
        flowId: identifier.flow_id,
        action: normalizeTemplateFlowAction(button.flow_action),
        navigateScreen: navigateScreen || null,
      });
    });
  }
  return buttons;
}

/** Whether any button opens a Flow, however the button names it. */
export function hasTemplateFlowButton(components: unknown): boolean {
  return (
    Array.isArray(components) &&
    components.some(
      component =>
        isRecord(component) &&
        upper(component.type) === "BUTTONS" &&
        Array.isArray(component.buttons) &&
        component.buttons.some(
          (button: unknown) => isRecord(button) && upper(button.type) === "FLOW"
        )
    )
  );
}

export function collectTemplateFlowIds(components: unknown): string[] {
  return Array.from(
    new Set(collectTemplateFlowButtons(components).map(button => button.flowId))
  );
}

export function checkTemplateFlowButton(
  button: TemplateFlowButton,
  facts: TemplateFlowFacts | undefined
): TemplateFlowButtonCheck {
  if (!facts) return { result: "pending", button };
  if (facts.state === "unavailable") {
    return { result: "unverified", button, flowName: null };
  }
  if (facts.state === "missing") {
    return {
      result: "issue",
      button,
      code: "flow_missing",
      flowName: null,
      screenIds: null,
    };
  }

  const flowName = facts.name;
  const issue = (code: TemplateFlowIssueCode): TemplateFlowIssue => ({
    result: "issue",
    button,
    code,
    flowName,
    screenIds: facts.screenIds,
  });
  const status = upper(facts.status);
  if (status === "DRAFT") return issue("flow_not_published");
  if (status === "DEPRECATED") return issue("flow_deprecated");
  if (status === "BLOCKED") return issue("flow_blocked");
  if (!isOpenableTemplateFlowStatus(status)) {
    return { result: "unverified", button, flowName };
  }

  if (button.action !== "navigate" || !button.navigateScreen) {
    return { result: "ok", button, flowName };
  }
  if (!facts.screenIds) return { result: "unverified", button, flowName };
  return facts.screenIds.includes(button.navigateScreen)
    ? { result: "ok", button, flowName }
    : issue("flow_screen_missing");
}

export function evaluateTemplateFlowHealth(
  components: unknown,
  factsByFlowId: TemplateFlowFactsByFlowId
): TemplateFlowHealth {
  const checks = collectTemplateFlowButtons(components).map(button =>
    checkTemplateFlowButton(button, factsByFlowId[button.flowId])
  );
  const issues = checks.filter(
    (check): check is TemplateFlowIssue => check.result === "issue"
  );
  const state: TemplateFlowHealthState =
    checks.length === 0
      ? "none"
      : issues.length > 0
        ? "issue"
        : checks.some(check => check.result === "pending")
          ? "pending"
          : checks.some(check => check.result === "unverified")
            ? "unverified"
            : "ok";
  return { state, checks, issues };
}

/**
 * Facts worth caching: a clear answer. An open Flow whose JSON couldn't be
 * read, an unknown status, or a failed read are retried on the next check.
 */
export function isTemplateFlowFactsDefinitive(
  facts: TemplateFlowFacts
): boolean {
  if (facts.state === "missing") return true;
  if (facts.state === "unavailable") return false;
  const status = upper(facts.status);
  if (isOpenableTemplateFlowStatus(status)) return facts.screenIds !== null;
  return status === "DRAFT" || status === "DEPRECATED" || status === "BLOCKED";
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Shape guard for facts that crossed a cache or network boundary. */
export function isTemplateFlowFacts(
  value: unknown
): value is TemplateFlowFacts {
  if (!isRecord(value) || !isWhatsAppFlowGraphId(value.flowId)) return false;
  if (!isIsoTimestamp(value.checkedAt)) return false;
  if (value.state === "missing" || value.state === "unavailable") return true;
  if (value.state !== "found") return false;
  return (
    (value.name === null || typeof value.name === "string") &&
    typeof value.status === "string" &&
    (value.screenIds === null ||
      (Array.isArray(value.screenIds) &&
        value.screenIds.every(id => typeof id === "string")))
  );
}

import type {
  ScenarioWhatsAppServiceMessageDiagnostic,
  ScenarioWhatsAppServiceMessageDiagnosticCode,
} from "@icecore/scenario-contracts";
import { flushSync } from "react-dom";
import { openScenarioCollapsibleAncestors } from "../../../scenario-collapsible-section-dom";

/** DOM attribute for scroll-to-field targeting. */
export const SERVICE_MESSAGE_FIELD_ATTR = "data-sm-field";

export type ServiceMessageFieldError = {
  code: ScenarioWhatsAppServiceMessageDiagnosticCode;
  message: string;
};

export type ServiceMessageFieldErrorMap = Map<string, ServiceMessageFieldError>;

/**
 * Contract paths use `message.*`. Field keys drop that prefix so UI can match
 * controls like `cards.0.interaction.options.2.label`.
 */
export function diagnosticFieldKey(path?: string): string | null {
  const raw = String(path || "").trim();
  if (!raw) return null;
  if (raw === "version" || raw === "message" || raw === "message.kind") {
    return null;
  }
  if (raw.startsWith("message.")) return raw.slice("message.".length);
  return raw;
}

export function buildServiceMessageFieldErrors(params: {
  diagnostics: ScenarioWhatsAppServiceMessageDiagnostic[];
  messageForCode: (
    code: ScenarioWhatsAppServiceMessageDiagnosticCode,
    fieldKey: string
  ) => string;
}): ServiceMessageFieldErrorMap {
  const map: ServiceMessageFieldErrorMap = new Map();
  for (const diagnostic of params.diagnostics) {
    const key = diagnosticFieldKey(diagnostic.path);
    if (!key || map.has(key)) continue;
    map.set(key, {
      code: diagnostic.code,
      message: params.messageForCode(diagnostic.code, key),
    });
  }
  return map;
}

export function fieldErrorMessage(
  map: ServiceMessageFieldErrorMap,
  key: string
): string | undefined {
  return map.get(key)?.message;
}

export function firstServiceMessageFieldKey(
  map: ServiceMessageFieldErrorMap
): string | null {
  for (const key of map.keys()) return key;
  return null;
}

function serviceMessageFieldTargets(scope: ParentNode): Element[] {
  return [...scope.querySelectorAll(`[${SERVICE_MESSAGE_FIELD_ATTR}]`)];
}

/**
 * Whether an element for exactly this field is rendered under `root`. The
 * element marked with a field's key is the one that shows its error.
 */
export function hasServiceMessageField(
  fieldKey: string,
  root: ParentNode | null | undefined
): boolean {
  if (!root) return false;
  return serviceMessageFieldTargets(root).some(
    el => el.getAttribute(SERVICE_MESSAGE_FIELD_ATTR) === fieldKey
  );
}

// Text entry comes first: a group can start with buttons that remove things
// (tag chips, a detail's trash), and Enter on one of those would delete data.
const FIELD_FOCUS_SELECTOR =
  "input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [contenteditable='true']";
const CONTROL_FOCUS_SELECTOR = "button:not(:disabled), [tabindex='0']";

function focusServiceMessageField(target: HTMLElement): void {
  if (
    target.matches(FIELD_FOCUS_SELECTOR) ||
    target.matches(CONTROL_FOCUS_SELECTOR)
  ) {
    target.focus({ preventScroll: true });
    return;
  }
  const focusable =
    target.querySelector(FIELD_FOCUS_SELECTOR) ??
    target.querySelector(CONTROL_FOCUS_SELECTOR);
  if (focusable instanceof HTMLElement) {
    focusable.focus({ preventScroll: true });
    return;
  }
  target.tabIndex = -1;
  target.focus({ preventScroll: true });
}

/** The field itself, else its first sub-field, else its closest group. */
export function findServiceMessageFieldTarget(
  fieldKey: string,
  root?: ParentNode | null
): HTMLElement | null {
  const targets = serviceMessageFieldTargets(root ?? document);
  const target =
    targets.find(
      el => el.getAttribute(SERVICE_MESSAGE_FIELD_ATTR) === fieldKey
    ) ??
    targets.find(el =>
      el.getAttribute(SERVICE_MESSAGE_FIELD_ATTR)?.startsWith(`${fieldKey}.`)
    ) ??
    targets
      .filter(el =>
        fieldKey.startsWith(`${el.getAttribute(SERVICE_MESSAGE_FIELD_ATTR)}.`)
      )
      .sort(
        (a, b) =>
          (b.getAttribute(SERVICE_MESSAGE_FIELD_ATTR)?.length ?? 0) -
          (a.getAttribute(SERVICE_MESSAGE_FIELD_ATTR)?.length ?? 0)
      )[0];
  return target instanceof HTMLElement ? target : null;
}

export function scrollToServiceMessageField(
  fieldKey: string,
  root?: ParentNode | null
): boolean {
  const target = findServiceMessageFieldTarget(fieldKey, root);
  if (!target) return false;
  // A field inside a closed section stays hidden until the section opens.
  flushSync(() => openScenarioCollapsibleAncestors(target));
  target.scrollIntoView({
    behavior: "smooth",
    block: "nearest",
    inline: "nearest",
  });
  focusServiceMessageField(target);
  return true;
}

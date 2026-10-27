import type { ScenarioEditorValidationMode } from "../../../view/node-enrichment/types";
import type {
  ScenarioWhatsAppServiceMessage,
  ScenarioWhatsAppServiceMessageDiagnostic,
  ScenarioWhatsAppServiceMessageDiagnosticCode,
  ScenarioWhatsAppServiceMessagePayload,
} from "@icecore/scenario-contracts";
import type { TranslateFn } from "../../../types";
import {
  buildServiceMessageFieldErrors,
  firstServiceMessageFieldKey,
  type ServiceMessageFieldErrorMap,
} from "./service-message-field-errors";
import {
  getServiceMessageValidationDiagnostics,
  serviceMessageDiagnosticMessageKey,
  serviceMessageDiagnosticMessageValues,
} from "./service-message-validation";

type MessageForCode = (
  code: ScenarioWhatsAppServiceMessageDiagnosticCode,
  fieldKey: string
) => string;

/** Errors passed to the preview bubble, which shows them itself. */
function previewErrorKeys(
  message: ScenarioWhatsAppServiceMessagePayload,
  supportsRenderer: boolean
): ReadonlySet<string> {
  if (!supportsRenderer) return new Set();
  return new Set([
    "body",
    "header.text",
    "headerText",
    "footerText",
    ...(message.kind === "cta_url" ? ["buttonLabel"] : []),
    ...(message.kind === "reply_buttons"
      ? message.options.map((_, index) => `options.${index}.label`)
      : []),
  ]);
}

function firstIssueSummaryMessage(
  fieldErrors: ServiceMessageFieldErrorMap,
  firstFieldKey: string | null,
  diagnostics: ScenarioWhatsAppServiceMessageDiagnostic[],
  messageForCode: MessageForCode
): string | undefined {
  if (firstFieldKey) return fieldErrors.get(firstFieldKey)?.message;
  const first = diagnostics[0];
  return first ? messageForCode(first.code, "") : undefined;
}

/**
 * Validation issues of the message, mapped to the fields that show them, and
 * what the summary notice says about the first one.
 */
export function summarizeServiceMessageValidation({
  value,
  validationMode,
  supportsRenderer,
  t,
}: {
  value: ScenarioWhatsAppServiceMessage;
  validationMode: ScenarioEditorValidationMode;
  supportsRenderer: boolean;
  t: TranslateFn;
}) {
  const diagnostics =
    validationMode === "runnable"
      ? getServiceMessageValidationDiagnostics(value)
      : [];
  const messageForCode: MessageForCode = (code, fieldKey) =>
    t(
      serviceMessageDiagnosticMessageKey(code),
      serviceMessageDiagnosticMessageValues(code, fieldKey, value)
    );
  const fieldErrors = buildServiceMessageFieldErrors({
    diagnostics,
    messageForCode,
  });
  const firstFieldKey = firstServiceMessageFieldKey(fieldErrors);
  return {
    fieldErrors,
    issueCount: diagnostics.length,
    firstFieldKey,
    firstIssueMessage: firstIssueSummaryMessage(
      fieldErrors,
      firstFieldKey,
      diagnostics,
      messageForCode
    ),
    firstIssueInPreview:
      firstFieldKey !== null &&
      previewErrorKeys(value.message, supportsRenderer).has(firstFieldKey),
  };
}

export type ServiceMessageValidationSummary = ReturnType<
  typeof summarizeServiceMessageValidation
>;

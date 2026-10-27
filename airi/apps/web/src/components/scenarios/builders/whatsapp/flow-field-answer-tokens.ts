"use client";

import {
  isScenarioFormAnswerKey,
  listScenarioFormFields,
  scenarioFormAnswerToken,
  type WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";
import { createContext, useContext } from "react";

const NO_ANSWER_TOKENS: ReadonlyMap<string, string> = new Map();

/**
 * Each field's `{{form.<answersKey>.<fieldKey>}}`, by field id. A form
 * without an answers key, such as one built outside a scenario, has none.
 */
export function listFlowFieldAnswerTokens(
  flowConfig: WhatsAppFlowConfig | null | undefined
): ReadonlyMap<string, string> {
  const formKey = flowConfig?.answersKey?.trim() ?? "";
  if (!flowConfig || !isScenarioFormAnswerKey(formKey)) {
    return NO_ANSWER_TOKENS;
  }
  return new Map(
    listScenarioFormFields(flowConfig).map(field => [
      field.responseKey,
      `{{${scenarioFormAnswerToken(formKey, field.key)}}}`,
    ])
  );
}

/** The variables the form being edited gives AI steps, by field id. */
export const FlowFieldAnswerTokensContext =
  createContext<ReadonlyMap<string, string>>(NO_ANSWER_TOKENS);

/** The variables the form being edited gives, by field id; none outside a scenario. */
export function useFlowFieldAnswerTokens(): ReadonlyMap<string, string> {
  return useContext(FlowFieldAnswerTokensContext);
}

/** The variable a field's answer fills in AI steps, if the form has a key. */
export function useFlowFieldAnswerToken(fieldId: string): string | undefined {
  return useFlowFieldAnswerTokens().get(fieldId.trim());
}

import {
  buildScenarioFormSubmission,
  readScenarioFlowResponseRecord,
  recordScenarioFormSubmission,
  type ScenarioFormSubmission,
} from "@icecore/scenario-contracts";
import type { ScenarioRuntimeDependencies } from "./scenario-runtime-dependencies";

/** A contact-info request's reply: a Flow reply, but no scenario form. */
const ADDRESS_MESSAGE_FLOW_NAME = "address_message";

export type SubmittedScenarioForm = {
  scenarioId: string;
  submission: ScenarioFormSubmission;
};

/**
 * The form a Flow reply submitted and its answers, formatted with the form as
 * it was sent, so a form edited after sending still reads as sent. Null for
 * any other event, an address reply, or a form no stored scenario message
 * sent.
 */
export async function readSubmittedScenarioForm(params: {
  findSubmittedScenarioForm: ScenarioRuntimeDependencies<unknown>["findSubmittedScenarioForm"];
  workspaceId: string;
  conversationId: string;
  flowResponseJson: string | null | undefined;
  flowName: string | null | undefined;
  contextMessageId: string | null | undefined;
  inboundMessageId: string;
  submittedAt: Date;
}): Promise<SubmittedScenarioForm | null> {
  if (
    !params.findSubmittedScenarioForm ||
    params.flowName?.trim() === ADDRESS_MESSAGE_FLOW_NAME
  ) {
    return null;
  }
  const response = readScenarioFlowResponseRecord(params.flowResponseJson);
  if (!response) return null;
  const flowToken =
    typeof response.flow_token === "string" ? response.flow_token.trim() : "";
  const source = await params.findSubmittedScenarioForm({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    contextMessageId: params.contextMessageId?.trim() || null,
    flowToken: flowToken || null,
  });
  if (!source) return null;
  const submission = buildScenarioFormSubmission({
    sourceActionNodeId: source.sourceActionNodeId,
    flowId: source.flowId,
    inboundMessageId: params.inboundMessageId,
    submittedAt: params.submittedAt,
    responseJson: params.flowResponseJson,
    fields: source.fields,
  });
  return submission ? { scenarioId: source.scenarioId, submission } : null;
}

/**
 * Scenario state with the submission recorded, or unchanged without one.
 * While another scenario holds the conversation, its answers stay: a form
 * from an earlier scenario is recorded only once that scenario takes the
 * turn (the runtime records it after routing).
 */
export function withSubmittedScenarioForm(
  state: unknown,
  submitted: SubmittedScenarioForm | null,
): unknown {
  if (!submitted) return state;
  const lockedScenarioId =
    state && typeof state === "object"
      ? (state as { lockedScenarioId?: unknown }).lockedScenarioId
      : null;
  if (
    typeof lockedScenarioId === "string" &&
    lockedScenarioId.trim() &&
    lockedScenarioId.trim() !== submitted.scenarioId
  ) {
    return state;
  }
  return recordScenarioFormSubmission(state, submitted);
}

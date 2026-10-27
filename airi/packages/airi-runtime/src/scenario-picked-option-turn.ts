import {
  buildScenarioPickedOption,
  findScenarioWhatsAppServiceOption,
  parseWhatsAppSessionChoicePayload,
  recordScenarioPickedOption,
  type ScenarioPickedOption,
} from "@icecore/scenario-contracts";
import type { ScenarioRuntimeDependencies } from "./scenario-runtime-dependencies";

export type TappedScenarioPick = {
  scenarioId: string;
  pick: ScenarioPickedOption;
};

/**
 * The option a session-choice tap picked, as the stored copy of the tapped
 * message offered it, so a card edited after sending still reads as sent.
 * Null for any other event or when no stored scenario message offers it.
 */
export async function readTappedScenarioPick(params: {
  findTappedScenarioServiceMessage: ScenarioRuntimeDependencies<unknown>["findTappedScenarioServiceMessage"];
  workspaceId: string;
  conversationId: string;
  quickReplyPayload: string | null | undefined;
  contextMessageId: string | null | undefined;
  pickedAt: Date;
}): Promise<TappedScenarioPick | null> {
  const choice = parseWhatsAppSessionChoicePayload(params.quickReplyPayload);
  if (!choice || !params.findTappedScenarioServiceMessage) return null;
  const stored = await params.findTappedScenarioServiceMessage({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    contextMessageId: params.contextMessageId?.trim() || null,
    actionNodeId: choice.actionNodeId,
  });
  if (!stored || !stored.whatsappServiceMessage) return null;
  const option = findScenarioWhatsAppServiceOption(
    stored.whatsappServiceMessage as { command?: unknown },
    params.quickReplyPayload,
  );
  const pick = option
    ? buildScenarioPickedOption({
        sourceActionNodeId: choice.actionNodeId,
        option,
        pickedAt: params.pickedAt,
      })
    : null;
  return pick ? { scenarioId: stored.scenarioId, pick } : null;
}

/** Scenario state with the tap recorded, or the state unchanged without one. */
export function withTappedScenarioPick(
  state: unknown,
  tapped: TappedScenarioPick | null,
): unknown {
  return tapped ? recordScenarioPickedOption(state, tapped) : state;
}

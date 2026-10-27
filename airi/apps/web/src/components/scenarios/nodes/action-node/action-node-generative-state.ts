import {
  listScenarioTemplateTokens,
  type GenerativeAIActionConfig,
  type GenerativeAIActionMode,
} from "@icecore/scenario-contracts";
import type { TranslateFn } from "../../types";
import type {
  ScenarioFormAnswerChoice,
  ScenarioPickedOptionChoice,
} from "../../view/node-enrichment/scenario-node-graph-index";
import { listScenarioFormAnswerChips } from "../../view/scenario-form-answer-labels";
import { resolveScenarioTokenLabel } from "../../view/scenario-template-utils";
import type { ScenarioVariableExtraField } from "../../view/scenario-variable-groups";

export const PICKED_OPTION_KIND_LABEL_KEYS: Record<
  ScenarioPickedOptionChoice["kind"],
  string
> = {
  media_carousel: "generativeAIPickedOptionKindCarousel",
  reply_buttons: "generativeAIPickedOptionKindButtons",
  list: "generativeAIPickedOptionKindList",
};

/** A pick source's name as the canvas shows it, or its message kind. */
export function pickedOptionSourceName(
  source: ScenarioPickedOptionChoice,
  t: TranslateFn
): string {
  return source.label || t(PICKED_OPTION_KIND_LABEL_KEYS[source.kind]);
}

export type GenerativeDataFlowToken = {
  token: string;
  label: string;
  inPrompt: boolean;
  /** A form answer the step can run without. */
  mayBeEmpty: boolean;
};

export type GenerativeDataFlowState = {
  /** One-click tokens, each once: the pick's, then the answers collected before. */
  tokens: GenerativeDataFlowToken[];
  /** The warning for a chosen pick the generation ignores, or null. */
  unusedPickKey: string | null;
};

/** The pick's tokens this source can fill: buttons and lists have no card text. */
function pickedTokens(
  source: ScenarioPickedOptionChoice,
  t: TranslateFn
): Array<{ token: string; label: string }> {
  const tokens =
    source.kind === "media_carousel"
      ? ["picked.text", "picked.label"]
      : ["picked.label"];
  return tokens.map(token => ({
    token,
    label: resolveScenarioTokenLabel(token, t),
  }));
}

function resolveUnusedPickKey(
  pickedSource: ScenarioPickedOptionChoice | undefined,
  pickUsed: boolean
): string | null {
  if (!pickedSource || pickUsed) return null;
  return pickedSource.kind === "media_carousel"
    ? "generativeAIUsesPickUnused"
    : "generativeAIUsesChoiceUnused";
}

/**
 * The tokens that add the customer's pick, the answers collected before this
 * step and the answers of earlier forms, and whether the generation ignores
 * a chosen pick.
 */
export function resolveGenerativeDataFlow({
  config,
  mode,
  pickedSource,
  promptInputFields,
  formAnswerSources,
  t,
}: {
  config: GenerativeAIActionConfig;
  mode: GenerativeAIActionMode;
  /** The chosen pick's message, when it still comes before this step. */
  pickedSource: ScenarioPickedOptionChoice | undefined;
  promptInputFields: readonly ScenarioVariableExtraField[];
  formAnswerSources?: readonly ScenarioFormAnswerChoice[];
  t: TranslateFn;
}): GenerativeDataFlowState {
  const used = new Set(listScenarioTemplateTokens(config.prompt));
  const pickTokens = pickedSource ? pickedTokens(pickedSource, t) : [];
  const pickUsed = pickedSource
    ? pickTokens.some(token => used.has(token.token)) ||
      // A card image the reference rules reject is never sent, so it is not used.
      (pickedSource.kind === "media_carousel" &&
        mode === "text_to_image" &&
        config.pickedOption?.includeCardImage === true &&
        pickedSource.cardImagesUsable === true)
    : false;

  // A form's text field read as {{input.<id>}} shows only where it is used.
  const answerFields = promptInputFields.filter(
    field => !field.legacy || used.has(field.token)
  );
  const chips = new Map<string, GenerativeDataFlowToken>();
  for (const chip of [
    ...pickTokens,
    ...answerFields,
    ...listScenarioFormAnswerChips(formAnswerSources),
  ]) {
    // Forms that share a key while that is an error give the same token.
    if (chips.has(chip.token)) continue;
    chips.set(chip.token, {
      token: chip.token,
      label: chip.label,
      inPrompt: used.has(chip.token),
      mayBeEmpty: "mayBeEmpty" in chip && chip.mayBeEmpty === true,
    });
  }
  return {
    tokens: Array.from(chips.values()),
    unusedPickKey: resolveUnusedPickKey(pickedSource, pickUsed),
  };
}

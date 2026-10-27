"use client";

import {
  isGenerativeAIActionMode,
  readGenerativeAISafety,
  resolveGenerativeAIExpectedInputKind,
  type GenerativeAIActionConfig,
  type GenerativeAIActionMode,
  type GenerativeAIImageConfig,
} from "@icecore/scenario-contracts";
import { useId } from "react";
import { createDefaultGenerativeAIActionConfig } from "../../graph/node-palette";
import type { ScenarioPickedOptionChoice } from "../../view/node-enrichment/scenario-node-graph-index";
import { insertScenarioTemplateToken } from "../../view/scenario-template-utils";
import {
  createDefaultGenerativeImageConfig,
  type GenerativePickedCardImage,
} from "./action-node-generative-image-settings";

type PatchGenerativeAIConfig = (
  next: Partial<GenerativeAIActionConfig>
) => void;

/** What a video mode waits for, said under the mode; images need no line. */
function resolveInputHintKey(mode: GenerativeAIActionMode): string | null {
  if (mode === "text_to_image") return null;
  return resolveGenerativeAIExpectedInputKind(mode) === "image"
    ? "generativeAIWaitingForImage"
    : "generativeAIWaitingForText";
}

/**
 * The picked card's image tile: always for a carousel pick, and for any
 * other pick while its saved card image is on, so it can be turned off.
 */
function resolvePickedCardImage(
  pickedOption: GenerativeAIActionConfig["pickedOption"],
  pickedSource: ScenarioPickedOptionChoice | undefined,
  patchConfig: PatchGenerativeAIConfig
): GenerativePickedCardImage | undefined {
  const fromCarousel = pickedSource?.kind === "media_carousel";
  if (!pickedOption || (!fromCarousel && !pickedOption.includeCardImage)) {
    return undefined;
  }
  return {
    included: pickedOption.includeCardImage,
    cardImagesUsable: fromCarousel ? pickedSource.cardImagesUsable : true,
    onToggle: includeCardImage =>
      patchConfig({
        pickedOption: { ...pickedOption, includeCardImage },
      }),
  };
}

/**
 * What the generative AI section edits: the saved config or a new one, the
 * pick's message and the image settings. Every patch keeps the mode and
 * the instructions.
 */
export function useActionNodeGenerativeAI({
  config,
  patchNode,
  workspaceId,
  pickedOptionSources,
}: {
  config?: GenerativeAIActionConfig;
  patchNode: (patch: {
    actionGenerativeAIConfig: GenerativeAIActionConfig;
  }) => void;
  workspaceId?: string;
  pickedOptionSources: readonly ScenarioPickedOptionChoice[];
}) {
  const modeId = useId();
  const draft = config ?? createDefaultGenerativeAIActionConfig();
  const mode = isGenerativeAIActionMode(draft.mode)
    ? draft.mode
    : "text_to_video";
  const pickedOption = draft.pickedOption;
  const pickedSource = pickedOptionSources.find(
    source => source.nodeId === pickedOption?.sourceActionNodeId
  );
  const imageConfig = draft.image ?? createDefaultGenerativeImageConfig();

  const patchConfig: PatchGenerativeAIConfig = next => {
    patchNode({
      actionGenerativeAIConfig: {
        ...draft,
        version: 1,
        mode,
        prompt: draft.prompt,
        ...next,
      },
    });
  };

  const selectMode = (value: string) => {
    if (!isGenerativeAIActionMode(value)) return;
    patchConfig({
      mode: value,
      ...(value === "text_to_image" ? { image: imageConfig } : {}),
    });
  };

  return {
    modeId,
    draft,
    mode,
    pickedOption,
    pickedSource,
    safety: readGenerativeAISafety(draft),
    imageConfig,
    // Image settings need the workspace for its Google AI connection.
    imageWorkspaceId:
      mode === "text_to_image" && workspaceId ? workspaceId : null,
    inputHintKey: resolveInputHintKey(mode),
    pickedCardImage: resolvePickedCardImage(
      pickedOption,
      pickedSource,
      patchConfig
    ),
    patchConfig,
    patchImage: (image: GenerativeAIImageConfig) => patchConfig({ image }),
    selectMode,
    insertPromptToken: (token: string) =>
      patchConfig({
        prompt: insertScenarioTemplateToken(draft.prompt, token),
      }),
  };
}

export type ActionNodeGenerativeAI = ReturnType<
  typeof useActionNodeGenerativeAI
>;

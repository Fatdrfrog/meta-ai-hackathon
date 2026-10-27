"use client";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  MAX_GENERATIVE_AI_IMAGE_PROMPT_CHARACTERS,
  type GenerativeAIActionMode,
} from "@icecore/scenario-contracts";
import { useId, type ReactNode } from "react";
import { ScenarioInfoHint } from "../../scenario-info-hint";
import { ScenarioInlineNotice } from "../../scenario-inline-notice";
import type { TranslateFn } from "../../types";
import type { ScenarioEditorValidationMode } from "../../view/node-enrichment/types";
import { describeUnsupportedScenarioTemplateTokens } from "../../view/scenario-template-utils";

const PLACEHOLDER_KEYS: Record<GenerativeAIActionMode, string> = {
  text_to_video: "generativeAIPromptPlaceholder",
  image_to_video: "generativeAIPromptPhotoPlaceholder",
  text_to_image: "generativeAIImagePromptPlaceholder",
};

/** The counter shows once the instructions pass 90% of the image limit. */
const PROMPT_COUNTER_THRESHOLD = Math.floor(
  MAX_GENERATIVE_AI_IMAGE_PROMPT_CHARACTERS * 0.9
);

/** Why the prompt cannot be saved or run, or null when it can. */
function describePromptError(
  prompt: string,
  mode: GenerativeAIActionMode,
  validationMode: ScenarioEditorValidationMode,
  t: TranslateFn
): string | null {
  if (
    mode === "text_to_image" &&
    prompt.length > MAX_GENERATIVE_AI_IMAGE_PROMPT_CHARACTERS
  ) {
    return t("generativeAIImagePromptTooLong", {
      max: MAX_GENERATIVE_AI_IMAGE_PROMPT_CHARACTERS,
    });
  }
  return validationMode === "runnable" && !prompt.trim()
    ? t("generativeAIPromptRequired")
    : null;
}

/** The generation instructions with their limit, validation and token messages. */
export function ActionNodeGenerativePromptField({
  prompt,
  mode,
  validationMode,
  onChange,
  t,
  children,
}: {
  prompt: string;
  mode: GenerativeAIActionMode;
  validationMode: ScenarioEditorValidationMode;
  onChange: (prompt: string) => void;
  t: TranslateFn;
  /** Rendered after the prompt's messages. */
  children?: ReactNode;
}) {
  const promptId = useId();
  const promptErrorId = `${promptId}-error`;
  const promptLimitId = `${promptId}-limit`;
  const promptCounterId = `${promptId}-counter`;
  const imageMode = mode === "text_to_image";
  const showCounter = imageMode && prompt.length > PROMPT_COUNTER_THRESHOLD;
  const promptError = describePromptError(prompt, mode, validationMode, t);
  const promptInvalid = promptError !== null;
  const promptTokenWarning = describeUnsupportedScenarioTemplateTokens(
    prompt,
    t
  );
  const promptLabel = t("generativeAIPromptLabel");
  const promptDescriptionIds = [
    imageMode ? promptLimitId : null,
    showCounter ? promptCounterId : null,
    promptInvalid ? promptErrorId : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="space-y-1">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-0.5">
          <Label
            htmlFor={promptId}
            className="text-[11px] font-medium text-foreground"
          >
            {promptLabel}
          </Label>
          {imageMode ? (
            <ScenarioInfoHint
              label={t("infoHintLabel", { topic: promptLabel })}
              describedById={promptLimitId}
            >
              {t("generativeAIPromptLimitInfo", {
                max: MAX_GENERATIVE_AI_IMAGE_PROMPT_CHARACTERS,
              })}
            </ScenarioInfoHint>
          ) : null}
        </div>
        {showCounter ? (
          <span
            id={promptCounterId}
            className="shrink-0 text-[10px] tabular-nums text-muted-foreground"
            data-testid="generative-ai-prompt-counter"
          >
            {t("generativeAIPromptCounter", {
              count: prompt.length,
              max: MAX_GENERATIVE_AI_IMAGE_PROMPT_CHARACTERS,
            })}
          </span>
        ) : null}
      </div>
      <Textarea
        id={promptId}
        rows={4}
        maxLength={
          imageMode ? MAX_GENERATIVE_AI_IMAGE_PROMPT_CHARACTERS : undefined
        }
        value={prompt}
        onChange={event => onChange(event.target.value)}
        placeholder={t(PLACEHOLDER_KEYS[mode])}
        className={cn(
          "nodrag nopan nokey min-h-24 resize-y bg-background text-sm",
          imageMode && "max-h-80 overflow-y-auto"
        )}
        aria-invalid={promptInvalid}
        aria-describedby={promptDescriptionIds || undefined}
      />
      {promptInvalid ? (
        <p
          id={promptErrorId}
          role="alert"
          className="text-[11px] leading-snug text-destructive"
        >
          {promptError}
        </p>
      ) : null}
      {promptTokenWarning ? (
        <ScenarioInlineNotice>{promptTokenWarning}</ScenarioInlineNotice>
      ) : null}
      {children}
    </div>
  );
}

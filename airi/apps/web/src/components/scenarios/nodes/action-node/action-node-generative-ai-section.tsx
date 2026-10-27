"use client";

import { FieldDescription } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  isGenerativeAIActionMode,
  type GenerativeAIActionConfig,
  type GenerativeAIActionMode,
} from "@icecore/scenario-contracts";
import { Fragment, type ReactNode } from "react";
import { ScenarioCheckboxField } from "../../scenario-checkbox-field";
import type { ScenarioVariableExtraField } from "../../view/scenario-variable-inserter";
import type { ScenarioActionMedia } from "../../view/node-enrichment/types";
import {
  ActionNodeGenerativeImageFormat,
  ActionNodeGenerativeImageSource,
  ActionNodeGenerativeReferenceImages,
} from "./action-node-generative-image-settings";
import { ActionNodeGenerativePickedOption } from "./action-node-generative-picked-option";
import { ActionNodeGenerativeDataFlow } from "./action-node-generative-data-flow";
import { ActionNodeGenerativePromptField } from "./action-node-generative-prompt-field";
import { ActionNodeGenerativeSafety } from "./action-node-generative-safety";
import type {
  ScenarioFormAnswerChoice,
  ScenarioPickedOptionChoice,
} from "../../view/node-enrichment/scenario-node-graph-index";
import type { TranslateFn } from "../../types";
import type { ScenarioEditorValidationMode } from "../../view/node-enrichment/types";
import {
  useActionNodeGenerativeAI,
  type ActionNodeGenerativeAI,
} from "./use-action-node-generative-ai";

type GenerativeAIModeOption = {
  id: GenerativeAIActionMode | "audio" | "avatar" | "image" | "text";
  labelKey: string;
  enabled: boolean;
};

// Supported modes come first; the rest are announced as coming soon.
const GENERATIVE_AI_MODE_OPTIONS: readonly GenerativeAIModeOption[] = (
  [
    { id: "text_to_image", labelKey: "generativeAIModeImage" },
    { id: "text_to_video", labelKey: "generativeAIModeTextToVideo" },
    { id: "image_to_video", labelKey: "generativeAIModeImageToVideo" },
    { id: "audio", labelKey: "generativeAIModeAudio" },
    { id: "avatar", labelKey: "generativeAIModeAvatar" },
    { id: "text", labelKey: "generativeAIModeText" },
  ] as const
).map(option => ({
  ...option,
  enabled: isGenerativeAIActionMode(option.id),
}));

const ENABLED_MODE_OPTIONS = GENERATIVE_AI_MODE_OPTIONS.filter(
  option => option.enabled
);
const COMING_SOON_MODE_OPTIONS = GENERATIVE_AI_MODE_OPTIONS.filter(
  option => !option.enabled
);

const NO_PICKED_OPTION_SOURCES: readonly ScenarioPickedOptionChoice[] = [];
const NO_PROMPT_INPUT_FIELDS: ScenarioVariableExtraField[] = [];

export function ActionNodeGenerativeAISection({
  config,
  patchNode,
  t,
  validationMode = "runnable",
  workspaceId,
  upload,
  promptInputFields = NO_PROMPT_INPUT_FIELDS,
  pickedOptionSources = NO_PICKED_OPTION_SOURCES,
  formAnswerSources,
  layout = "card",
}: {
  config?: GenerativeAIActionConfig;
  patchNode: (patch: {
    actionGenerativeAIConfig: GenerativeAIActionConfig;
  }) => void;
  t: TranslateFn;
  validationMode?: ScenarioEditorValidationMode;
  workspaceId?: string;
  upload?: ScenarioActionMedia["upload"];
  promptInputFields?: ScenarioVariableExtraField[];
  pickedOptionSources?: readonly ScenarioPickedOptionChoice[];
  /** Earlier forms whose answers the instructions can use. */
  formAnswerSources?: readonly ScenarioFormAnswerChoice[];
  /** "panel": the settings panel, which needs no box of its own. */
  layout?: "card" | "panel";
}) {
  const generativeAI = useActionNodeGenerativeAI({
    config,
    patchNode,
    workspaceId,
    pickedOptionSources,
  });
  const inPanel = layout === "panel";

  const groups: Array<{ id: string; content: ReactNode }> = [
    {
      id: "mode",
      content: (
        <ActionNodeGenerativeModeGroup generativeAI={generativeAI} t={t} />
      ),
    },
    {
      id: "instructions",
      content: (
        <ActionNodeGenerativeInstructionsGroup
          generativeAI={generativeAI}
          pickedOptionSources={pickedOptionSources}
          promptInputFields={promptInputFields}
          formAnswerSources={formAnswerSources}
          validationMode={validationMode}
          t={t}
        />
      ),
    },
    ...(generativeAI.imageWorkspaceId
      ? [
          {
            id: "image",
            content: (
              <ActionNodeGenerativeImageGroup
                generativeAI={generativeAI}
                workspaceId={generativeAI.imageWorkspaceId}
                upload={upload}
                t={t}
              />
            ),
          },
        ]
      : []),
  ];

  return (
    <section
      className={cn(
        "space-y-3",
        !inPanel && "rounded-lg border border-border/70 bg-muted/20 p-3"
      )}
      data-testid="generative-ai-editor"
    >
      {groups.map((group, index) => (
        <Fragment key={group.id}>
          {inPanel && index > 0 ? <Separator /> : null}
          {group.content}
        </Fragment>
      ))}
      {/* The section's own top border separates it from the fields above. */}
      <ActionNodeGenerativeSafety
        safety={generativeAI.safety}
        onChange={next => generativeAI.patchConfig({ safety: next })}
        className={inPanel ? undefined : "-mx-3"}
        contentClassName="px-3 pb-2 pt-1"
        t={t}
      />
      <p className="text-[11px] leading-snug text-muted-foreground">
        {t("generativeAIFailureRouteHint")}
      </p>
    </section>
  );
}

/** What to create, what that mode waits for, and the image's Google AI. */
function ActionNodeGenerativeModeGroup({
  generativeAI,
  t,
}: {
  generativeAI: ActionNodeGenerativeAI;
  t: TranslateFn;
}) {
  const { modeId, inputHintKey, imageWorkspaceId } = generativeAI;
  const modeHintId = `${modeId}-hint`;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label
          htmlFor={modeId}
          className="text-[11px] font-medium text-foreground"
        >
          {t("generativeAIModeLabel")}
        </Label>
        <Select
          value={generativeAI.mode}
          onValueChange={generativeAI.selectMode}
        >
          <SelectTrigger
            id={modeId}
            aria-describedby={inputHintKey ? modeHintId : undefined}
            className="nodrag nopan nokey h-8 w-full bg-background"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ENABLED_MODE_OPTIONS.map(option => (
              <SelectItem
                key={option.id}
                value={option.id}
                data-testid={`generative-ai-mode-${option.id}`}
              >
                {t(option.labelKey)}
              </SelectItem>
            ))}
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>{t("generativeAIComingSoon")}</SelectLabel>
              {COMING_SOON_MODE_OPTIONS.map(option => (
                <SelectItem
                  key={option.id}
                  value={option.id}
                  disabled
                  data-testid={`generative-ai-mode-${option.id}`}
                >
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {inputHintKey ? (
          <FieldDescription
            id={modeHintId}
            className="text-[11px] leading-snug"
          >
            {t(inputHintKey)}
          </FieldDescription>
        ) : null}
      </div>
      {imageWorkspaceId ? (
        <ActionNodeGenerativeImageSource
          key={imageWorkspaceId}
          workspaceId={imageWorkspaceId}
          config={generativeAI.imageConfig}
          onChange={generativeAI.patchImage}
          t={t}
        />
      ) : null}
    </div>
  );
}

/** The customer's pick, the instructions and, for images, the last message. */
function ActionNodeGenerativeInstructionsGroup({
  generativeAI,
  pickedOptionSources,
  promptInputFields,
  formAnswerSources,
  validationMode,
  t,
}: {
  generativeAI: ActionNodeGenerativeAI;
  pickedOptionSources: readonly ScenarioPickedOptionChoice[];
  promptInputFields: ScenarioVariableExtraField[];
  formAnswerSources: readonly ScenarioFormAnswerChoice[] | undefined;
  validationMode: ScenarioEditorValidationMode;
  t: TranslateFn;
}) {
  const { draft, mode, pickedSource, imageConfig, patchConfig } = generativeAI;

  return (
    <div className="space-y-3">
      <ActionNodeGenerativePickedOption
        value={generativeAI.pickedOption}
        selected={pickedSource}
        sources={pickedOptionSources}
        mode={mode}
        referenceCount={draft.image?.referenceImages.length ?? 0}
        onChange={next => patchConfig({ pickedOption: next })}
        t={t}
      />
      <ActionNodeGenerativePromptField
        prompt={draft.prompt}
        mode={mode}
        validationMode={validationMode}
        onChange={prompt => patchConfig({ prompt })}
        t={t}
      >
        <ActionNodeGenerativeDataFlow
          config={draft}
          mode={mode}
          pickedSource={pickedSource}
          promptInputFields={promptInputFields}
          formAnswerSources={formAnswerSources}
          onInsertToken={generativeAI.insertPromptToken}
          t={t}
        />
      </ActionNodeGenerativePromptField>
      {generativeAI.imageWorkspaceId ? (
        <ScenarioCheckboxField
          label={t("generativeAIIncludeInboundText")}
          checked={imageConfig.includeInboundText}
          onCheckedChange={includeInboundText =>
            generativeAI.patchImage({ ...imageConfig, includeInboundText })
          }
        />
      ) : null}
    </div>
  );
}

/** Reference images and the image's format, per workspace. */
function ActionNodeGenerativeImageGroup({
  generativeAI,
  workspaceId,
  upload,
  t,
}: {
  generativeAI: ActionNodeGenerativeAI;
  workspaceId: string;
  upload?: ScenarioActionMedia["upload"];
  t: TranslateFn;
}) {
  return (
    <div className="space-y-3">
      <ActionNodeGenerativeReferenceImages
        key={workspaceId}
        config={generativeAI.imageConfig}
        upload={upload}
        onChange={generativeAI.patchImage}
        pickedCardImage={generativeAI.pickedCardImage}
        t={t}
      />
      <ActionNodeGenerativeImageFormat
        config={generativeAI.imageConfig}
        onChange={generativeAI.patchImage}
        t={t}
      />
    </div>
  );
}

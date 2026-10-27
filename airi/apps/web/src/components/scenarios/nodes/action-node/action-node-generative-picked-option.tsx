"use client";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MAX_GENERATIVE_AI_REFERENCE_IMAGES,
  type GenerativeAIActionMode,
  type GenerativeAIPickedOptionSource,
} from "@icecore/scenario-contracts";
import { useId } from "react";
import type { TranslateFn } from "../../types";
import type { ScenarioPickedOptionChoice } from "../../view/node-enrichment/scenario-node-graph-index";
import {
  PICKED_OPTION_KIND_LABEL_KEYS,
  pickedOptionSourceName,
} from "./action-node-generative-state";

const NO_PICKED_OPTION = "__none__";

/** Whether a node's picked card image fits its references and its sources. */
function canUsePickedCardImage(params: {
  mode: GenerativeAIActionMode;
  source: ScenarioPickedOptionChoice | undefined;
  referenceCount: number;
}): boolean {
  return (
    params.mode === "text_to_image" &&
    params.source?.kind === "media_carousel" &&
    params.source.cardImagesUsable &&
    params.referenceCount < MAX_GENERATIVE_AI_REFERENCE_IMAGES
  );
}

/**
 * Which earlier buttons, list or carousel message the generation reads the
 * customer's choice from. Hidden until such a message comes before the step.
 */
export function ActionNodeGenerativePickedOption({
  value,
  selected,
  sources,
  mode,
  referenceCount,
  onChange,
  t,
}: {
  value: GenerativeAIPickedOptionSource | undefined;
  /** The source `value` names, when it is still among `sources`. */
  selected: ScenarioPickedOptionChoice | undefined;
  sources: readonly ScenarioPickedOptionChoice[];
  mode: GenerativeAIActionMode;
  referenceCount: number;
  onChange: (value: GenerativeAIPickedOptionSource | undefined) => void;
  t: TranslateFn;
}) {
  const selectId = useId();
  const errorId = `${selectId}-error`;
  const missing = Boolean(value && !selected);

  if (sources.length === 0 && !value) return null;

  return (
    <div className="space-y-1" data-testid="generative-ai-picked-option">
      <Label htmlFor={selectId} className="text-[11px] font-medium">
        {t("generativeAIPickedOptionLabel")}
      </Label>
      <Select
        value={value?.sourceActionNodeId ?? NO_PICKED_OPTION}
        onValueChange={nodeId => {
          if (nodeId === NO_PICKED_OPTION) {
            onChange(undefined);
            return;
          }
          const source = sources.find(item => item.nodeId === nodeId);
          if (!source) return;
          onChange({
            sourceActionNodeId: source.nodeId,
            includeCardImage: canUsePickedCardImage({
              mode,
              source,
              referenceCount,
            }),
          });
        }}
      >
        <SelectTrigger
          id={selectId}
          aria-describedby={missing ? errorId : undefined}
          aria-invalid={missing}
          className="nodrag nopan nokey w-full min-w-0 bg-background text-xs *:data-[slot=select-value]:min-w-0"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_PICKED_OPTION}>
            {t("generativeAIPickedOptionNone")}
          </SelectItem>
          {sources.map(source => {
            const name = pickedOptionSourceName(source, t);
            return (
              <SelectItem
                key={source.nodeId}
                value={source.nodeId}
                textValue={name}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{name}</span>
                  {/* An unnamed message is already called by its kind. */}
                  {source.label ? (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {t(PICKED_OPTION_KIND_LABEL_KEYS[source.kind])}
                    </span>
                  ) : null}
                </span>
              </SelectItem>
            );
          })}
          {missing && value ? (
            <SelectItem value={value.sourceActionNodeId} disabled>
              {t("generativeAIPickedOptionUnavailableSource")}
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
      {missing ? (
        <p id={errorId} className="text-[11px] leading-snug text-destructive">
          {t("generativeAIPickedOptionMissing")}
        </p>
      ) : null}
    </div>
  );
}

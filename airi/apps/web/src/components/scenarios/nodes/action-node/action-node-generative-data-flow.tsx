"use client";

import { cn } from "@/lib/utils";
import type {
  GenerativeAIActionConfig,
  GenerativeAIActionMode,
} from "@icecore/scenario-contracts";
import { Check, Plus } from "lucide-react";
import { useMemo, type SyntheticEvent } from "react";
import { ScenarioInlineNotice } from "../../scenario-inline-notice";
import type { TranslateFn } from "../../types";
import type {
  ScenarioFormAnswerChoice,
  ScenarioPickedOptionChoice,
} from "../../view/node-enrichment/scenario-node-graph-index";
import { ScenarioFormAnswerNotices } from "../../view/scenario-form-answer-notices";
import type { ScenarioTokenSource } from "../../view/scenario-template-utils";
import { buildScenarioFormAnswerVariableFields } from "../../view/scenario-variable-groups";
import {
  ScenarioVariableInserter,
  type ScenarioVariableExtraField,
} from "../../view/scenario-variable-inserter";
import { useScenarioFormAnswerNotices } from "../../view/use-scenario-ai-prompt-variables";
import {
  resolveGenerativeDataFlow,
  type GenerativeDataFlowToken,
} from "./action-node-generative-state";

// The chips already offer the pick; the reply window means nothing to AI.
const AI_EXCLUDED_VARIABLE_SOURCES: readonly ScenarioTokenSource[] = [
  "picked",
  "countdown",
];

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

/** One-click chip: adds a token, or shows it is already in the prompt. */
function GenerativeDataFlowChip({
  chip,
  onInsertToken,
  t,
}: {
  chip: GenerativeDataFlowToken;
  onInsertToken: (token: string) => void;
  t: TranslateFn;
}) {
  const Icon = chip.inPrompt ? Check : Plus;
  // A dashed border marks an answer the step may run without.
  const label = chip.mayBeEmpty
    ? t("generativeAITokenMayBeEmpty", { label: chip.label })
    : chip.label;
  return (
    <button
      type="button"
      className={cn(
        "nodrag nopan nokey inline-flex min-h-6 min-w-0 max-w-full items-center gap-1 rounded-md border px-1.5 text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        chip.inPrompt
          ? "border-rose-200 bg-rose-100 text-rose-900 hover:bg-rose-200/80 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-100"
          : "border-border bg-background text-foreground hover:bg-muted/60",
        chip.mayBeEmpty && "border-dashed"
      )}
      aria-label={t(
        chip.inPrompt
          ? "generativeAITokenAddedAria"
          : "generativeAIAddTokenAria",
        { label }
      )}
      data-testid={`generative-ai-data-flow-token-${chip.token}`}
      data-in-prompt={chip.inPrompt}
      data-may-be-empty={chip.mayBeEmpty || undefined}
      onPointerDown={stopPropagation}
      onClick={event => {
        event.stopPropagation();
        onInsertToken(chip.token);
      }}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{chip.label}</span>
    </button>
  );
}

/**
 * One-click chips for the customer's pick, the answers collected before this
 * step and earlier forms' answers, the Variables menu, and notices about a
 * chosen pick that is unused and form answers the step may not get.
 */
export function ActionNodeGenerativeDataFlow({
  config,
  mode,
  pickedSource,
  promptInputFields,
  formAnswerSources,
  onInsertToken,
  t,
}: {
  config: GenerativeAIActionConfig;
  mode: GenerativeAIActionMode;
  /** The chosen pick's message, when it still comes before this step. */
  pickedSource: ScenarioPickedOptionChoice | undefined;
  promptInputFields: ScenarioVariableExtraField[];
  formAnswerSources?: readonly ScenarioFormAnswerChoice[];
  onInsertToken: (token: string) => void;
  t: TranslateFn;
}) {
  // Collected details are chips only. Forms also go in the menu, which shows
  // each form's group, what may be empty and forms made in Meta.
  const menuFields = useMemo(
    () => buildScenarioFormAnswerVariableFields(formAnswerSources, t),
    [formAnswerSources, t]
  );
  const notices = useScenarioFormAnswerNotices(
    config.prompt,
    formAnswerSources,
    "generative",
    t
  );
  const { tokens, unusedPickKey } = resolveGenerativeDataFlow({
    config,
    mode,
    pickedSource,
    promptInputFields,
    formAnswerSources,
    t,
  });

  return (
    <div className="space-y-1.5" data-testid="generative-ai-data-flow">
      <div className="flex items-start gap-2">
        {tokens.length > 0 ? (
          <div
            role="group"
            aria-label={t("generativeAIUsesAddToken")}
            className="flex min-w-0 flex-1 flex-wrap gap-1"
          >
            {tokens.map(chip => (
              <GenerativeDataFlowChip
                key={chip.token}
                chip={chip}
                onInsertToken={onInsertToken}
                t={t}
              />
            ))}
          </div>
        ) : null}
        <div className="ml-auto shrink-0">
          <ScenarioVariableInserter
            t={t}
            variant="onLight"
            extraFields={menuFields}
            excludeSources={AI_EXCLUDED_VARIABLE_SOURCES}
            onInsertToken={onInsertToken}
          />
        </div>
      </div>
      {unusedPickKey ? (
        <ScenarioInlineNotice data-testid="generative-ai-pick-unused">
          {t(unusedPickKey)}
        </ScenarioInlineNotice>
      ) : null}
      <ScenarioFormAnswerNotices notices={notices} />
    </div>
  );
}

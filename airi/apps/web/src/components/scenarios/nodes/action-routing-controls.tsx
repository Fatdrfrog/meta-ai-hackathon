"use client";

import type {
  ScenarioAnswerMatchMode,
  ScenarioAnswerMatchRule,
  TranslateFn,
} from "@/components/scenarios/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  normalizeAnswerMatchRuleId,
  normalizeAnswerMatchRules,
  normalizeMissingTextPhrases,
} from "@icecore/scenario-contracts";
import { cn } from "@/lib/utils";
import { PlusCircle, Trash2 } from "lucide-react";
import { useCallback, useId, useMemo, type SyntheticEvent } from "react";
import {
  ScenarioSelectItemContent,
  SCENARIO_SELECT_TRIGGER_HIDE_DESCRIPTION_CLASS,
} from "../scenario-select-item-description";
import { ScenarioSourceHandleButton } from "../source-handle-button";
import { getAnswerRuleSourceHandleCopy } from "../view/scenario-source-handle-copy";
import { useSyncedDraftValue } from "./draft-state";

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

export type MissingTextPhrasesEditorProps = {
  phrases?: string[];
  t: TranslateFn;
  label?: string;
  /** Keeps the label for screen readers only, under a heading that shows it. */
  hideLabel?: boolean;
  placeholder?: string;
  hint?: string | null;
  disabled?: boolean;
  onCommit: (phrases: string[]) => void;
};

export function MissingTextPhrasesEditor({
  phrases,
  t,
  label = t("postActionConditionMissingText"),
  hideLabel = false,
  placeholder = t("postActionConditionMissingTextPlaceholder"),
  hint = t("postActionConditionMissingTextHint"),
  disabled = false,
  onCommit,
}: MissingTextPhrasesEditorProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const normalizedValue = useMemo(
    () => normalizeMissingTextPhrases(phrases).join("\n"),
    [phrases]
  );
  const [draft, setDraft] = useSyncedDraftValue(normalizedValue);

  const commitDraft = useCallback(() => {
    const next = normalizeMissingTextPhrases(draft);
    if (next.join("\n") === normalizedValue) return;
    onCommit(next);
  }, [draft, normalizedValue, onCommit]);

  return (
    <div className="space-y-1">
      <label
        htmlFor={id}
        className={cn(
          "text-[11px] font-medium text-muted-foreground",
          hideLabel && "sr-only"
        )}
      >
        {label}
      </label>
      <Textarea
        id={id}
        value={draft}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={event => setDraft(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={stopPropagation}
        onPointerDown={stopPropagation}
        onClick={stopPropagation}
        placeholder={placeholder}
        className="nodrag nopan nokey nowheel min-h-[68px] resize-y text-[11px]"
        rows={3}
      />
      {hint ? (
        <p
          id={hintId}
          className="text-[10px] leading-snug text-muted-foreground"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const ANSWER_MATCH_MODES = [
  "exact",
  "intent",
] as const satisfies readonly ScenarioAnswerMatchMode[];

const ANSWER_MATCH_MODE_KEYS: Record<
  ScenarioAnswerMatchMode,
  { label: string; shortLabel: string; description: string }
> = {
  exact: {
    label: "postActionAnswerMatchExact",
    shortLabel: "postActionAnswerMatchExactShort",
    description: "postActionAnswerMatchExactHint",
  },
  intent: {
    label: "postActionAnswerMatchIntent",
    shortLabel: "postActionAnswerMatchIntentShort",
    description: "postActionAnswerMatchIntentHint",
  },
};

function isAnswerMatchMode(value: string): value is ScenarioAnswerMatchMode {
  return (ANSWER_MATCH_MODES as readonly string[]).includes(value);
}

function createAnswerMatchRuleId() {
  const randomId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  return normalizeAnswerMatchRuleId(`answer_${randomId}`);
}

export type AnswerMatchRulesEditorProps = {
  rules?: ScenarioAnswerMatchRule[];
  t: TranslateFn;
  addLabel?: string;
  connectedHandleIds?: ReadonlySet<string>;
  connectable?: boolean;
  disabled?: boolean;
  getHandleId: (ruleId: string) => string;
  onCreateNodeFromSourceHandle?: (
    sourceHandleId: string,
    clientX: number,
    clientY: number
  ) => void;
  onHandlesChanged?: () => void;
  onRulesChange: (rules: ScenarioAnswerMatchRule[]) => void;
  /** Render each rule's handle; node settings edit rules without them. */
  showPorts?: boolean;
};

export function AnswerMatchRulesEditor({
  rules,
  t,
  addLabel = t("postActionAnswerMatchAdd"),
  connectedHandleIds,
  connectable = true,
  disabled = false,
  getHandleId,
  onCreateNodeFromSourceHandle,
  onHandlesChanged,
  onRulesChange,
  showPorts = true,
}: AnswerMatchRulesEditorProps) {
  const normalizedRules = useMemo(
    () => normalizeAnswerMatchRules(rules),
    [rules]
  );

  const updateRule = useCallback(
    (ruleId: string, patch: Partial<ScenarioAnswerMatchRule>) => {
      onRulesChange(
        normalizedRules.map(rule =>
          rule.id === ruleId ? { ...rule, ...patch, id: rule.id } : rule
        )
      );
    },
    [normalizedRules, onRulesChange]
  );

  const deleteRule = useCallback(
    (ruleId: string) => {
      onRulesChange(normalizedRules.filter(rule => rule.id !== ruleId));
      onHandlesChanged?.();
    },
    [normalizedRules, onHandlesChanged, onRulesChange]
  );

  const addRule = useCallback(() => {
    onRulesChange([
      ...normalizedRules,
      { id: createAnswerMatchRuleId(), mode: "exact", text: "" },
    ]);
    onHandlesChanged?.();
  }, [normalizedRules, onHandlesChanged, onRulesChange]);

  const modeOptions = ANSWER_MATCH_MODES.map(mode => ({
    mode,
    label: t(ANSWER_MATCH_MODE_KEYS[mode].label),
    shortLabel: t(ANSWER_MATCH_MODE_KEYS[mode].shortLabel),
    description: t(ANSWER_MATCH_MODE_KEYS[mode].description),
  }));
  const renderModeSelect = (rule: ScenarioAnswerMatchRule) => (
    <Select
      value={rule.mode}
      disabled={disabled}
      onValueChange={value => {
        if (isAnswerMatchMode(value)) updateRule(rule.id, { mode: value });
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={t("postActionAnswerMatchModeLabel")}
        className={cn(
          "nodrag nopan nokey !h-7 w-auto shrink-0 gap-1 px-1.5 text-[11px]",
          SCENARIO_SELECT_TRIGGER_HIDE_DESCRIPTION_CLASS
        )}
        onClick={stopPropagation}
        onPointerDown={stopPropagation}
      >
        <SelectValue>
          {modeOptions.find(option => option.mode === rule.mode)?.shortLabel}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="nodrag nopan nokey">
        {modeOptions.map(option => (
          <SelectItem
            key={option.mode}
            value={option.mode}
            textValue={option.label}
            className="text-xs"
          >
            <ScenarioSelectItemContent
              label={option.label}
              description={option.description}
            />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium text-muted-foreground">
          {t("postActionAnswerMatches")}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="nodrag nopan nokey h-6 px-1.5 text-[10px]"
          disabled={disabled}
          onClick={event => {
            event.stopPropagation();
            addRule();
          }}
          onPointerDown={stopPropagation}
        >
          <PlusCircle className="mr-1 h-3 w-3" aria-hidden />
          {addLabel}
        </Button>
      </div>
      {normalizedRules.length > 0 ? (
        <div className="space-y-1">
          {normalizedRules.map(rule => {
            const handleId = getHandleId(rule.id);
            const connected = connectedHandleIds?.has(handleId) === true;
            const answer =
              rule.text.trim() || t("sourceHandleConditionAnswerMatchAny");
            const routeLabel = getAnswerRuleSourceHandleCopy(t, rule).label;
            return (
              <div
                key={rule.id}
                className="flex min-w-0 items-center gap-1 rounded-md border bg-background/80 px-1 py-1"
              >
                {renderModeSelect(rule)}
                <Input
                  value={rule.text}
                  disabled={disabled}
                  onChange={event =>
                    updateRule(rule.id, { text: event.target.value })
                  }
                  onKeyDown={stopPropagation}
                  onPointerDown={stopPropagation}
                  onClick={stopPropagation}
                  aria-label={t("postActionAnswerMatchInputLabel")}
                  placeholder={t("postActionAnswerMatchInputPlaceholder")}
                  className="nodrag nopan nokey h-7 min-w-0 flex-1 px-2 text-[11px]"
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="nodrag nopan nokey h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                  disabled={disabled}
                  onClick={event => {
                    event.stopPropagation();
                    deleteRule(rule.id);
                  }}
                  onPointerDown={stopPropagation}
                  aria-label={t("postActionAnswerMatchDelete", { answer })}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
                {showPorts ? (
                  <ScenarioSourceHandleButton
                    id={handleId}
                    connected={connected}
                    connectedLabel={routeLabel}
                    connectable={connectable}
                    inline
                    appearance="ghost"
                    onCreateNode={point =>
                      onCreateNodeFromSourceHandle?.(
                        handleId,
                        point.clientX,
                        point.clientY
                      )
                    }
                    onInteractionStart={onHandlesChanged}
                    title={t("postActionAnswerMatchConnect", { answer })}
                    aria-label={routeLabel}
                    className={cn(
                      "shrink-0",
                      connected &&
                        "!border-emerald-400 !bg-emerald-50 dark:!bg-emerald-950/40"
                    )}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

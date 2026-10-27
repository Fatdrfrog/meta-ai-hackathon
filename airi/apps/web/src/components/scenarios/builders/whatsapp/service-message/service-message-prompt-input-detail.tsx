"use client";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TagInput } from "@/components/ui/tag-input";
import { cn } from "@/lib/utils";
import { useContext, useId, type SyntheticEvent } from "react";
import { fieldErrorMessage } from "./service-message-field-errors";
import { ServiceMessageFieldErrorsContext } from "./service-message-field";
import {
  DEFAULT_SCENARIO_PROMPT_INPUT_MAX_LENGTH,
  MAX_SCENARIO_PROMPT_INPUT_ANSWER_CHARACTERS,
  SCENARIO_PROMPT_INPUT_FORMATS,
  type ScenarioPromptInputField,
  type ScenarioPromptInputFormat,
} from "@icecore/scenario-contracts";
import { Braces, Trash2 } from "lucide-react";
import type { TranslateFn } from "../../../types";
import { ScenarioCollapsibleSection } from "../../../scenario-collapsible-section";
import { ScenarioInfoHint } from "../../../scenario-info-hint";
import { suggestPromptInputKey } from "./service-message-prompt-input-key";

const FORMAT_MESSAGE_KEYS: Record<ScenarioPromptInputFormat, string> = {
  text: "whatsappServicePromptInputsFormatText",
  name: "whatsappServicePromptInputsFormatName",
  number: "whatsappServicePromptInputsFormatNumber",
  choice: "whatsappServicePromptInputsFormatChoice",
};

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

/** A detail with another answer type keeps no rules of the previous one. */
function withFormat(
  field: ScenarioPromptInputField,
  format: ScenarioPromptInputFormat
): ScenarioPromptInputField {
  const next: ScenarioPromptInputField = {
    key: field.key,
    label: field.label,
    prompt: field.prompt,
  };
  if (format !== "text") next.format = format;
  if (format === "choice") next.choices = field.choices ?? [];
  return next;
}

/** Accepted answers of a choice detail. */
function PromptInputChoicesField({
  field,
  index,
  id,
  errorId,
  error,
  t,
  onChange,
}: {
  field: ScenarioPromptInputField;
  index: number;
  id: string;
  errorId: string;
  error: string | undefined;
  t: TranslateFn;
  onChange: (field: ScenarioPromptInputField) => void;
}) {
  return (
    <div
      className="grid gap-1 text-[11px]"
      data-sm-field={`promptInputs.${index}.choices`}
    >
      <label htmlFor={id}>{t("whatsappServicePromptInputsChoices")}</label>
      <TagInput
        id={id}
        aria-label={`${t("whatsappServicePromptInputsChoices")} ${index + 1}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        commitOnBlur
        value={field.choices ?? []}
        placeholder={t("whatsappServicePromptInputsChoicesPlaceholder")}
        onChange={choices => onChange({ ...field, choices })}
      />
      {error ? (
        <span id={errorId} className="text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** Longest answer a text or name detail accepts, folded under "More". */
function PromptInputMaxLengthField({
  field,
  format,
  index,
  error,
  t,
  onChange,
}: {
  field: ScenarioPromptInputField;
  format: ScenarioPromptInputFormat;
  index: number;
  error: string | undefined;
  t: TranslateFn;
  onChange: (field: ScenarioPromptInputField) => void;
}) {
  return (
    <ScenarioCollapsibleSection
      variant="inline"
      title={t("whatsappServiceMore")}
      defaultOpen={field.maxLength !== undefined}
      errorCount={error ? 1 : 0}
      keepMounted
    >
      <label className="grid w-32 gap-1 pt-1 text-[11px]">
        <span className="truncate">
          {t("whatsappServicePromptInputsMaxLength")}
        </span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_SCENARIO_PROMPT_INPUT_ANSWER_CHARACTERS}
          value={field.maxLength ?? ""}
          placeholder={String(DEFAULT_SCENARIO_PROMPT_INPUT_MAX_LENGTH[format])}
          aria-label={`${t("whatsappServicePromptInputsMaxLength")} ${index + 1}`}
          aria-invalid={Boolean(error)}
          data-sm-field={`promptInputs.${index}.maxLength`}
          className="nodrag h-8 w-full rounded-md border bg-background px-2 text-xs"
          onChange={event => {
            const next = { ...field };
            const value = event.target.valueAsNumber;
            if (Number.isFinite(value)) next.maxLength = value;
            else delete next.maxLength;
            onChange(next);
          }}
        />
        {error ? <span className="text-destructive">{error}</span> : null}
      </label>
    </ScenarioCollapsibleSection>
  );
}

/** Answer type with the rules that type takes: max length or accepted answers. */
function PromptInputAnswerFields({
  field,
  index,
  maxLengthError,
  choicesError,
  t,
  onChange,
}: {
  field: ScenarioPromptInputField;
  index: number;
  maxLengthError: string | undefined;
  choicesError: string | undefined;
  t: TranslateFn;
  onChange: (field: ScenarioPromptInputField) => void;
}) {
  const format = field.format ?? "text";
  const choicesId = useId();
  const choicesErrorId = useId();
  const formatLabel = t("whatsappServicePromptInputsFormat");
  return (
    <>
      <div className="grid gap-1 text-[11px]">
        <div className="flex min-w-0 items-center gap-0.5">
          <span>{formatLabel}</span>
          {format !== "text" ? (
            <ScenarioInfoHint
              label={t("infoHintLabel", { topic: formatLabel })}
              className="-my-1"
            >
              {t("whatsappServicePromptInputsRulesHint")}
            </ScenarioInfoHint>
          ) : null}
        </div>
        <Select
          value={format}
          onValueChange={value => {
            const next = SCENARIO_PROMPT_INPUT_FORMATS.find(
              candidate => candidate === value
            );
            if (next) onChange(withFormat(field, next));
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label={`${formatLabel} ${index + 1}`}
            className="nodrag w-full min-w-0 bg-background text-xs"
            data-sm-field={`promptInputs.${index}.format`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCENARIO_PROMPT_INPUT_FORMATS.map(option => (
              <SelectItem key={option} value={option}>
                {t(FORMAT_MESSAGE_KEYS[option])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {format === "choice" ? (
        <PromptInputChoicesField
          field={field}
          index={index}
          id={choicesId}
          errorId={choicesErrorId}
          error={choicesError}
          t={t}
          onChange={onChange}
        />
      ) : null}
      {format === "text" || format === "name" ? (
        <PromptInputMaxLengthField
          field={field}
          format={format}
          index={index}
          error={maxLengthError}
          t={t}
          onChange={onChange}
        />
      ) : null}
    </>
  );
}

/** The variable a detail fills, renamed from a small popover. */
function PromptInputKeyBadge({
  field,
  index,
  keyError,
  t,
  onChange,
}: {
  field: ScenarioPromptInputField;
  index: number;
  keyError: string | undefined;
  t: TranslateFn;
  onChange: (field: ScenarioPromptInputField) => void;
}) {
  const inputId = useId();
  const errorId = useId();
  const key = field.key.trim();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t("whatsappServicePromptInputsRename")}
            aria-describedby={keyError ? errorId : undefined}
            data-sm-field={`promptInputs.${index}.key`}
            className={cn(
              "nodrag nopan nokey inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-md border px-1.5 font-mono text-[11px] transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              keyError
                ? "border-destructive text-destructive"
                : key
                  ? "bg-muted/60 text-foreground"
                  : "border-dashed text-muted-foreground"
            )}
            onClick={stopPropagation}
            onPointerDown={stopPropagation}
          >
            <Braces className="size-3 shrink-0" aria-hidden />
            <span className="truncate">
              {key || t("whatsappServicePromptInputsKey")}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="nodrag nopan nokey w-56 space-y-1 p-2"
          onClick={stopPropagation}
          onPointerDown={stopPropagation}
          onKeyDown={stopPropagation}
        >
          <label htmlFor={inputId} className="block text-[11px] font-medium">
            {t("whatsappServicePromptInputsKey")}
          </label>
          <input
            id={inputId}
            value={field.key}
            aria-label={`${t("whatsappServicePromptInputsKey")} ${index + 1}`}
            aria-invalid={keyError ? true : undefined}
            className="nodrag h-8 w-full rounded-md border bg-background px-2 font-mono text-xs"
            onChange={event => onChange({ ...field, key: event.target.value })}
          />
        </PopoverContent>
      </Popover>
      {keyError ? (
        <span id={errorId} className="text-[11px] text-destructive">
          {keyError}
        </span>
      ) : null}
    </div>
  );
}

/** One detail to collect: what it is, the variable it fills and its answer rules. */
export function ServiceMessagePromptInputDetail({
  field,
  index,
  takenKeys,
  t,
  onChange,
  onRemove,
}: {
  field: ScenarioPromptInputField;
  /** Position in the list; labels and `promptInputs.<index>` paths use it. */
  index: number;
  /** Variable names the other details use. */
  takenKeys: ReadonlySet<string>;
  t: TranslateFn;
  onChange: (field: ScenarioPromptInputField) => void;
  onRemove: () => void;
}) {
  const fieldErrors = useContext(ServiceMessageFieldErrorsContext);
  const questionId = useId();
  const keyError = fieldErrorMessage(fieldErrors, `promptInputs.${index}.key`);
  const promptError = fieldErrorMessage(
    fieldErrors,
    `promptInputs.${index}.prompt`
  );
  const labelError = fieldErrorMessage(
    fieldErrors,
    `promptInputs.${index}.label`
  );
  const maxLengthError = fieldErrorMessage(
    fieldErrors,
    `promptInputs.${index}.maxLength`
  );
  const choicesError = fieldErrorMessage(
    fieldErrors,
    `promptInputs.${index}.choices`
  );
  const title =
    field.prompt.trim() ||
    t("whatsappServicePromptInputsRowTitle", { n: index + 1 });
  return (
    <div
      className="space-y-1.5 rounded-md border bg-background p-2"
      data-sm-field={`promptInputs.${index}`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[11px] font-medium">{title}</p>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="nodrag nopan size-6 shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={`${t("whatsappServicePromptInputsRemove")} ${index + 1}`}
          onPointerDown={stopPropagation}
          onClick={onRemove}
        >
          <Trash2 className="size-3" aria-hidden />
        </Button>
      </div>
      <div className="grid gap-1 text-[11px]">
        <label htmlFor={questionId}>
          {t("whatsappServicePromptInputsQuestion")}
        </label>
        <textarea
          id={questionId}
          value={field.prompt}
          aria-label={`${t("whatsappServicePromptInputsQuestion")} ${index + 1}`}
          aria-invalid={promptError ? true : undefined}
          placeholder={t("whatsappServicePromptInputsQuestionPlaceholder")}
          data-sm-field={`promptInputs.${index}.prompt`}
          rows={2}
          className="nodrag min-h-14 rounded-md border bg-background px-2 py-1 text-xs"
          onChange={event => onChange({ ...field, prompt: event.target.value })}
          onBlur={() => {
            // Name a new detail once; an existing name is never replaced.
            if (field.key.trim()) return;
            const key = suggestPromptInputKey(field.prompt, takenKeys);
            if (key) onChange({ ...field, key });
          }}
        />
        {promptError ? (
          <span className="text-destructive">{promptError}</span>
        ) : null}
      </div>
      <PromptInputKeyBadge
        field={field}
        index={index}
        keyError={keyError}
        t={t}
        onChange={onChange}
      />
      <PromptInputAnswerFields
        field={field}
        index={index}
        maxLengthError={maxLengthError}
        choicesError={choicesError}
        t={t}
        onChange={onChange}
      />
      {labelError ? (
        <p
          className="text-[11px] text-destructive"
          data-sm-field={`promptInputs.${index}.label`}
        >
          {labelError}
        </p>
      ) : null}
    </div>
  );
}

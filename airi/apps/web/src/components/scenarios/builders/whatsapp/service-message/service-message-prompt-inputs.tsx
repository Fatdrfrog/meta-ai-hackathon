"use client";

import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { useState } from "react";
import {
  MAX_SCENARIO_PROMPT_INPUTS,
  type ScenarioPromptInputAsk,
  type ScenarioPromptInputBehavior,
  type ScenarioPromptInputField,
} from "@icecore/scenario-contracts";
import { ScenarioInfoHint } from "../../../scenario-info-hint";
import type { TranslateFn } from "../../../types";
import { ServiceGroupError } from "./service-message-field";
import { ServiceMessagePromptInputDetail } from "./service-message-prompt-input-detail";
import { ServiceMessagePromptInputReplyRules } from "./service-message-prompt-input-reply-rules";
import {
  reconcilePromptInputRows,
  type PromptInputRow,
} from "./service-message-prompt-input-rows";

function blankField(): ScenarioPromptInputField {
  return { key: "", label: "", prompt: "" };
}

export function ServiceMessagePromptInputs({
  fields,
  ask = "text",
  behavior,
  t,
  onChange,
  onBehaviorChange,
}: {
  fields: ScenarioPromptInputField[] | undefined;
  /** A buttons, list or carousel message reads the reply after a tap. */
  ask?: ScenarioPromptInputAsk;
  /** How the ask treats replies; the defaults apply to rules it omits. */
  behavior?: ScenarioPromptInputBehavior;
  t: TranslateFn;
  onChange: (fields: ScenarioPromptInputField[]) => void;
  onBehaviorChange: (behavior: ScenarioPromptInputBehavior) => void;
}) {
  const [rowState, setRowState] = useState(() =>
    reconcilePromptInputRows(fields)
  );
  if (rowState.source !== fields) {
    setRowState(reconcilePromptInputRows(fields, rowState));
  }
  const rows = rowState.rows;
  function changeRows(nextRows: PromptInputRow[], nextId = rowState.nextId) {
    // Keep `source` on the fields we reconciled. A host such as React Flow
    // re-renders this editor with the previous `fields` before the edited node
    // data arrives; treating that stale prop as a change assigned new row
    // identities and remounted the focused input on every keystroke.
    setRowState({ source: fields, rows: nextRows, nextId });
    onChange(nextRows.map(row => row.field));
  }
  function changeField(index: number, field: ScenarioPromptInputField) {
    const next = rows.slice();
    next[index] = { ...rows[index]!, field };
    changeRows(next);
  }
  const addRow = () =>
    changeRows(
      [...rows, { id: rowState.nextId, field: blankField() }],
      rowState.nextId + 1
    );
  const canAdd = rows.length < MAX_SCENARIO_PROMPT_INPUTS;

  if (rows.length === 0) {
    return (
      <div
        className="nodrag mb-3"
        data-testid="whatsapp-service-prompt-inputs"
        onPointerDown={event => event.stopPropagation()}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="nodrag nopan h-7 px-2 text-[11px] text-muted-foreground"
          onClick={addRow}
        >
          <Plus className="size-3.5" aria-hidden />
          {t("whatsappServicePromptInputsAddFirst")}
        </Button>
      </div>
    );
  }

  const title = t("whatsappServicePromptInputsTitle");
  return (
    <section
      className="nodrag nowheel mb-3 space-y-2 rounded-md border border-border/70 bg-muted/30 p-2"
      data-testid="whatsapp-service-prompt-inputs"
      onPointerDown={event => event.stopPropagation()}
    >
      <div className="space-y-0.5">
        <div className="flex min-w-0 items-center gap-0.5">
          <p className="text-xs font-medium">{title}</p>
          <ScenarioInfoHint
            label={t("infoHintLabel", { topic: title })}
            className="-my-1"
          >
            {t(
              ask === "choice"
                ? "whatsappServicePromptInputsChoiceHint"
                : "whatsappServicePromptInputsHint"
            )}
          </ScenarioInfoHint>
        </div>
        {/* The customer never sees this list; the message text must ask. */}
        <p className="text-[11px] leading-snug text-muted-foreground">
          {t("whatsappServicePromptInputsAsk")}
        </p>
        {/* Errors of the whole list: the message type, AI text, too many details. */}
        <ServiceGroupError fieldKey="promptInputs" asField />
      </div>
      {rows.map((row, index) => (
        <ServiceMessagePromptInputDetail
          key={row.id}
          field={row.field}
          index={index}
          takenKeys={
            new Set(
              rows
                .filter(candidate => candidate.id !== row.id)
                .map(candidate => candidate.field.key.trim())
                .filter(Boolean)
            )
          }
          t={t}
          onChange={field => changeField(index, field)}
          onRemove={() =>
            changeRows(rows.filter(candidate => candidate.id !== row.id))
          }
        />
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="nodrag nopan h-7 text-[11px]"
        disabled={!canAdd}
        onClick={addRow}
      >
        <Plus className="size-3.5" aria-hidden />
        {t("whatsappServicePromptInputsAdd")}
      </Button>
      <ServiceMessagePromptInputReplyRules
        ask={ask}
        behavior={behavior}
        t={t}
        onBehaviorChange={onBehaviorChange}
      />
    </section>
  );
}

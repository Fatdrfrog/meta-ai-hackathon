"use client";

import { useCallback, useId, useMemo, useRef, type FocusEvent } from "react";
import type { TranslateFn } from "../types";
import type { ScenarioFormAnswerChoice } from "./node-enrichment/scenario-node-graph-index";
import {
  describeScenarioFormAnswerNotices,
  type ScenarioFormAnswerNoticeConsumer,
  type ScenarioFormAnswerNoticeTexts,
} from "./scenario-form-answer-labels";
import {
  buildScenarioFormAnswerVariableFields,
  type ScenarioVariableExtraField,
} from "./scenario-variable-groups";
import {
  insertScenarioTemplateTokenAt,
  type ScenarioTextSelection,
} from "./scenario-template-utils";

/**
 * The answers an AI prompt can use, for its Variables menu: the collected
 * details, then one group per earlier form.
 */
export function useScenarioAnswerVariableFields(
  promptInputFields: readonly ScenarioVariableExtraField[],
  formAnswerSources: readonly ScenarioFormAnswerChoice[] | undefined,
  t: TranslateFn
): ScenarioVariableExtraField[] {
  return useMemo(
    () => [
      ...promptInputFields,
      ...buildScenarioFormAnswerVariableFields(formAnswerSources, t),
    ],
    [formAnswerSources, promptInputFields, t]
  );
}

/** A prompt's form answer notices, with the ids its field is described by. */
export type ScenarioFormAnswerNoticeState = ScenarioFormAnswerNoticeTexts &
  Readonly<{
    unavailableId: string;
    mayBeEmptyId: string;
    /** The notices shown, for the prompt field's `aria-describedby`. */
    describedBy: string | undefined;
  }>;

/**
 * The notices under an AI prompt about its form answers: answers no form
 * before the step gives, which block activation, and answers that may be
 * empty.
 */
export function useScenarioFormAnswerNotices(
  text: string,
  sources: readonly ScenarioFormAnswerChoice[] | undefined,
  consumer: ScenarioFormAnswerNoticeConsumer,
  t: TranslateFn
): ScenarioFormAnswerNoticeState {
  const id = useId();
  return useMemo(() => {
    const texts = describeScenarioFormAnswerNotices(text, sources, consumer, t);
    const unavailableId = `${id}-form-answers-unavailable`;
    const mayBeEmptyId = `${id}-form-answers-may-be-empty`;
    const shown = [
      texts.unavailable ? unavailableId : "",
      texts.mayBeEmpty ? mayBeEmptyId : "",
    ].filter(Boolean);
    return {
      ...texts,
      unavailableId,
      mayBeEmptyId,
      describedBy: shown.length > 0 ? shown.join(" ") : undefined,
    };
  }, [consumer, id, sources, t, text]);
}

export type ScenarioTextareaTokenInsert = {
  /** The text field's callback ref. */
  attachTextarea: (textarea: HTMLTextAreaElement | null) => void;
  /** Keeps the caret while focus moves to the Variables menu. */
  rememberSelection: (event: FocusEvent<HTMLTextAreaElement>) => void;
  /** Puts a variable at the caret, or at the end before the field was used. */
  insertToken: (token: string) => void;
};

/**
 * Inserts variables into a plain text field where its caret was, then puts
 * the caret after the variable so typing continues there.
 */
export function useScenarioTextareaTokenInsert(
  value: string,
  onChange: (value: string) => void
): ScenarioTextareaTokenInsert {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const selectionRef = useRef<ScenarioTextSelection | null>(null);

  const attachTextarea = useCallback((textarea: HTMLTextAreaElement | null) => {
    textareaRef.current = textarea;
  }, []);

  const rememberSelection = useCallback(
    (event: FocusEvent<HTMLTextAreaElement>) => {
      const { selectionStart, selectionEnd } = event.currentTarget;
      selectionRef.current = { start: selectionStart, end: selectionEnd };
    },
    []
  );

  const insertToken = useCallback(
    (token: string) => {
      const next = insertScenarioTemplateTokenAt(
        value,
        token,
        selectionRef.current
      );
      selectionRef.current = { start: next.caret, end: next.caret };
      onChange(next.text);
      window.requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(next.caret, next.caret);
      });
    },
    [onChange, value]
  );

  return { attachTextarea, rememberSelection, insertToken };
}

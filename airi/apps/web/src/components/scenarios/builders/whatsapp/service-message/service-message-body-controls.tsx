"use client";

import { ReplyModeToggle } from "@/components/scenarios/nodes/action-node/reply-mode-toggle";
import type { ScenarioFormAnswerChoice } from "@/components/scenarios/view/node-enrichment/scenario-node-graph-index";
import { ScenarioFormAnswerNotices } from "@/components/scenarios/view/scenario-form-answer-notices";
import {
  ScenarioVariableInserter,
  type ScenarioVariableExtraField,
} from "@/components/scenarios/view/scenario-variable-inserter";
import {
  useScenarioAnswerVariableFields,
  useScenarioFormAnswerNotices,
  useScenarioTextareaTokenInsert,
  type ScenarioTextareaTokenInsert,
} from "@/components/scenarios/view/use-scenario-ai-prompt-variables";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ScenarioWhatsAppBodySource } from "@icecore/scenario-contracts";
import type { TranslateFn } from "../../../types";
import { bodyText } from "./service-message-builder-model";
import type { ServiceMessageEditorIntent } from "./service-message-editor-model";

const NO_PROMPT_INPUT_FIELDS: ScenarioVariableExtraField[] = [];

function ServiceMessageAiInstructions({
  id,
  hintId,
  instruction,
  error,
  textareaRef,
  onTextareaBlur,
  formAnswerSources,
  t,
  onChange,
}: {
  id: string;
  hintId: string;
  instruction: string;
  error: string | undefined;
  textareaRef: ScenarioTextareaTokenInsert["attachTextarea"];
  onTextareaBlur: ScenarioTextareaTokenInsert["rememberSelection"];
  formAnswerSources: readonly ScenarioFormAnswerChoice[] | undefined;
  t: TranslateFn;
  onChange: (value: string) => void;
}) {
  const notices = useScenarioFormAnswerNotices(
    instruction,
    formAnswerSources,
    "ai_reply",
    t
  );
  return (
    <div className="mb-3 grid gap-1 text-sm" data-sm-field="body">
      <Label htmlFor={id} className="font-medium">
        {t("whatsappServiceAiInstructions")}
      </Label>
      <Textarea
        ref={textareaRef}
        id={id}
        className="nodrag nowheel"
        value={instruction}
        placeholder={t("actionReplyInstructionPlaceholder")}
        aria-describedby={[hintId, notices.describedBy].join(" ").trim()}
        aria-invalid={error || notices.unavailable ? true : undefined}
        onChange={event => onChange(event.target.value)}
        onBlur={onTextareaBlur}
      />
      {/* Customers never see the instructions, only what AI writes. */}
      <span id={hintId} className="text-[11px] text-muted-foreground">
        {t("whatsappServiceAiInstructionsHint")}
      </span>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
      <ScenarioFormAnswerNotices notices={notices} />
    </div>
  );
}

/**
 * Who writes the body, the Variables picker, and the AI instructions. Your
 * text offers every variable; AI writes offers only the answers before this
 * step and inserts them at the caret.
 */
export function ServiceMessageBodyControls({
  body,
  bodyError,
  aiInstructionsId,
  aiInstructionsHintId,
  promptInputFields = NO_PROMPT_INPUT_FIELDS,
  formAnswerSources,
  t,
  apply,
  onInsertToken,
}: {
  body: ScenarioWhatsAppBodySource | undefined;
  bodyError: string | undefined;
  aiInstructionsId: string;
  aiInstructionsHintId: string;
  promptInputFields?: ScenarioVariableExtraField[];
  formAnswerSources?: readonly ScenarioFormAnswerChoice[];
  t: TranslateFn;
  apply: (intent: ServiceMessageEditorIntent) => void;
  onInsertToken: (token: string) => void;
}) {
  const answerFields = useScenarioAnswerVariableFields(
    promptInputFields,
    formAnswerSources,
    t
  );
  const setInstruction = (value: string) => apply({ type: "set_body", value });
  const { attachTextarea, rememberSelection, insertToken } =
    useScenarioTextareaTokenInsert(bodyText(body), setInstruction);
  if (!body) return null;
  const aiWrites = body.mode === "ai";
  return (
    <>
      <ReplyModeToggle
        value={body.mode}
        t={t}
        className="mb-2"
        onChange={mode => apply({ type: "set_body_mode", mode })}
      >
        <ScenarioVariableInserter
          t={t}
          variant="onLight"
          answersOnly={aiWrites}
          extraFields={aiWrites ? answerFields : promptInputFields}
          onInsertToken={aiWrites ? insertToken : onInsertToken}
        />
      </ReplyModeToggle>
      {body.mode === "ai" ? (
        <ServiceMessageAiInstructions
          id={aiInstructionsId}
          hintId={aiInstructionsHintId}
          instruction={body.instruction}
          error={bodyError}
          textareaRef={attachTextarea}
          onTextareaBlur={rememberSelection}
          formAnswerSources={formAnswerSources}
          t={t}
          onChange={setInstruction}
        />
      ) : null}
    </>
  );
}

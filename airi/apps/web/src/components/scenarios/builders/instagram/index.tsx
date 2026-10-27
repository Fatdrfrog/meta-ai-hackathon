"use client";

import type {
  ScenarioInstagramConfig,
  ScenarioReplyMode,
} from "@/components/scenarios/types";
import { SCENARIO_NODE_CHANNEL_PREVIEW_BLEED_CLASS } from "@/components/scenarios/nodes/node-card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { ReplyModeToggle } from "../../nodes/action-node/reply-mode-toggle";
import { stopScenarioKeyboardPropagationFromEditableTarget } from "../../scenario-keyboard-events";
import {
  ScenarioVariableInserter,
  type ScenarioVariableExtraField,
} from "../../view/scenario-variable-inserter";
import { InstagramReplyFields } from "./instagram-reply-fields";
import {
  InstagramMessageBubble,
  InstagramReplyPreview,
} from "./instagram-reply-preview";
import { useInstagramReplyEditor } from "./use-instagram-reply-editor";

type InstagramReplyBuilderProps = {
  config?: ScenarioInstagramConfig;
  connectedPayloads?: readonly string[];
  disabled?: boolean;
  replyMode: ScenarioReplyMode;
  messageText: string;
  instructionText: string;
  onReplyModeChange?: (mode: ScenarioReplyMode) => void;
  onMessageTextChange: (next: string) => void;
  onMessageTextCommit?: () => void;
  onInstructionTextChange: (next: string) => void;
  onInstructionTextCommit?: () => void;
  onConfigChange: (next: ScenarioInstagramConfig) => void;
  onBranchOptionsChanged?: (next: ScenarioInstagramConfig) => void;
  /** Inserts a variable into the fixed text; shows the Variables picker. */
  onInsertToken?: (token: string) => void;
  /** Answers collected before this step, offered in Variables. */
  variableFields?: ScenarioVariableExtraField[];
};

export function InstagramReplyBuilder({
  config,
  connectedPayloads,
  disabled = false,
  replyMode,
  messageText,
  instructionText,
  onReplyModeChange,
  onMessageTextChange,
  onMessageTextCommit,
  onInstructionTextChange,
  onInstructionTextCommit,
  onConfigChange,
  onBranchOptionsChanged,
  onInsertToken,
  variableFields,
}: InstagramReplyBuilderProps) {
  const t = useTranslations("Scenarios");
  const idPrefix = useId();
  const editor = useInstagramReplyEditor({
    config,
    connectedPayloads,
    onConfigChange,
    onBranchOptionsChanged,
    t,
  });

  return (
    <div
      className="mx-auto w-full space-y-2"
      data-testid="instagram-builder"
      onKeyDown={stopScenarioKeyboardPropagationFromEditableTarget}
      onBlur={editor.handleBuilderBlur}
    >
      <ReplyModeToggle
        value={replyMode}
        onChange={mode => onReplyModeChange?.(mode)}
        t={t}
        disabled={disabled}
      >
        {replyMode === "fixed" && onInsertToken && !disabled ? (
          <ScenarioVariableInserter
            t={t}
            variant="onLight"
            extraFields={variableFields}
            onInsertToken={onInsertToken}
          />
        ) : null}
      </ReplyModeToggle>

      <div
        className={cn(
          SCENARIO_NODE_CHANNEL_PREVIEW_BLEED_CLASS,
          "overflow-visible bg-transparent shadow-none"
        )}
      >
        <div className="space-y-2 bg-white px-2 py-2 dark:bg-zinc-950">
          <InstagramMessageBubble
            replyMode={replyMode}
            disabled={disabled}
            messageText={messageText}
            onMessageTextChange={onMessageTextChange}
            onMessageTextCommit={onMessageTextCommit}
            t={t}
          />
          <InstagramReplyPreview editor={editor} t={t} />

          <div className="rounded-2xl bg-zinc-100/90 p-2 dark:bg-zinc-900">
            <fieldset
              disabled={disabled}
              className={cn(
                "min-w-0 space-y-2",
                disabled && "cursor-not-allowed opacity-60"
              )}
            >
              {replyMode === "ai" ? (
                <Textarea
                  rows={3}
                  value={instructionText}
                  aria-label={t("whatsappServiceAiInstructions")}
                  onChange={event =>
                    onInstructionTextChange(event.target.value)
                  }
                  onBlur={onInstructionTextCommit}
                  placeholder={t("actionReplyInstructionPlaceholder")}
                  className="nodrag nopan resize-none bg-white text-xs dark:bg-zinc-950"
                />
              ) : null}

              <InstagramReplyFields editor={editor} idPrefix={idPrefix} t={t} />
            </fieldset>
          </div>
        </div>
      </div>
    </div>
  );
}

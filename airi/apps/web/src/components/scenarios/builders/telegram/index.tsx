"use client";

import type { ScenarioNodeData } from "@/components/scenarios/types";
import { SCENARIO_NODE_CHANNEL_PREVIEW_BLEED_CLASS } from "@/components/scenarios/nodes/node-card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { validateTelegramBranchCompleteness } from "@/lib/scenarios/telegram-quick-replies";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  ScenarioVariableInserter,
  type ScenarioVariableExtraField,
} from "../../view/scenario-variable-inserter";
import { useDeferredBranchSync } from "../use-deferred-branch-sync";
import {
  TelegramReplyBuilderComposer,
  TelegramReplyBuilderRows,
} from "./sections";
import {
  ensureUniquePayload,
  flattenQuickReplyRows,
  generatePayloadFromText,
  isStorageEquivalentToRows,
  MAX_BUTTONS_PER_ROW,
  MAX_QUICK_REPLIES,
  normalizeButtonText,
  normalizeQuickReplyRows,
  type TelegramQuickReplyDraft,
} from "./utils";

/**
 * Maps to Telegram {@link https://core.telegram.org/bots/api#inlinekeyboardmarkup InlineKeyboardMarkup}:
 * `inline_keyboard` is an array of rows; each row is an array of
 * {@link https://core.telegram.org/bots/api#inlinekeyboardbutton InlineKeyboardButton}.
 * We use `callback_data` (1–64 UTF-8 bytes on the wire, after our `sqr:` prefix — see send layer).
 */
type TelegramReplyBuilderProps = {
  quickReplies: ScenarioNodeData["actionTelegramQuickReplies"];
  connectedPayloads?: readonly string[];
  messageText: string;
  onMessageTextChange: (next: string) => void;
  onMessageTextCommit?: () => void;
  renderButtonBranchHandle?: (params: {
    button: TelegramQuickReplyDraft;
    rowIndex: number;
    buttonIndex: number;
  }) => ReactNode;
  /** Called when row layout or buttons change. */
  onChange: (next: TelegramQuickReplyDraft[][]) => void;
  /** Fired when branch identities may need graph sync. */
  onButtonListChanged?: (next: TelegramQuickReplyDraft[][]) => void;
  /** Inserts a variable into the message; shows the Variables picker. */
  onInsertToken?: (token: string) => void;
  /** Answers collected before this step, offered in Variables. */
  variableFields?: ScenarioVariableExtraField[];
};

export function TelegramReplyBuilder({
  quickReplies,
  connectedPayloads,
  messageText,
  onMessageTextChange,
  onMessageTextCommit,
  renderButtonBranchHandle,
  onChange,
  onButtonListChanged,
  onInsertToken,
  variableFields,
}: TelegramReplyBuilderProps) {
  const t = useTranslations("Scenarios");
  const rows = useMemo(
    () => normalizeQuickReplyRows(quickReplies),
    [quickReplies]
  );

  const flatButtons = useMemo(() => flattenQuickReplyRows(rows), [rows]);
  const missingPayloads = useMemo(() => {
    const result = validateTelegramBranchCompleteness(
      flatButtons,
      connectedPayloads ?? []
    );
    return new Set(result.missingOptions.map(option => option.payload));
  }, [flatButtons, connectedPayloads]);

  const [draftText, setDraftText] = useState("");

  const { commitValue: commitRowsValue, syncDirtyBranches } =
    useDeferredBranchSync({
      value: rows,
      onChange,
      onBranchOptionsChanged: onButtonListChanged,
    });

  const commitRows = useCallback(
    (
      next: TelegramQuickReplyDraft[][],
      options: { syncBranches?: boolean } = {}
    ) => {
      const cleaned = next.filter(row => row.length > 0);
      commitRowsValue(cleaned, options);
    },
    [commitRowsValue]
  );

  useEffect(() => {
    if (isStorageEquivalentToRows(quickReplies, rows)) return;
    commitRows(rows);
  }, [commitRows, quickReplies, rows]);

  const handleAddToRow = useCallback(
    (rowIndex: number) => {
      const text = draftText.trim();
      if (!text) return;
      if (flatButtons.length >= MAX_QUICK_REPLIES) return;
      const targetRow = rows[rowIndex];
      if (targetRow && targetRow.length >= MAX_BUTTONS_PER_ROW) return;

      const basePayload = generatePayloadFromText(text);
      const payload = ensureUniquePayload({
        payload: basePayload,
        buttons: flatButtons,
      });
      const next = rows.map((r, i) =>
        i === rowIndex ? [...r, { text, payload }] : [...r]
      );
      setDraftText("");
      commitRows(next);
    },
    [commitRows, draftText, flatButtons, rows]
  );

  const handleAddNewRow = useCallback(() => {
    const text = draftText.trim();
    if (!text) return;
    if (flatButtons.length >= MAX_QUICK_REPLIES) return;

    const basePayload = generatePayloadFromText(text);
    const payload = ensureUniquePayload({
      payload: basePayload,
      buttons: flatButtons,
    });
    setDraftText("");
    commitRows([...rows, [{ text, payload }]]);
  }, [commitRows, draftText, flatButtons, rows]);

  const handleRemoveButton = useCallback(
    (rowIndex: number, buttonIndex: number) => {
      const next = rows
        .map((r, ri) =>
          ri === rowIndex ? r.filter((_, bi) => bi !== buttonIndex) : r
        )
        .filter(r => r.length > 0);
      commitRows(next);
    },
    [commitRows, rows]
  );

  const handleRemoveRow = useCallback(
    (rowIndex: number) => {
      const next = rows.filter((_, i) => i !== rowIndex);
      commitRows(next);
    },
    [commitRows, rows]
  );

  const handleTextChange = useCallback(
    (rowIndex: number, buttonIndex: number, newText: string) => {
      const text = normalizeButtonText(newText);
      const next = rows.map((r, ri) =>
        ri === rowIndex
          ? r.map((btn, bi) => (bi === buttonIndex ? { ...btn, text } : btn))
          : r
      );
      commitRows(next, { syncBranches: false });
    },
    [commitRows, rows]
  );

  const totalCount = flatButtons.length;
  const handleDraftTextChange = useCallback((next: string) => {
    setDraftText(normalizeButtonText(next));
  }, []);

  return (
    <div className="mx-auto w-full space-y-2">
      <div
        className={cn(
          SCENARIO_NODE_CHANNEL_PREVIEW_BLEED_CLASS,
          "overflow-visible bg-transparent shadow-none"
        )}
      >
        <div className="relative bg-zinc-100 px-2 py-2 dark:bg-zinc-900">
          <div className="relative space-y-2.5">
            <div className="ml-auto max-w-[90%] rounded-[22px_22px_8px_22px] border border-[#b8e0a8]/60 bg-[#eeffde] px-3 py-2 text-zinc-900 shadow-sm dark:border-emerald-900/40 dark:bg-emerald-950/50 dark:text-zinc-100">
              <Textarea
                rows={4}
                value={messageText}
                aria-label={t("scenarioMessageEditorLabel")}
                onChange={event => onMessageTextChange(event.target.value)}
                onBlur={onMessageTextCommit}
                onKeyDown={event => {
                  event.stopPropagation();
                }}
                placeholder={t("actionReplyTextPlaceholder")}
                className="nodrag nopan min-h-[108px] resize-none border-0 bg-transparent p-0 text-[12px] leading-5 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              {onInsertToken ? (
                <div className="mt-1.5 flex justify-end">
                  <ScenarioVariableInserter
                    t={t}
                    variant="onLight"
                    extraFields={variableFields}
                    onInsertToken={onInsertToken}
                  />
                </div>
              ) : null}
            </div>

            <div className="rounded-xl bg-zinc-200/80 p-1 dark:bg-zinc-800/90">
              <TelegramReplyBuilderRows
                draftText={draftText}
                missingPayloads={missingPayloads}
                rows={rows}
                totalCount={totalCount}
                onAddToRow={handleAddToRow}
                onRemoveButton={handleRemoveButton}
                onRemoveRow={handleRemoveRow}
                onTextChange={handleTextChange}
                onTextCommit={syncDirtyBranches}
                renderButtonBranchHandle={renderButtonBranchHandle}
              />
              <TelegramReplyBuilderComposer
                draftText={draftText}
                hasRows={rows.length > 0}
                totalCount={totalCount}
                onAddToLastRow={() => handleAddToRow(rows.length - 1)}
                onAddNewRow={handleAddNewRow}
                onDraftTextChange={handleDraftTextChange}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

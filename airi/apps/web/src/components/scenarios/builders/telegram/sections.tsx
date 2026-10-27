"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode, SyntheticEvent } from "react";
import {
  BranchConnectionDot,
  ReplyOptionComposer,
  ReplyOptionDeleteButton,
  ReplyOptionTooltip,
} from "../reply-option-controls";
import type { TelegramQuickReplyDraft } from "./utils";
import { MAX_BUTTONS_PER_ROW, MAX_QUICK_REPLIES } from "./utils";

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

type TelegramReplyBuilderRowsProps = {
  draftText: string;
  missingPayloads: Set<string>;
  rows: TelegramQuickReplyDraft[][];
  totalCount: number;
  onAddToRow: (rowIndex: number) => void;
  onRemoveButton: (rowIndex: number, buttonIndex: number) => void;
  onRemoveRow: (rowIndex: number) => void;
  onTextChange: (
    rowIndex: number,
    buttonIndex: number,
    nextText: string
  ) => void;
  onTextCommit?: () => void;
  renderButtonBranchHandle?: (params: {
    button: TelegramQuickReplyDraft;
    rowIndex: number;
    buttonIndex: number;
  }) => ReactNode;
};

export function TelegramReplyBuilderRows({
  draftText,
  missingPayloads,
  rows,
  totalCount,
  onAddToRow,
  onRemoveButton,
  onRemoveRow,
  onTextChange,
  onTextCommit,
  renderButtonBranchHandle,
}: TelegramReplyBuilderRowsProps) {
  const t = useTranslations("Scenarios");

  if (rows.length === 0) {
    return (
      <p className="px-2 py-3 text-center text-[11px] text-zinc-500 dark:text-zinc-400">
        {t("telegramBuilderNoButtons")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {rows.map((row, rowIndex) => (
        <div
          key={`tg-row-${rowIndex}`}
          aria-label={t("telegramBuilderRowLabel", { n: rowIndex + 1 })}
          className="group/tgrow flex w-full min-w-0 items-stretch gap-0.5"
          role="group"
        >
          {rows.length > 1 ? (
            <ReplyOptionDeleteButton
              label={t("telegramBuilderRemoveRow")}
              className="nodrag h-[40px] w-6 shrink-0 rounded-md text-zinc-500 opacity-70 hover:bg-black/[0.05] hover:text-destructive hover:opacity-100 sm:w-7 sm:opacity-0 sm:group-hover/tgrow:opacity-100 focus-visible:opacity-100 dark:text-zinc-400 dark:hover:bg-white/10"
              onClick={() => onRemoveRow(rowIndex)}
              iconClassName="h-3 w-3"
            />
          ) : null}
          <div className="flex min-w-0 flex-1 gap-1">
            {row.map((button, buttonIndex) => (
              <div
                key={button.payload}
                className="group/tgcell relative flex min-w-0 flex-1 items-center overflow-visible"
              >
                <div className="relative min-w-0 flex-1">
                  {missingPayloads.has(button.payload) ? (
                    <BranchConnectionDot
                      connected={false}
                      payload={button.payload}
                      label={t("sourceHandleStatusUnlinked")}
                      missingClassName="border-0 bg-amber-400 dark:bg-amber-500"
                      className="absolute right-1.5 top-1.5 z-20 h-1.5 w-1.5 ring-2 ring-white dark:ring-zinc-800"
                    />
                  ) : null}
                  <Input
                    value={button.text}
                    aria-label={t("buttonText")}
                    onChange={event =>
                      onTextChange(rowIndex, buttonIndex, event.target.value)
                    }
                    onBlur={onTextCommit}
                    onKeyDown={event => {
                      event.stopPropagation();
                    }}
                    placeholder={t("telegramBuilderButtonTextPlaceholder")}
                    className="nodrag nopan h-[40px] w-full rounded-lg border border-zinc-300/90 bg-white px-2 text-center text-[13px] font-medium leading-tight text-zinc-900 shadow-sm placeholder:text-zinc-400 focus-visible:border-[#229ED9] focus-visible:ring-1 focus-visible:ring-[#229ED9]/25 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus-visible:border-[#5eb5f7] dark:focus-visible:ring-[#5eb5f7]/30"
                  />
                  <ReplyOptionTooltip label={t("telegramBuilderRemoveButton")}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="nodrag nopan nokey absolute right-0 top-0 z-10 h-7 w-7 rounded-md text-zinc-500 opacity-60 hover:bg-zinc-200/90 hover:opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover/tgcell:opacity-100 group-focus-within/tgcell:opacity-100 dark:hover:bg-zinc-600 dark:text-zinc-300"
                      onClick={event => {
                        event.stopPropagation();
                        onRemoveButton(rowIndex, buttonIndex);
                      }}
                      onPointerDown={stopPropagation}
                      aria-label={t("telegramBuilderRemoveButton")}
                    >
                      <Trash2 className="h-3 w-3" aria-hidden />
                    </Button>
                  </ReplyOptionTooltip>
                </div>
                {renderButtonBranchHandle
                  ? renderButtonBranchHandle({
                      button,
                      rowIndex,
                      buttonIndex,
                    })
                  : null}
              </div>
            ))}
            {totalCount < MAX_QUICK_REPLIES &&
            row.length < MAX_BUTTONS_PER_ROW ? (
              <ReplyOptionTooltip label={t("telegramBuilderAddToThisRow")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("telegramBuilderAddToThisRow")}
                  className="nodrag nopan nokey h-[40px] w-9 shrink-0 rounded-lg border border-dashed border-zinc-400/70 bg-white/90 text-zinc-500 hover:border-[#229ED9]/50 hover:bg-white hover:text-[#229ED9] focus-visible:opacity-100 disabled:opacity-25 sm:bg-white/50 sm:opacity-0 sm:group-hover/tgrow:opacity-100 sm:disabled:opacity-0 dark:border-zinc-500 dark:bg-zinc-800/80 dark:hover:border-[#5eb5f7]/50 dark:hover:text-[#5eb5f7] dark:hover:bg-zinc-800"
                  disabled={!draftText.trim()}
                  onClick={event => {
                    event.stopPropagation();
                    onAddToRow(rowIndex);
                  }}
                  onPointerDown={stopPropagation}
                >
                  <Plus className="h-4 w-4" aria-hidden />
                </Button>
              </ReplyOptionTooltip>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

type TelegramReplyBuilderComposerProps = {
  draftText: string;
  hasRows: boolean;
  onAddToLastRow: () => void;
  onAddNewRow: () => void;
  onDraftTextChange: (next: string) => void;
  totalCount: number;
};

export function TelegramReplyBuilderComposer({
  draftText,
  hasRows,
  onAddToLastRow,
  onAddNewRow,
  onDraftTextChange,
  totalCount,
}: TelegramReplyBuilderComposerProps) {
  const t = useTranslations("Scenarios");

  if (totalCount >= MAX_QUICK_REPLIES) {
    return (
      <p
        className="mt-1 border-t border-zinc-300/50 px-2 pt-1.5 text-center text-[11px] text-zinc-500 dark:border-zinc-600/60 dark:text-zinc-400"
        data-testid="telegram-builder-max-buttons"
      >
        {t("telegramBuilderMaxButtons", { count: MAX_QUICK_REPLIES })}
      </p>
    );
  }

  const hasDraft = draftText.trim().length > 0;

  return (
    <div
      className={cn(
        "mt-1 space-y-1 pt-1",
        hasRows && "border-t border-zinc-300/50 dark:border-zinc-600/60"
      )}
    >
      <ReplyOptionComposer
        value={draftText}
        onValueChange={onDraftTextChange}
        onSubmit={hasRows ? onAddToLastRow : onAddNewRow}
        onEnter={event => {
          if (event.shiftKey) {
            onAddNewRow();
            return;
          }
          if (hasRows) {
            onAddToLastRow();
            return;
          }
          onAddNewRow();
        }}
        ariaLabel={t("telegramBuilderAddLabel")}
        placeholder={t("telegramBuilderAddPlaceholder")}
        addLabel={t("telegramBuilderAddButton")}
        disabled={!hasDraft}
        rowClassName="items-stretch gap-1 rounded-lg border border-zinc-300/80 bg-white px-2 py-1 shadow-sm dark:border-zinc-600 dark:bg-zinc-800 dark:shadow-none"
        inputClassName="h-8 border-0 bg-transparent px-0 text-[13px] text-zinc-900 shadow-none focus-visible:ring-0 dark:text-zinc-100"
        buttonClassName="rounded-full bg-[#3390ec] text-white hover:bg-[#2481cc] dark:bg-sky-600 dark:hover:bg-sky-500"
        iconClassName="h-4 w-4"
        footer={
          hasRows && hasDraft ? (
            <ReplyOptionTooltip
              label={
                <KbdGroup>
                  <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd>
                </KbdGroup>
              }
            >
              <button
                type="button"
                className="nodrag nopan nokey w-full rounded-lg py-0.5 text-center text-[11px] text-zinc-600 underline-offset-2 hover:text-[#229ED9] hover:underline dark:text-zinc-400 dark:hover:text-[#5eb5f7]"
                onClick={event => {
                  event.stopPropagation();
                  onAddNewRow();
                }}
                onPointerDown={stopPropagation}
              >
                {t("telegramBuilderNewRowWithButton")}
              </button>
            </ReplyOptionTooltip>
          ) : null
        }
      />
    </div>
  );
}

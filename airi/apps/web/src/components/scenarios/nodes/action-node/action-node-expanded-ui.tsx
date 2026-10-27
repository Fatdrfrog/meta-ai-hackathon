"use client";

import type {
  ScenarioActionSelectorType,
  ScenarioNodeData,
  TranslateFn,
} from "@/components/scenarios/types";
import type {
  ScenarioActionEditorNodeData,
  ScenarioEditorValidationMode,
} from "../../view/node-enrichment/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardHeader } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { MoreHorizontal, Paperclip, Trash2, TriangleAlert } from "lucide-react";
import { useContext, type ReactNode, type SyntheticEvent } from "react";
import { toast } from "sonner";
import { ScenarioCollapsibleSection } from "../../scenario-collapsible-section";
import { ScenarioInfoHint } from "../../scenario-info-hint";
import { ScenarioInlineNotice } from "../../scenario-inline-notice";
import type { ScenarioActionPreview } from "../../scenario-node-labels";
import {
  ScenarioSelectItemContent,
  SCENARIO_SELECT_TRIGGER_HIDE_DESCRIPTION_CLASS,
} from "../../scenario-select-item-description";
import {
  SCENARIO_UNDO_TOAST_DURATION_MS,
  ScenarioGraphUndoContext,
} from "../../view/graph/undo-context";
import { resolveAnyReplyLabel } from "../../view/scenario-source-handle-copy";
import {
  ScenarioVariableInserter,
  type ScenarioVariableExtraField,
} from "../../view/scenario-variable-inserter";
import { ActionSourceIcon } from "./action-node-helpers";
import type { ActionNodePorts } from "./action-node-ports";

export function FixedReplyEmptyWarning({ message }: { message: string }) {
  return <ScenarioInlineNotice tone="warning">{message}</ScenarioInlineNotice>;
}

export const INSTAGRAM_REPLY_DISABLED_CARD_CLASS =
  "border-amber-300/80 bg-muted/60 text-muted-foreground opacity-90";

/** Controls inside a canvas card must not select, drag or pan the node. */
export const ACTION_NODE_CARD_CONTROL_CLASS = "nodrag nopan nokey";

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

export function ActionNodeLongWaitNotice({ t }: { t: TranslateFn }) {
  return (
    <ScenarioInlineNotice
      tone="warning"
      data-testid="action-node-long-wait-notice"
    >
      {t("actionLongWaitNeedsTemplate")}
    </ScenarioInlineNotice>
  );
}

/**
 * Linked routes that can't run, as warnings:
 * - one with no row, such as a Form submitted route the template no longer
 *   offers, in the words activation refuses it with, since its edge leaves
 *   no dot;
 * - a default route that a linked outcome or the template's linked Form
 *   submitted route keeps from running, named as its row names it. It
 *   blocks nothing.
 */
export function ActionNodeUnreachableRouteNotice({
  ports,
  nodeData,
  t,
}: {
  ports: ActionNodePorts;
  nodeData: ScenarioNodeData;
  t: TranslateFn;
}) {
  const route = ports.ports.find(port => port.cannotRun);
  const anyReplyLinked = ports.ports.some(
    port => port.kind === "any_reply" && port.connected
  );
  return (
    <>
      {ports.anchoredRouteError ? (
        <ScenarioInlineNotice
          tone="warning"
          data-testid="action-node-anchored-route-notice"
        >
          {t(ports.anchoredRouteError)}
        </ScenarioInlineNotice>
      ) : null}
      {route ? (
        <ScenarioInlineNotice
          tone="warning"
          data-testid="action-node-unreachable-route-notice"
        >
          {route.cannotRun === "form_submitted"
            ? t("actionDefaultRouteCannotRunFormSubmitted", {
                route: route.label,
                formSubmitted: t("serviceRouteFlowSubmitted"),
              })
            : t("actionDefaultRouteCannotRun", {
                route: route.label,
                anyReply: resolveAnyReplyLabel(nodeData, t),
                anyReplyLinked: anyReplyLinked ? "yes" : "no",
              })}
        </ScenarioInlineNotice>
      ) : null}
    </>
  );
}

/** The step's kind icon and its name, clamped to two lines. */
export function ActionNodeHeaderTitle({
  icon,
  title,
}: {
  icon: ReactNode;
  title: string;
}) {
  return (
    <>
      <span className="flex h-5 shrink-0 items-center">{icon}</span>
      <span
        className="line-clamp-2 min-w-0 break-words text-sm font-semibold leading-5"
        data-testid="action-node-title"
      >
        {title}
      </span>
    </>
  );
}

/** Deletes the step, then offers to undo it when the graph keeps history. */
function ActionNodeStepMenu({
  onRemove,
  t,
}: {
  onRemove?: () => void;
  t: TranslateFn;
}) {
  const history = useContext(ScenarioGraphUndoContext);
  if (!onRemove) return null;
  const deleteStep = () => {
    onRemove();
    if (!history) return;
    toast(t("stepDeleted"), {
      duration: SCENARIO_UNDO_TOAST_DURATION_MS,
      action: {
        label: t("whatsappServiceUndo"),
        onClick: () => {
          if (typeof history === "function") history();
          else history.undo();
        },
      },
    });
  };
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("stepActions")}
          className={cn(
            ACTION_NODE_CARD_CONTROL_CLASS,
            "size-7 shrink-0 text-muted-foreground hover:text-foreground max-sm:size-9"
          )}
          data-testid="action-node-step-menu"
          onClick={stopPropagation}
          onPointerDown={stopPropagation}
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className={ACTION_NODE_CARD_CONTROL_CLASS}
        onClick={stopPropagation}
        onPointerDown={stopPropagation}
      >
        <DropdownMenuItem variant="destructive" onSelect={deleteStep}>
          <Trash2 aria-hidden />
          {t("removeBlock")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Won't send", with the reason behind an info button. */
function ActionNodeWontSendBadge({
  reason,
  t,
}: {
  reason: string;
  t: TranslateFn;
}) {
  const label = t("instagramReplyDisabledBadge");
  return (
    <span className="flex shrink-0 items-center">
      <Badge
        variant="outline"
        className="h-5 border-amber-300 bg-amber-50 px-1.5 text-[10px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-300"
      >
        {label}
      </Badge>
      <ScenarioInfoHint label={t("infoHintLabel", { topic: label })}>
        {reason}
      </ScenarioInfoHint>
    </span>
  );
}

/**
 * A card header: the step's icon and name, then its status, settings and
 * step menu, which holds Delete step.
 */
export function ActionNodeHeaderChrome({
  leading,
  actions,
  instagramReplyDisabledReason,
  onRemove,
  t,
}: {
  leading: ReactNode;
  /** Header buttons before the step menu, such as Settings. */
  actions?: ReactNode;
  instagramReplyDisabledReason?: string | null;
  onRemove?: () => void;
  t: TranslateFn;
}) {
  return (
    <div className="flex min-w-0 items-start gap-1.5">
      <div className="flex min-w-0 flex-1 items-start gap-1.5 pt-1">
        {leading}
      </div>
      <div className="-mr-1.5 flex shrink-0 items-center gap-0.5">
        {instagramReplyDisabledReason ? (
          <ActionNodeWontSendBadge
            reason={instagramReplyDisabledReason}
            t={t}
          />
        ) : null}
        {actions}
        <ActionNodeStepMenu onRemove={onRemove} t={t} />
      </div>
    </div>
  );
}

type ActionNodeBranchContextProps = {
  incomingRouteCount?: number;
  flowBranchOptionLabel?: string | null;
  instagramBranchLabel?: string | null;
  t: TranslateFn;
  telegramBranchLabel?: string | null;
  whatsAppSessionChoiceLabel?: string | null;
};

/**
 * The choice that leads here, as "After “Yes”". Steps reached from several
 * routes show nothing: their edges already say it.
 */
export function ActionNodeBranchContext({
  incomingRouteCount = 0,
  flowBranchOptionLabel,
  instagramBranchLabel,
  t,
  telegramBranchLabel,
  whatsAppSessionChoiceLabel,
}: ActionNodeBranchContextProps) {
  const label = [
    flowBranchOptionLabel,
    telegramBranchLabel,
    instagramBranchLabel,
    whatsAppSessionChoiceLabel,
  ]
    .map(value => value?.trim())
    .find(Boolean);
  if (incomingRouteCount > 1 || !label) return null;
  return (
    <p
      className="truncate text-[11px] text-muted-foreground"
      data-testid="action-node-branch-context"
    >
      {t("canvasAfterChoice", { label })}
    </p>
  );
}

/**
 * What the step sends, in two lines. An empty state is muted italic; one
 * that blocks sending gets a warning icon once validation isn't in draft.
 */
export function ActionNodePreview({
  preview,
  validationMode,
  testId,
}: {
  preview: ScenarioActionPreview;
  validationMode?: ScenarioEditorValidationMode;
  testId?: string;
}) {
  const empty = preview.state !== "content";
  const blocking =
    preview.state === "blocking_empty" && validationMode !== "draft";
  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-1 text-[11px] leading-snug text-muted-foreground",
        empty && "italic"
      )}
      data-testid={testId}
      data-preview-state={preview.state}
    >
      {blocking ? (
        <TriangleAlert
          className="mt-px size-3 shrink-0 text-amber-500 dark:text-amber-400"
          aria-hidden
        />
      ) : null}
      <span className="line-clamp-2 min-w-0 whitespace-pre-wrap break-words">
        {preview.text}
      </span>
    </div>
  );
}

export function ActionNodeAttachmentChip({
  count,
  t,
}: {
  count: number;
  t: TranslateFn;
}) {
  return (
    <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
      <Paperclip aria-hidden />
      {t("actionCardAttachmentCount", { count })}
    </Badge>
  );
}

export function ActionNodeExpandedHeader({
  leading,
  incomingRouteCount = 0,
  attachmentCount,
  flowBranchOptionLabel,
  instagramBranchLabel,
  instagramReplyDisabledReason,
  longWaitNotice = false,
  onRemove,
  recipientMessages,
  t,
  telegramBranchLabel,
  unreachableRouteNotice,
  whatsAppSessionChoiceLabel,
}: ActionNodeBranchContextProps & {
  leading: ReactNode;
  attachmentCount: number;
  instagramReplyDisabledReason?: string | null;
  longWaitNotice?: boolean;
  onRemove?: () => void;
  recipientMessages?: ReactNode;
  /** An ActionNodeUnreachableRouteNotice. */
  unreachableRouteNotice?: ReactNode;
}) {
  return (
    <CardHeader className="gap-1.5 px-3 pb-2 pt-2">
      <ActionNodeHeaderChrome
        leading={leading}
        instagramReplyDisabledReason={instagramReplyDisabledReason}
        onRemove={onRemove}
        t={t}
      />
      <ActionNodeBranchContext
        incomingRouteCount={incomingRouteCount}
        flowBranchOptionLabel={flowBranchOptionLabel}
        instagramBranchLabel={instagramBranchLabel}
        t={t}
        telegramBranchLabel={telegramBranchLabel}
        whatsAppSessionChoiceLabel={whatsAppSessionChoiceLabel}
      />
      {recipientMessages}
      {attachmentCount > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          <ActionNodeAttachmentChip count={attachmentCount} t={t} />
        </div>
      ) : null}
      {longWaitNotice ? <ActionNodeLongWaitNotice t={t} /> : null}
      {unreachableRouteNotice}
    </CardHeader>
  );
}

const WHATSAPP_ACTION_KIND_HINT_KEYS: Partial<
  Record<ScenarioActionSelectorType, string>
> = {
  whatsapp_service_message: "actionWhatsAppKindMessageHint",
  whatsapp_template: "actionWhatsAppKindTemplateHint",
};

export function ActionNodeSourceControls({
  actionSourceOptions,
  hidden = false,
  selectedActionSourceId,
  showWhatsAppActionKindSelect,
  t,
  whatsAppActionKindOptions,
  whatsAppActionKindValue,
  onActionSourceChange,
  onWhatsAppActionKindChange,
}: {
  actionSourceOptions: ScenarioActionEditorNodeData["uiActionSourceOptions"];
  /** Steps with no channel choice, such as generative AI, render nothing. */
  hidden?: boolean;
  selectedActionSourceId?: string;
  showWhatsAppActionKindSelect: boolean;
  t: TranslateFn;
  whatsAppActionKindOptions: Array<{
    id: ScenarioActionSelectorType;
    label: string;
  }>;
  whatsAppActionKindValue: ScenarioActionSelectorType;
  onActionSourceChange: (value: string) => void;
  onWhatsAppActionKindChange: (value: string) => void;
}) {
  if (hidden) return null;
  return (
    <div
      data-testid="action-source-controls"
      className={cn(
        "grid gap-1.5",
        showWhatsAppActionKindSelect
          ? "grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]"
          : "grid-cols-1"
      )}
    >
      <Select
        value={selectedActionSourceId ?? ""}
        onValueChange={onActionSourceChange}
      >
        <SelectTrigger
          aria-label={t("actionSourceSelectLabel")}
          className={cn(
            ACTION_NODE_CARD_CONTROL_CLASS,
            "h-8 w-full min-w-0 bg-background"
          )}
        >
          <SelectValue placeholder={t("actionSourceSameChat")} />
        </SelectTrigger>
        <SelectContent>
          {(actionSourceOptions || []).map(option => (
            <SelectItem
              key={option.id}
              value={option.id}
              textValue={option.label}
            >
              <span className="flex min-w-0 items-center gap-2">
                <ActionSourceIcon sourceId={option.id} />
                <span className="truncate">{option.label}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {showWhatsAppActionKindSelect ? (
        <Select
          value={whatsAppActionKindValue}
          onValueChange={onWhatsAppActionKindChange}
        >
          <SelectTrigger
            aria-label={t("actionWhatsAppKindSelectLabel")}
            className={cn(
              ACTION_NODE_CARD_CONTROL_CLASS,
              SCENARIO_SELECT_TRIGGER_HIDE_DESCRIPTION_CLASS,
              "h-8 w-full min-w-0 bg-background"
            )}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {whatsAppActionKindOptions.map(option => {
              const hintKey = WHATSAPP_ACTION_KIND_HINT_KEYS[option.id];
              return (
                <SelectItem
                  key={option.id}
                  value={option.id}
                  textValue={option.label}
                >
                  {hintKey ? (
                    <ScenarioSelectItemContent
                      label={option.label}
                      description={t(hintKey)}
                    />
                  ) : (
                    option.label
                  )}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}

/**
 * Button, links and files under a reply. Fields stay mounted while the
 * section is closed, so their errors can open it.
 */
export function ActionNodeAdvancedSettings({
  actionAssetsSection,
  showAdvanced,
  showAdvancedActionAssets,
  showTokenControls,
  promptInputFields,
  errorCount = 0,
  t,
  onInsertToken,
  onToggle,
}: {
  actionAssetsSection: ReactNode;
  showAdvanced: boolean;
  showAdvancedActionAssets: boolean;
  showTokenControls: boolean;
  /** Answers collected before this action, as the runtime renders them. */
  promptInputFields?: ScenarioVariableExtraField[];
  /** Blocking problems in the section's fields; opens it when they appear. */
  errorCount?: number;
  t: TranslateFn;
  onInsertToken: (token: string) => void;
  onToggle: () => void;
}) {
  if (!showTokenControls && !showAdvancedActionAssets) return null;
  return (
    <ScenarioCollapsibleSection
      title={t("actionAdvancedSettings")}
      open={showAdvanced}
      onOpenChange={open => {
        if (open !== showAdvanced) onToggle();
      }}
      keepMounted
      errorCount={errorCount}
      data-testid="action-node-advanced-settings"
    >
      <div className="space-y-2 px-3 pb-2 pt-1">
        {showTokenControls ? (
          <ScenarioVariableInserter
            t={t}
            variant="onLight"
            extraFields={promptInputFields}
            onInsertToken={onInsertToken}
          />
        ) : null}

        {showAdvancedActionAssets ? actionAssetsSection : null}
      </div>
    </ScenarioCollapsibleSection>
  );
}

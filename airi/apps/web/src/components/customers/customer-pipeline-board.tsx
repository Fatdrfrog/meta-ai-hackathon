"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState, ErrorState } from "@/components/ui/async-states";
import { Input } from "@/components/ui/input";
import { formatRelativeTime } from "@/lib/date-utils";
import type { CrmAttentionFilter, CrmAttentionKind } from "@/lib/crm/attention";
import type {
  CrmBoardCard,
  CrmBoardColumn,
  CrmBoardResponse,
} from "@/lib/crm/board-types";
import {
  isUsefulLeadChurn,
  isUsefulLeadSentiment,
  primaryLeadContactPoint,
  resolveNamedCrmStageKey,
} from "@/lib/crm/conversation-preview";
import type { CrmCardWarning } from "@/lib/crm/follow-up";
import {
  CRM_ATTENTION_DAYS_MAX,
  CRM_ATTENTION_DAYS_MIN,
  CRM_DEFAULT_ATTENTION_DAYS,
  CRM_UNASSIGNED_STAGE_KEY,
  normalizeCrmAttentionDays,
  normalizeCrmStageKey,
  type CrmPipelineStage,
} from "@/lib/crm/stages";
import { cn } from "@/lib/utils";
import {
  type Active,
  closestCorners,
  DndContext,
  type DraggableAttributes,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
  KeyboardCode,
  type KeyboardCodes,
  KeyboardSensor,
  MouseSensor,
  type Over,
  TouchSensor,
  type UniqueIdentifier,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Coins,
  MoreVertical,
  GripVertical,
  MessageCircle,
  ExternalLink,
  Plus,
  X,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  memo,
  useEffect,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { CustomerPipelineBoardSkeleton } from "./customer-pipeline-board-skeleton";

type LeadsCopy = {
  (key: string, values?: Record<string, string | number>): string;
};

function persistableStageId(id: string | null | undefined): string | null {
  if (!id) return null;
  if (
    id.startsWith("default-") ||
    id.startsWith("system-") ||
    id.startsWith("draft-")
  ) {
    return null;
  }
  return id;
}

function columnDisplayName(t: LeadsCopy, stage: CrmPipelineStage): string {
  const namedKey = resolveNamedCrmStageKey(stage.key);
  const namedCopy = namedKey ? t(`stages.${namedKey}`) : "";
  if (
    stage.key === CRM_UNASSIGNED_STAGE_KEY ||
    stage.id.startsWith("default-")
  ) {
    return namedCopy || stage.name;
  }
  return stage.name.trim() || namedCopy || stage.key;
}

function assignedStagesPayload(stages: readonly CrmPipelineStage[]) {
  return stages
    .filter(stage => stage.key !== CRM_UNASSIGNED_STAGE_KEY)
    .map((stage, sortOrder) => ({
      id: persistableStageId(stage.id),
      key: stage.key,
      name: stage.name.trim(),
      color: stage.color,
      sortOrder,
      isActive: stage.isActive !== false,
      ghostedAfterDays: normalizeCrmAttentionDays(stage.ghostedAfterDays),
      stalledAfterDays: normalizeCrmAttentionDays(stage.stalledAfterDays),
    }));
}

function reorderBoardStages(
  stages: CrmPipelineStage[],
  activeKey: string,
  overKey: string
): CrmPipelineStage[] {
  if (
    !activeKey ||
    !overKey ||
    activeKey === overKey ||
    activeKey === CRM_UNASSIGNED_STAGE_KEY ||
    overKey === CRM_UNASSIGNED_STAGE_KEY
  ) {
    return stages;
  }

  const from = stages.findIndex(stage => stage.key === activeKey);
  const to = stages.findIndex(stage => stage.key === overKey);
  if (from < 0 || to < 0) return stages;

  const next = [...stages];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);

  let assignedOrder = 0;
  return next.map(stage => {
    if (stage.key === CRM_UNASSIGNED_STAGE_KEY) {
      return { ...stage, sortOrder: -1 };
    }
    const sortOrder = assignedOrder;
    assignedOrder += 1;
    return { ...stage, sortOrder };
  });
}

function resolveOverStageKey(over: {
  id: unknown;
  data?: { current?: { stageKey?: string } | null };
} | null): string | undefined {
  if (!over) return undefined;
  if (over.data?.current?.stageKey) return over.data.current.stageKey;
  const id = String(over.id);
  if (id.startsWith("list:")) return id.slice("list:".length);
  if (id.startsWith("column:")) return id.slice("column:".length);
  return undefined;
}

/** The due label and whether it is overdue, from one clock reading. */
function followUpDue(
  t: LeadsCopy,
  dueAt: Date | string,
  now = new Date()
): { label: string; overdue: boolean } | null {
  const due = dueAt instanceof Date ? dueAt : new Date(dueAt);
  if (Number.isNaN(due.getTime())) return null;
  const diffMs = due.getTime() - now.getTime();
  const absMs = Math.abs(diffMs);
  const minutes = Math.max(1, Math.floor(absMs / 60000));
  const hours = Math.floor(absMs / 3600000);
  const days = Math.floor(absMs / 86400000);
  const compact =
    days >= 1 ? `${days}d` : hours >= 1 ? `${hours}h` : `${minutes}m`;
  const overdue = diffMs < 0;
  return {
    label: overdue
      ? t("followUp.overdue", { compact })
      : t("followUp.dueIn", { compact }),
    overdue,
  };
}

const PAGE_SIZE = 10;

/** Space picks up and drops; Enter is left to open the focused card. */
const BOARD_KEYBOARD_CODES: KeyboardCodes = {
  start: [KeyboardCode.Space],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space, KeyboardCode.Enter],
};

/**
 * Spread on controls inside a draggable header or card (rename, menus): the
 * mouse and touch sensors start on mousedown/touchstart, so stop those too.
 */
const KEEP_OUT_OF_DRAG = {
  onMouseDown: (event: { stopPropagation: () => void }) =>
    event.stopPropagation(),
  onTouchStart: (event: { stopPropagation: () => void }) =>
    event.stopPropagation(),
  onPointerDown: (event: { stopPropagation: () => void }) =>
    event.stopPropagation(),
};
const STAGE_COLOR_SWATCHES = [
  "#2563eb",
  "#7c3aed",
  "#0891b2",
  "#16a34a",
  "#ca8a04",
  "#dc2626",
  "#64748b",
];

function nextUnusedStageKey(name: string, existingKeys: ReadonlySet<string>) {
  const base = normalizeCrmStageKey(name) || "stage";
  if (!existingKeys.has(base) && base !== CRM_UNASSIGNED_STAGE_KEY) return base;
  let suffix = 2;
  while (
    existingKeys.has(`${base}_${suffix}`) ||
    `${base}_${suffix}` === CRM_UNASSIGNED_STAGE_KEY
  ) {
    suffix += 1;
  }
  return `${base}_${suffix}`;
}

function nextStageColor(stages: readonly CrmPipelineStage[]) {
  const used = new Set(stages.map(stage => stage.color));
  return (
    STAGE_COLOR_SWATCHES.find(color => !used.has(color)) ||
    STAGE_COLOR_SWATCHES[stages.length % STAGE_COLOR_SWATCHES.length]
  );
}

function fetcher<T>(url: string): Promise<T> {
  return fetch(url).then(async res => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data as T;
  });
}

function getInitials(name: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function formatLtv(value: number | null): string | null {
  if (typeof value !== "number") return null;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);
}

function sentimentBadgeClass(sentiment: string | null | undefined): string {
  if (!sentiment) return "";
  switch (sentiment.toLowerCase()) {
    case "positive":
      return "text-green-700 dark:text-green-400";
    case "negative":
      return "text-red-700 dark:text-red-400";
    default:
      return "";
  }
}

function churnBadgeVariant(
  level: string | null | undefined
): "default" | "secondary" | "destructive" | "outline" {
  if (!level) return "outline";
  switch (level.toLowerCase()) {
    case "high":
      return "destructive";
    case "medium":
      return "secondary";
    default:
      return "outline";
  }
}

function formatActivityLine(card: CrmBoardCard, t: LeadsCopy): string {
  const inbound = card.lastInboundAt
    ? t("activityIn", { time: formatRelativeTime(card.lastInboundAt) })
    : null;
  const outbound = card.lastOutboundAt
    ? t("activityOut", { time: formatRelativeTime(card.lastOutboundAt) })
    : null;
  if (inbound && outbound) return `${inbound} · ${outbound}`;
  if (inbound) return inbound;
  if (outbound) return outbound;
  if (card.lastInteractionAt) return formatRelativeTime(card.lastInteractionAt);
  return t("noRecentInteraction");
}

function attentionLabel(kind: CrmAttentionKind, t: LeadsCopy): string {
  switch (kind) {
    case "needs_reply":
      return t("attention.needs_reply");
    case "ghosted":
      return t("attention.ghosted");
    case "stalled":
      return t("attention.stalled");
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function attentionVariant(
  kind: CrmAttentionKind
): "destructive" | "secondary" | "outline" {
  switch (kind) {
    case "needs_reply":
      return "destructive";
    case "ghosted":
      return "secondary";
    case "stalled":
      return "outline";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function warningLabel(warning: CrmCardWarning, t: LeadsCopy): string {
  switch (warning) {
    case "objection":
      return t("warning.objection");
    default: {
      const exhaustive: never = warning;
      return exhaustive;
    }
  }
}

function requestsHref(
  workspaceId: string,
  conversationId: string
): string {
  return `/panel/w/${encodeURIComponent(workspaceId)}/requests?conversation=${encodeURIComponent(conversationId)}`;
}

function findCard(
  board: CrmBoardResponse | undefined,
  cardId: string
): { card: CrmBoardCard; column: CrmBoardColumn } | null {
  if (!board) return null;
  for (const column of board.columns) {
    const card = column.cards.find(item => item.id === cardId);
    if (card) return { card, column };
  }
  return null;
}

function moveCardBetweenColumns(
  board: CrmBoardResponse,
  cardId: string,
  targetStageKey: string
): CrmBoardResponse {
  const source = findCard(board, cardId);
  if (!source || source.column.stageKey === targetStageKey) return board;

  const movedCard = { ...source.card, stageKey: targetStageKey };
  return {
    ...board,
    columns: board.columns.map(column => {
      if (column.stageKey === source.column.stageKey) {
        return {
          ...column,
          totalCount: Math.max(0, column.totalCount - 1),
          cards: column.cards.filter(card => card.id !== cardId),
        };
      }
      if (column.stageKey === targetStageKey) {
        return {
          ...column,
          totalCount: column.totalCount + 1,
          cards: [movedCard, ...column.cards],
        };
      }
      return column;
    }),
  };
}

const CARD_BADGE_CLASS = "h-5 px-1.5 text-[11px]";
const COLUMN_WIDTH_CLASS = "w-[280px] max-sm:w-[85vw]";

/**
 * Compact, Trello-style card. The lead name is the card's only button and its
 * ::after overlay covers the card, so a click anywhere opens the profile and
 * the chat link stays a sibling control instead of a nested one.
 */
function PipelineCardBody({
  card,
  workspaceId,
  onSelect,
  titleRef,
  titleAttributes,
  overlay = false,
}: {
  card: CrmBoardCard;
  workspaceId: string;
  onSelect?: (customerId: string) => void;
  titleRef?: (element: HTMLElement | null) => void;
  titleAttributes?: DraggableAttributes;
  overlay?: boolean;
}) {
  const t = useTranslations("LeadsPage");
  const name = card.displayName || t("unknownLead");
  const contact = primaryLeadContactPoint(card.contactPoints);
  const ltv = formatLtv(card.estimatedCustomerLtv);
  const attention = card.attention || [];
  const warnings = card.warnings || [];
  const isSales = card.category === "Sales";
  const showSentiment = isUsefulLeadSentiment(card.sentiment);
  const showChurn = isUsefulLeadChurn(card.churnRiskLevel);
  const hasBadges =
    attention.length > 0 ||
    warnings.length > 0 ||
    isSales ||
    showSentiment ||
    showChurn;
  const chatHref = card.primaryConversationId
    ? requestsHref(workspaceId, card.primaryConversationId)
    : null;
  const followUpKind = card.followUpKind || null;
  const due = card.followUpDueAt ? followUpDue(t, card.followUpDueAt) : null;
  const chatCountLabel = t("chatCount", { count: card.conversationCount });
  const ltvLabel = ltv ? t("ltv", { value: ltv }) : null;
  const activity = formatActivityLine(card, t);

  return (
    <div
      className={cn(
        "relative rounded-lg border bg-card p-2.5 text-card-foreground shadow-xs transition-[border-color,box-shadow]",
        overlay
          ? "rotate-[0.5deg] cursor-grabbing shadow-lg ring-2 ring-primary/30"
          : "hover:border-primary/40 focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-ring/40"
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium leading-5">
            <button
              ref={titleRef}
              type="button"
              {...titleAttributes}
              tabIndex={onSelect ? 0 : -1}
              className="max-w-full cursor-pointer truncate text-left outline-none after:absolute after:inset-0 after:rounded-lg after:content-['']"
              onClick={onSelect ? () => onSelect(card.id) : undefined}
            >
              {name}
            </button>
          </h3>
          {contact ? (
            <p className="truncate text-xs text-muted-foreground">{contact}</p>
          ) : null}
        </div>
        {card.ownerUserId ? (
          <span
            className="shrink-0"
            role="img"
            aria-label={
              card.ownerLabel
                ? t("ownerNamed", { name: card.ownerLabel })
                : t("assignedOwner")
            }
            title={card.ownerLabel || t("assigned")}
          >
            <Avatar className="size-5">
              <AvatarFallback className="text-[9px]">
                {getInitials(card.ownerLabel || null)}
              </AvatarFallback>
            </Avatar>
          </span>
        ) : null}
      </div>

      {hasBadges ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {attention.map(kind => (
            <Badge
              key={kind}
              variant={attentionVariant(kind)}
              className={CARD_BADGE_CLASS}
            >
              {attentionLabel(kind, t)}
            </Badge>
          ))}
          {warnings.map(warning => (
            <Badge
              key={warning}
              variant="destructive"
              className={CARD_BADGE_CLASS}
            >
              {warningLabel(warning, t)}
            </Badge>
          ))}
          {isSales ? (
            <Badge variant="outline" className={CARD_BADGE_CLASS}>
              {t("sales")}
            </Badge>
          ) : null}
          {showSentiment ? (
            <Badge
              variant="outline"
              className={cn(
                CARD_BADGE_CLASS,
                sentimentBadgeClass(card.sentiment)
              )}
            >
              {t(`sentiment.${card.sentiment?.toLowerCase()}` as never)}
            </Badge>
          ) : null}
          {showChurn ? (
            <Badge
              variant={churnBadgeVariant(card.churnRiskLevel)}
              className={CARD_BADGE_CLASS}
            >
              {t("churnWithLevel", {
                level: t(
                  `churn.${card.churnRiskLevel?.toLowerCase()}` as never
                ),
              })}
            </Badge>
          ) : null}
        </div>
      ) : null}

      {followUpKind ? (
        <p className="mt-1.5 truncate text-xs">
          <span className="font-medium">{t(`followUp.${followUpKind}`)}</span>
          {due ? (
            <span
              className={cn(
                "ml-1.5",
                due.overdue ? "text-destructive" : "text-muted-foreground"
              )}
            >
              {due.label}
            </span>
          ) : null}
        </p>
      ) : card.nextAction ? (
        <p
          className="mt-1.5 truncate text-xs font-medium"
          title={card.nextAction}
        >
          {card.nextAction}
        </p>
      ) : null}

      {card.lastInboundSnippet ? (
        <p
          className="mt-0.5 line-clamp-1 text-xs text-muted-foreground"
          title={card.lastInboundSnippet}
        >
          {card.lastInboundSnippet}
        </p>
      ) : null}

      <div className="mt-2 flex items-center gap-2.5 text-xs text-muted-foreground">
        <span
          className="inline-flex shrink-0 items-center gap-1"
          title={chatCountLabel}
        >
          <MessageCircle className="size-3.5" aria-hidden="true" />
          <span aria-hidden="true" className="tabular-nums">
            {card.conversationCount}
          </span>
          <span className="sr-only">{chatCountLabel}</span>
        </span>
        {ltvLabel ? (
          <span
            className="inline-flex shrink-0 items-center gap-1"
            title={ltvLabel}
          >
            <Coins className="size-3.5" aria-hidden="true" />
            <span aria-hidden="true" className="tabular-nums">
              {ltv}
            </span>
            <span className="sr-only">{ltvLabel}</span>
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate" title={activity}>
          {activity}
        </span>
        {chatHref ? (
          <Link
            href={chatHref}
            tabIndex={overlay ? -1 : undefined}
            className="relative z-10 -my-1 -mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("openChatFor", { name })}
            title={t("openChat")}
          >
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The whole card drags (mouse after a few pixels, touch after a long press);
 * Space on the focused name picks it up from the keyboard. Memoized: SWR keeps
 * unchanged cards' identity across refreshes, so only changed cards re-render.
 */
const SortablePipelineCard = memo(function SortablePipelineCard({
  card,
  workspaceId,
  onSelect,
}: {
  card: CrmBoardCard;
  workspaceId: string;
  onSelect: (customerId: string) => void;
}) {
  const t = useTranslations("LeadsPage");
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `card:${card.id}`,
    data: {
      type: "card",
      cardId: card.id,
      stageKey: card.stageKey,
    },
    attributes: { roleDescription: t("dnd.cardRole") },
  });

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: transform ? CSS.Transform.toString(transform) : undefined,
        transition,
      }}
      className={cn("touch-manipulation", isDragging && "opacity-40")}
      {...listeners}
    >
      <PipelineCardBody
        card={card}
        workspaceId={workspaceId}
        onSelect={onSelect}
        titleRef={setActivatorNodeRef}
        titleAttributes={attributes}
      />
    </li>
  );
});

function PipelineDragOverlayCard({
  card,
  workspaceId,
}: {
  card: CrmBoardCard;
  workspaceId: string;
}) {
  return (
    <div className="w-[264px] max-sm:w-[calc(85vw-1rem)]">
      <PipelineCardBody card={card} workspaceId={workspaceId} overlay />
    </div>
  );
}

function PipelineColumnTitle({
  id,
  stage,
  title,
  disabled,
  onRename,
}: {
  id: string;
  stage: CrmPipelineStage;
  title: string;
  disabled: boolean;
  onRename: (stageKey: string, name: string) => Promise<void>;
}) {
  const t = useTranslations("LeadsPage");
  const inputRef = useRef<HTMLInputElement>(null);
  const editSessionRef = useRef(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const canRename = stage.key !== CRM_UNASSIGNED_STAGE_KEY && !disabled;

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [editing, title]);

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [editing]);

  const cancelEdit = () => {
    editSessionRef.current = 0;
    setDraft(title);
    setEditing(false);
  };

  const commitRename = async () => {
    if (editSessionRef.current === 0) return;
    editSessionRef.current = 0;
    const nextName = draft.trim();
    setEditing(false);
    if (!nextName || nextName === title) {
      setDraft(title);
      return;
    }
    setSaving(true);
    try {
      await onRename(stage.key, nextName);
    } catch {
      setDraft(title);
    } finally {
      setSaving(false);
    }
  };

  if (!canRename) {
    // Same inset as the rename button so every column title lines up.
    return (
      <h2
        id={id}
        className="min-w-0 flex-1 truncate px-1 py-0.5 text-sm font-semibold"
        title={title}
      >
        {title}
      </h2>
    );
  }

  if (editing) {
    return (
      <Input
        ref={inputRef}
        value={draft}
        maxLength={80}
        disabled={saving}
        aria-label={t("pipeline.renameColumn", { name: title })}
        className="h-7 px-1.5 py-0 text-sm font-semibold shadow-none"
        onChange={event => setDraft(event.target.value)}
        {...KEEP_OUT_OF_DRAG}
        onKeyDown={event => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commitRename();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            cancelEdit();
          }
        }}
        onBlur={() => {
          void commitRename();
        }}
      />
    );
  }

  return (
    <h2 id={id} className="min-w-0 flex-1">
      <button
        type="button"
        className="block w-full truncate rounded-sm px-1 py-0.5 text-left text-sm font-semibold hover:bg-background/80 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        title={title}
        aria-label={t("pipeline.renameColumn", { name: title })}
        disabled={saving}
        {...KEEP_OUT_OF_DRAG}
        onClick={() => {
          editSessionRef.current += 1;
          setEditing(true);
        }}
      >
        {title}
      </button>
    </h2>
  );
}

function PipelineAddList({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (name: string) => Promise<void>;
}) {
  const t = useTranslations("LeadsPage");
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  const closeComposer = () => {
    setOpen(false);
    setDraft("");
  };

  const commitAdd = async () => {
    const nextName = draft.trim();
    if (!nextName || saving || disabled) return;
    setSaving(true);
    try {
      await onAdd(nextName);
      setDraft("");
      inputRef.current?.focus();
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        aria-label={t("pipeline.addList")}
        className={cn(
          COLUMN_WIDTH_CLASS,
          "flex h-fit shrink-0 items-center gap-2 rounded-xl bg-muted/40 px-3 py-2.5 text-left text-sm font-medium text-muted-foreground hover:bg-muted max-sm:snap-start"
        )}
        onClick={() => setOpen(true)}
      >
        <Plus className="size-4" />
        {t("pipeline.addList")}
      </button>
    );
  }

  return (
    <div
      className={cn(
        COLUMN_WIDTH_CLASS,
        "shrink-0 rounded-xl bg-muted/60 p-2 max-sm:snap-start"
      )}
    >
      <Input
        ref={inputRef}
        value={draft}
        maxLength={80}
        disabled={saving || disabled}
        placeholder={t("pipeline.addListPlaceholder")}
        aria-label={t("pipeline.addListPlaceholder")}
        className="mb-2 h-8 bg-background"
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commitAdd();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            closeComposer();
          }
        }}
      />
      <div className="flex items-center gap-1">
        <Button
          type="button"
          size="sm"
          disabled={saving || disabled || !draft.trim()}
          onClick={() => void commitAdd()}
        >
          {t("pipeline.addListConfirm")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("pipeline.cancel")}
          disabled={saving}
          onClick={closeComposer}
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}

type PipelineStagePatch = Partial<
  Pick<
    CrmPipelineStage,
    "color" | "ghostedAfterDays" | "stalledAfterDays" | "isActive"
  >
>;

function PipelineColumnMenu({
  stage,
  title,
  leadCount,
  onPatch,
}: {
  stage: CrmPipelineStage;
  title: string;
  leadCount: number;
  onPatch: (stageKey: string, patch: PipelineStagePatch) => Promise<void>;
}) {
  const t = useTranslations("LeadsPage");
  const [ghostedAfterDays, setGhostedAfterDays] = useState(
    String(normalizeCrmAttentionDays(stage.ghostedAfterDays))
  );
  const [stalledAfterDays, setStalledAfterDays] = useState(
    String(normalizeCrmAttentionDays(stage.stalledAfterDays))
  );
  const archiveDisabled = leadCount > 0;

  useEffect(() => {
    setGhostedAfterDays(String(normalizeCrmAttentionDays(stage.ghostedAfterDays)));
    setStalledAfterDays(String(normalizeCrmAttentionDays(stage.stalledAfterDays)));
  }, [stage.ghostedAfterDays, stage.stalledAfterDays]);

  const commitDays = async (
    field: "ghostedAfterDays" | "stalledAfterDays",
    raw: string
  ) => {
    const nextDays = normalizeCrmAttentionDays(raw);
    if (field === "ghostedAfterDays") setGhostedAfterDays(String(nextDays));
    else setStalledAfterDays(String(nextDays));
    if (nextDays === normalizeCrmAttentionDays(stage[field])) return;
    await onPatch(stage.key, { [field]: nextDays });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("pipeline.listMenu", { name: title })}
          {...KEEP_OUT_OF_DRAG}
        >
          <MoreVertical className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>{t("pipeline.stageName")}</DropdownMenuLabel>
        <div className="flex flex-wrap gap-1.5 px-2 pb-2">
          {STAGE_COLOR_SWATCHES.map(color => (
            <button
              key={color}
              type="button"
              aria-label={t("pipeline.useColorFor", { color, name: title })}
              className={cn(
                "size-5 rounded-full border border-border",
                stage.color === color && "ring-2 ring-ring"
              )}
              style={{ backgroundColor: color }}
              onClick={() => void onPatch(stage.key, { color })}
            />
          ))}
        </div>
        <DropdownMenuSeparator />
        <div
          className="grid grid-cols-2 gap-2 px-2 py-2"
          {...KEEP_OUT_OF_DRAG}
          onKeyDown={event => event.stopPropagation()}
        >
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">
              {t("pipeline.ghostedAfter")}
            </span>
            <Input
              type="number"
              inputMode="numeric"
              min={CRM_ATTENTION_DAYS_MIN}
              max={CRM_ATTENTION_DAYS_MAX}
              value={ghostedAfterDays}
              aria-label={t("pipeline.ghostedAfter")}
              className="h-8"
              onChange={event => setGhostedAfterDays(event.target.value)}
              onBlur={() => void commitDays("ghostedAfterDays", ghostedAfterDays)}
              onKeyDown={event => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commitDays("ghostedAfterDays", ghostedAfterDays);
                }
              }}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">
              {t("pipeline.stalledAfter")}
            </span>
            <Input
              type="number"
              inputMode="numeric"
              min={CRM_ATTENTION_DAYS_MIN}
              max={CRM_ATTENTION_DAYS_MAX}
              value={stalledAfterDays}
              aria-label={t("pipeline.stalledAfter")}
              className="h-8"
              onChange={event => setStalledAfterDays(event.target.value)}
              onBlur={() => void commitDays("stalledAfterDays", stalledAfterDays)}
              onKeyDown={event => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commitDays("stalledAfterDays", stalledAfterDays);
                }
              }}
            />
          </label>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={archiveDisabled}
          title={
            archiveDisabled ? t("pipeline.moveOutBeforeArchive") : undefined
          }
          onSelect={event => {
            if (archiveDisabled) {
              event.preventDefault();
              toast.error(t("pipeline.moveOutBeforeArchive"));
              return;
            }
            void onPatch(stage.key, { isActive: false });
          }}
        >
          {t("pipeline.archiveStage")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PipelineColumn({
  stage,
  column,
  workspaceId,
  emptyLabel,
  onSelectCustomer,
  onLoadMore,
  onRenameStage,
  onPatchStage,
}: {
  stage: CrmPipelineStage;
  column: CrmBoardColumn | undefined;
  workspaceId: string;
  emptyLabel: string;
  onSelectCustomer: (customerId: string) => void;
  onLoadMore: (stageKey: string) => void;
  onRenameStage: (stageKey: string, name: string) => Promise<void>;
  onPatchStage: (stageKey: string, patch: PipelineStagePatch) => Promise<void>;
}) {
  const t = useTranslations("LeadsPage");
  const titleId = useId();
  const isSystemColumn = stage.key === CRM_UNASSIGNED_STAGE_KEY;
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `list:${stage.key}`,
    data: {
      type: "column",
      stageKey: stage.key,
    },
    disabled: isSystemColumn,
    attributes: { roleDescription: t("dnd.listRole") },
  });
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: `column:${stage.key}`,
    data: {
      type: "column",
      stageKey: stage.key,
    },
  });
  const cards = column?.cards || [];
  const totalCount = column?.totalCount || 0;
  const hiddenCount = Math.max(0, totalCount - cards.length);
  const ltv = formatLtv(column?.ltvSum ?? null);
  const ltvLabel = ltv ? t("ltv", { value: ltv }) : null;
  const title = columnDisplayName(t, stage);

  return (
    // Lists are as tall as their cards, up to the board height (then the
    // cards scroll), like Trello: no tall empty boxes.
    <section
      ref={setSortableRef}
      aria-labelledby={titleId}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        COLUMN_WIDTH_CLASS,
        "flex max-h-full min-h-0 shrink-0 flex-col rounded-xl bg-muted/60 max-sm:snap-start",
        isDragging && "opacity-60"
      )}
    >
      {/* The whole header drags with a pointer; the grip is the keyboard and
          touch handle, so nested title/menu buttons are not inside a "button". */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-1.5 px-2 pb-1.5 pt-2",
          !isSystemColumn && "cursor-grab active:cursor-grabbing"
        )}
        {...(isSystemColumn ? {} : listeners)}
      >
        {isSystemColumn ? null : (
          <button
            ref={setActivatorNodeRef}
            type="button"
            aria-label={t("dragAria", { name: title })}
            className="shrink-0 cursor-grab touch-none rounded-sm p-0.5 text-muted-foreground opacity-60 hover:bg-muted hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing"
            {...attributes}
          >
            <GripVertical className="size-4" />
          </button>
        )}
        <span
          className="size-2.5 shrink-0 rounded-full bg-muted-foreground"
          style={stage.color ? { backgroundColor: stage.color } : undefined}
          aria-hidden="true"
        />
        <PipelineColumnTitle
          id={titleId}
          stage={stage}
          title={title}
          disabled={false}
          onRename={onRenameStage}
        />
        {ltvLabel ? (
          <span
            className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
            title={ltvLabel}
          >
            {ltvLabel}
          </span>
        ) : null}
        <span className="shrink-0 rounded-full bg-background px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
          {totalCount}
        </span>
        {isSystemColumn ? null : (
          <PipelineColumnMenu
            stage={stage}
            title={title}
            leadCount={totalCount}
            onPatch={onPatchStage}
          />
        )}
      </div>
      <ul
        ref={setDroppableRef}
        data-testid={`crm-pipeline-column-cards-${stage.key}`}
        aria-labelledby={titleId}
        // Contain only the y axis: sideways swipes and Shift+wheel over the cards
        // must chain to the board's horizontal scroller.
        className={cn(
          "flex min-h-0 flex-col gap-2 overflow-x-hidden overflow-y-auto overscroll-y-contain px-2 pb-2 transition-colors [scrollbar-width:thin]",
          isOver && "rounded-b-xl bg-primary/5"
        )}
      >
        <SortableContext
          items={cards.map(card => `card:${card.id}`)}
          strategy={verticalListSortingStrategy}
        >
          {cards.map(card => (
            <SortablePipelineCard
              key={card.id}
              card={card}
              workspaceId={workspaceId}
              onSelect={onSelectCustomer}
            />
          ))}
        </SortableContext>
        {cards.length === 0 ? (
          <li className="rounded-lg border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">
            {emptyLabel}
          </li>
        ) : null}
        {hiddenCount > 0 ? (
          <li>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-start text-muted-foreground"
              onClick={() => onLoadMore(stage.key)}
            >
              <Plus className="size-4" />
              {t("loadMore", { count: Math.min(PAGE_SIZE, hiddenCount) })}
            </Button>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

/**
 * Trello-style navigation on the empty board between and below lists: drag
 * with the mouse to pan, and turn a plain vertical wheel into sideways scroll.
 * Lists keep their own scrolling and cards keep drag-and-drop.
 */
function useBoardBackgroundScroll(board: HTMLDivElement | null) {
  useEffect(() => {
    if (!board) return;
    let pan: { pointerId: number; startX: number; startLeft: number } | null =
      null;

    const onWheel = (event: WheelEvent) => {
      if (event.target !== board || event.ctrlKey) return;
      if (event.deltaX !== 0 || event.deltaY === 0) return;
      if (board.scrollWidth <= board.clientWidth) return;
      event.preventDefault();
      board.scrollLeft +=
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * 16
          : event.deltaY;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target !== board || event.button !== 0) return;
      if (event.pointerType !== "mouse") return;
      event.preventDefault();
      pan = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startLeft: board.scrollLeft,
      };
      board.setPointerCapture(event.pointerId);
      board.dataset.panning = "true";
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!pan || event.pointerId !== pan.pointerId) return;
      board.scrollLeft = pan.startLeft - (event.clientX - pan.startX);
    };
    const endPan = (event: PointerEvent) => {
      if (!pan || event.pointerId !== pan.pointerId) return;
      pan = null;
      delete board.dataset.panning;
      if (board.hasPointerCapture(event.pointerId)) {
        board.releasePointerCapture(event.pointerId);
      }
    };

    board.addEventListener("wheel", onWheel, { passive: false });
    board.addEventListener("pointerdown", onPointerDown);
    board.addEventListener("pointermove", onPointerMove);
    board.addEventListener("pointerup", endPan);
    board.addEventListener("pointercancel", endPan);
    return () => {
      board.removeEventListener("wheel", onWheel);
      board.removeEventListener("pointerdown", onPointerDown);
      board.removeEventListener("pointermove", onPointerMove);
      board.removeEventListener("pointerup", endPan);
      board.removeEventListener("pointercancel", endPan);
    };
  }, [board]);
}

export function CustomerPipelineBoard({
  workspaceId,
  status,
  search,
  attention = "attention",
  salesOnly = false,
  includeSupport = false,
  ownerMine = false,
  onSelectCustomer,
  onTotalChange,
}: {
  workspaceId: string;
  status: string;
  search: string;
  attention?: CrmAttentionFilter;
  salesOnly?: boolean;
  includeSupport?: boolean;
  ownerMine?: boolean;
  onSelectCustomer: (customerId: string) => void;
  /** Lead total for the page toolbar; null while the board has no data. */
  onTotalChange?: (total: number | null) => void;
}) {
  const t = useTranslations("LeadsPage");
  const [stageLimits, setStageLimits] = useState<Record<string, number>>({});
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [boardScroller, setBoardScroller] = useState<HTMLDivElement | null>(
    null
  );
  useBoardBackgroundScroll(boardScroller);
  // Whole cards drag: the mouse after a few pixels (a click still opens the
  // card), touch after a long press (a swipe still scrolls). Space picks up
  // from the keyboard, so Enter on a focused card keeps opening it.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: BOARD_KEYBOARD_CODES,
    })
  );

  const boardUrl = useMemo(() => {
    const params = new URLSearchParams({
      status,
      limitPerStage: String(PAGE_SIZE),
      attention,
    });
    if (salesOnly) params.set("salesOnly", "1");
    if (includeSupport) params.set("support", "1");
    if (ownerMine) params.set("owner", "me");
    if (search) params.set("search", search);
    for (const [stageKey, limit] of Object.entries(stageLimits)) {
      params.set(`stageLimit.${stageKey}`, String(limit));
    }
    return `/api/workspaces/${encodeURIComponent(
      workspaceId
    )}/crm/board?${params.toString()}`;
  }, [
    attention,
    includeSupport,
    ownerMine,
    salesOnly,
    search,
    stageLimits,
    status,
    workspaceId,
  ]);

  const { data, error, isLoading, mutate } = useSWR<CrmBoardResponse>(
    boardUrl,
    fetcher,
    {
      keepPreviousData: true,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    }
  );

  const columnsByStage = useMemo(() => {
    const map = new Map<string, CrmBoardColumn>();
    for (const column of data?.columns || []) {
      map.set(column.stageKey, column);
    }
    return map;
  }, [data?.columns]);
  const activeCard = useMemo(() => {
    if (!activeCardId) return null;
    return findCard(data, activeCardId)?.card ?? null;
  }, [activeCardId, data]);

  const totalCards = data
    ? data.columns.reduce((sum, column) => sum + column.totalCount, 0)
    : null;
  useEffect(() => {
    onTotalChange?.(totalCards);
  }, [onTotalChange, totalCards]);

  // Screen reader announcements in the interface language, by lead and list
  // name instead of dnd-kit's default English with internal ids.
  const accessibility = useMemo(() => {
    const stageTitles = new Map(
      (data?.stages ?? []).map(stage => [
        stage.key,
        columnDisplayName(t, stage),
      ])
    );
    const nameOf = (id: UniqueIdentifier) => {
      const raw = String(id);
      if (raw.startsWith("card:")) {
        const found = findCard(data, raw.slice("card:".length));
        return found?.card.displayName || t("unknownLead");
      }
      const stageKey = raw.replace(/^(list|column):/, "");
      return stageTitles.get(stageKey) || stageKey;
    };
    const targetOf = (over: Parameters<typeof resolveOverStageKey>[0]) => {
      const stageKey = resolveOverStageKey(over);
      return stageKey ? stageTitles.get(stageKey) || stageKey : null;
    };
    return {
      screenReaderInstructions: { draggable: t("dnd.instructions") },
      announcements: {
        onDragStart: ({ active }: { active: Active }) =>
          t("dnd.pickedUp", { name: nameOf(active.id) }),
        onDragOver: ({
          active,
          over,
        }: {
          active: Active;
          over: Over | null;
        }) => {
          const target = targetOf(over);
          return target
            ? t("dnd.over", { name: nameOf(active.id), target })
            : t("dnd.notOver", { name: nameOf(active.id) });
        },
        onDragEnd: ({
          active,
          over,
        }: {
          active: Active;
          over: Over | null;
        }) => {
          const target = targetOf(over);
          return target
            ? t("dnd.dropped", { name: nameOf(active.id), target })
            : t("dnd.cancelled", { name: nameOf(active.id) });
        },
        onDragCancel: ({ active }: { active: Active }) =>
          t("dnd.cancelled", { name: nameOf(active.id) }),
      },
    };
  }, [data, t]);

  const handleLoadMore = useCallback((stageKey: string) => {
    setStageLimits(current => ({
      ...current,
      [stageKey]: (current[stageKey] || PAGE_SIZE) + PAGE_SIZE,
    }));
  }, []);

  const pipelineUrl = `/api/workspaces/${encodeURIComponent(
    workspaceId
  )}/crm/pipeline`;

  const persistAssignedStages = useCallback(
    async (
      nextBoard: CrmBoardResponse,
      stagesForSave: CrmPipelineStage[] = [
        ...nextBoard.stages.filter(
          stage => stage.key !== CRM_UNASSIGNED_STAGE_KEY
        ),
        ...(nextBoard.archivedStages ?? []),
      ]
    ) => {
      if (!data) return;
      const previousBoard = data;
      await mutate(nextBoard, { revalidate: false });

      try {
        const response = await fetch(pipelineUrl, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            stages: assignedStagesPayload(stagesForSave),
          }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        if (!response.ok) {
          throw new Error(payload.error || t("pipeline.saveFailed"));
        }
        await mutate();
      } catch (saveError) {
        await mutate(previousBoard, { revalidate: false });
        toast.error(
          saveError instanceof Error
            ? saveError.message
            : t("pipeline.saveFailed")
        );
        throw saveError;
      }
    },
    [data, mutate, pipelineUrl, t]
  );

  const handleRenameStage = useCallback(
    async (stageKey: string, name: string) => {
      if (!data || stageKey === CRM_UNASSIGNED_STAGE_KEY) return;
      const nextName = name.trim();
      if (!nextName) {
        toast.error(t("pipeline.nameRequired"));
        throw new Error("Stage name is required");
      }

      await persistAssignedStages({
        ...data,
        stages: data.stages.map(stage =>
          stage.key === stageKey ? { ...stage, name: nextName } : stage
        ),
      });
    },
    [data, persistAssignedStages, t]
  );

  const handleAddStage = useCallback(
    async (name: string) => {
      if (!data) return;
      const nextName = name.trim();
      if (!nextName) {
        toast.error(t("pipeline.nameRequired"));
        throw new Error("Stage name is required");
      }

      const existingKeys = new Set(data.stages.map(stage => stage.key));
      const key = nextUnusedStageKey(nextName, existingKeys);
      const assignedCount = data.stages.filter(
        stage => stage.key !== CRM_UNASSIGNED_STAGE_KEY
      ).length;
      const stage: CrmPipelineStage = {
        id: `draft-${key}`,
        key,
        name: nextName,
        color: nextStageColor(data.stages),
        sortOrder: assignedCount,
        isActive: true,
        ghostedAfterDays: CRM_DEFAULT_ATTENTION_DAYS,
        stalledAfterDays: CRM_DEFAULT_ATTENTION_DAYS,
      };

      await persistAssignedStages({
        ...data,
        stages: [...data.stages, stage],
        columns: [
          ...data.columns,
          {
            stageKey: key,
            totalCount: 0,
            ltvSum: null,
            nextCursor: null,
            cards: [],
          },
        ],
      });
    },
    [data, persistAssignedStages, t]
  );

  const handlePatchStage = useCallback(
    async (stageKey: string, patch: PipelineStagePatch) => {
      if (!data || stageKey === CRM_UNASSIGNED_STAGE_KEY) return;
      const existingArchived = data.archivedStages ?? [];
      const fromActive = data.stages.find(stage => stage.key === stageKey);
      const fromArchived = existingArchived.find(stage => stage.key === stageKey);
      const current = fromActive ?? fromArchived;
      if (!current) return;

      const nextStage = { ...current, ...patch };
      const remainingActive = data.stages.filter(stage => stage.key !== stageKey);
      const remainingArchived = existingArchived.filter(
        stage => stage.key !== stageKey
      );
      const nextActive =
        nextStage.isActive === false
          ? remainingActive
          : [...remainingActive, nextStage];
      const nextArchived =
        nextStage.isActive === false
          ? [...remainingArchived, nextStage]
          : remainingArchived;
      const nextColumns =
        nextStage.isActive === false
          ? data.columns.filter(column => column.stageKey !== stageKey)
          : data.columns.some(column => column.stageKey === stageKey)
            ? data.columns
            : [
                ...data.columns,
                {
                  stageKey,
                  totalCount: 0,
                  ltvSum: null,
                  nextCursor: null,
                  cards: [],
                },
              ];

      await persistAssignedStages(
        {
          ...data,
          stages: nextActive,
          archivedStages: nextArchived,
          columns: nextColumns,
        },
        [
          ...nextActive.filter(
            stage => stage.key !== CRM_UNASSIGNED_STAGE_KEY
          ),
          ...nextArchived,
        ]
      );
    },
    [data, persistAssignedStages]
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const activeId = String(event.active.id);
    if (activeId.startsWith("card:")) {
      setActiveCardId(activeId.replace(/^card:/, ""));
      return;
    }
    setActiveCardId(null);
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveCardId(null);
      if (!data) return;

      const activeId = String(event.active.id);
      const overStageKey = resolveOverStageKey(event.over);
      if (!overStageKey) return;

      if (activeId.startsWith("list:")) {
        const activeKey = activeId.replace(/^list:/, "");
        const nextStages = reorderBoardStages(
          data.stages,
          activeKey,
          overStageKey
        );
        if (nextStages === data.stages) return;
        const order = nextStages.map(stage => stage.key);
        await persistAssignedStages({
          ...data,
          stages: nextStages,
          columns: [...data.columns].sort(
            (left, right) =>
              order.indexOf(left.stageKey) - order.indexOf(right.stageKey)
          ),
        });
        return;
      }

      if (!activeId.startsWith("card:")) return;
      const cardId = activeId.replace(/^card:/, "");
      const source = findCard(data, cardId);
      if (!source || source.column.stageKey === overStageKey) return;

      const previousBoard = data;
      await mutate(moveCardBetweenColumns(data, cardId, overStageKey), {
        revalidate: false,
      });

      try {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(
            workspaceId
          )}/crm/customers/${encodeURIComponent(cardId)}/stage`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              stageKey:
                overStageKey === CRM_UNASSIGNED_STAGE_KEY ? null : overStageKey,
              expectedStageKey:
                source.column.stageKey === CRM_UNASSIGNED_STAGE_KEY
                  ? null
                  : source.column.stageKey,
            }),
          }
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || t("pipeline.updateStageFailed"));
        }
        await mutate();
      } catch (moveError) {
        await mutate(previousBoard, { revalidate: false });
        toast.error(
          moveError instanceof Error
            ? moveError.message
            : t("pipeline.updateStageFailed")
        );
      }
    },
    [data, mutate, persistAssignedStages, t, workspaceId]
  );

  if (error) {
    return (
      <ErrorState
        message={error.message || t("loadFailedPipeline")}
        onRetry={() => mutate()}
      />
    );
  }

  if (isLoading && !data) {
    return <CustomerPipelineBoardSkeleton />;
  }

  if (!data || data.stages.length === 0) {
    return (
      <EmptyState
        title={t("emptyPipelineTitle")}
        description={t("emptyPipelineDescription")}
      />
    );
  }

  return (
    <div
      data-testid="crm-pipeline-board"
      className="flex h-full min-h-0 flex-1 flex-col gap-2 overflow-hidden"
    >
      {totalCards === 0 && attention !== "all" ? (
        <p className="text-xs text-muted-foreground">{t("quietQueue")}</p>
      ) : null}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        accessibility={accessibility}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveCardId(null)}
      >
        {/* Focusable so arrow keys scroll the board; phones snap list by list. */}
        <div
          ref={setBoardScroller}
          data-testid="crm-pipeline-columns"
          role="region"
          aria-label={t("boardAria")}
          tabIndex={0}
          className="flex h-full min-h-0 flex-1 items-start gap-3 overflow-x-auto overflow-y-hidden rounded-md pb-2 outline-none [scrollbar-width:thin] focus-visible:ring-2 focus-visible:ring-ring/50 data-[panning=true]:cursor-grabbing data-[panning=true]:select-none max-sm:snap-x max-sm:snap-mandatory"
          data-active-card-id={activeCardId || undefined}
        >
          <SortableContext
            items={data.stages.map(stage => `list:${stage.key}`)}
            strategy={horizontalListSortingStrategy}
          >
            {data.stages.map(stage => (
              <PipelineColumn
                key={stage.key}
                stage={stage}
                column={columnsByStage.get(stage.key)}
                workspaceId={workspaceId}
                emptyLabel={
                  attention === "all" ? t("noLeads") : t("noLeadsNeedAttention")
                }
                onSelectCustomer={onSelectCustomer}
                onLoadMore={handleLoadMore}
                onRenameStage={handleRenameStage}
                onPatchStage={handlePatchStage}
              />
            ))}
          </SortableContext>
          <PipelineAddList disabled={false} onAdd={handleAddStage} />
        </div>
        <DragOverlay>
          {activeCard ? (
            <PipelineDragOverlayCard
              card={activeCard}
              workspaceId={workspaceId}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
      {(data.archivedStages ?? []).length > 0 ? (
        <div
          data-testid="crm-archived-stages"
          className="flex shrink-0 flex-wrap items-center gap-2 border-t pt-2"
        >
          <span className="text-xs text-muted-foreground">
            {t("pipeline.archived")}
          </span>
          {(data.archivedStages ?? []).map(stage => (
            <Button
              key={stage.key}
              type="button"
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => void handlePatchStage(stage.key, { isActive: true })}
            >
              {columnDisplayName(t, stage)} · {t("pipeline.restoreStage")}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

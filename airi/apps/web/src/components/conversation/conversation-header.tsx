import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getNameInitials } from "@/lib/conversation/display-name";
import {
  AlertTriangle,
  Bot,
  ExternalLink,
  Loader2,
  Megaphone,
  MessageSquareHeart,
  MoreVertical,
  PhoneForwarded,
  RefreshCw,
  StickyNote,
} from "lucide-react";
import { useTranslations } from "next-intl";
import React from "react";
import { toast } from "sonner";

type WhatsAppReferralInfo = {
  sourceType?: string | null;
  sourceId?: string | null;
  sourceUrl?: string | null;
  headline?: string | null;
  body?: string | null;
  ctwaClid?: string | null;
  ref?: string | null;
};

/**
 * WhatsApp identity history for the conversation's chat.
 *
 * Populated by the `system.user_changed_number` webhook handler — when Meta
 * notifies us that a customer's phone number changed, we re-pin the chat to
 * the new `waId` and preserve the old one(s) under `previousWaIds`. The
 * header badge surfaces this so agents know mid-thread why the phone number
 * jumped.
 */
type WhatsAppIdentityInfo = {
  waId?: string | null;
  previousWaIds?: string[] | null;
};

type ConversationHeaderProps = {
  avatarUrl?: string | null;
  conversationId: string;
  mutate: () => Promise<unknown>;
  onCoachToggle?: (enabled: boolean) => void;
  airiBotEnabled?: boolean;
  airiScenariosEnabled?: boolean;
  airiCoachEnabled?: boolean;
  conversationStatus?: string;
  conversationChannel?: string;
  onOpenInfo?: () => void;
  actions?: React.ReactNode;
  renderInfo?: (controls: React.ReactNode) => React.ReactNode;
  conversationTitle: string;
  conversationSubtitle: string;
  handoff?: {
    startedAt: Date | null;
  } | null;
  suppressedTooltipContent?: React.ReactNode;
  whatsappReferral?: WhatsAppReferralInfo | null;
  whatsappIdentity?: WhatsAppIdentityInfo | null;
  quickNote?: string | null;
  onQuickNoteChange?: (note: string | null) => void;
};

type AiriSetting = "bot" | "scenarios" | "coach";

/** The airi PATCH field each header switch writes. */
const AIRI_SETTING_FIELDS: Record<AiriSetting, string> = {
  bot: "bot_enabled",
  scenarios: "scenario_enabled",
  coach: "coach_enabled",
};

type SwitchControlProps = {
  checked: boolean;
  compact?: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
  suppressedTooltipContent?: React.ReactNode;
};

type CsatButtonProps = {
  compact?: boolean;
  disabled: boolean;
  isSending: boolean;
  isSent: boolean;
  onClick: () => void;
};

type QuickNoteButtonProps = {
  active: boolean;
  compact?: boolean;
  label: string;
  onClick: () => void;
};

type HeaderIdentityProps = {
  avatarUrl?: string | null;
  displayName: string;
  displaySubtitle: string;
  handoffAssignedAtLabel: string | null;
  handoffTitle: string;
  showHandoffIndicator: boolean;
  whatsappReferral?: WhatsAppReferralInfo | null;
  whatsappIdentity?: WhatsAppIdentityInfo | null;
};

async function readResponseError(response: Response, fallback: string) {
  const data = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;

  return data?.error || fallback;
}

async function revalidateConversation(mutate: () => Promise<unknown>) {
  try {
    await mutate();
    return true;
  } catch {
    return false;
  }
}

function hasWhatsAppReferral(
  referral: WhatsAppReferralInfo | null | undefined
): referral is WhatsAppReferralInfo {
  if (!referral) return false;
  return Boolean(
    (typeof referral.sourceId === "string" && referral.sourceId.trim()) ||
      (typeof referral.ctwaClid === "string" && referral.ctwaClid.trim()) ||
      (typeof referral.ref === "string" && referral.ref.trim()) ||
      (typeof referral.sourceUrl === "string" && referral.sourceUrl.trim())
  );
}

function WhatsAppReferralBadge({
  referral,
}: {
  referral: WhatsAppReferralInfo;
}) {
  const sourceType =
    typeof referral.sourceType === "string" && referral.sourceType.trim()
      ? referral.sourceType.trim()
      : null;
  const sourceUrl =
    typeof referral.sourceUrl === "string" && referral.sourceUrl.trim()
      ? referral.sourceUrl.trim()
      : null;
  const headline =
    typeof referral.headline === "string" && referral.headline.trim()
      ? referral.headline.trim()
      : null;
  const body =
    typeof referral.body === "string" && referral.body.trim()
      ? referral.body.trim()
      : null;
  const sourceId =
    typeof referral.sourceId === "string" && referral.sourceId.trim()
      ? referral.sourceId.trim()
      : null;

  const label =
    sourceType === "ad"
      ? "From Meta ad"
      : sourceType === "post"
        ? "From Meta post"
        : "From Meta";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex shrink-0 cursor-help items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:border-sky-900/50 dark:bg-sky-950/40 dark:text-sky-300"
        >
          <Megaphone className="h-3 w-3" />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <div className="space-y-1 text-left">
          <p className="font-medium">{label}</p>
          {headline ? <p className="text-xs">{headline}</p> : null}
          {body ? (
            <p className="text-xs opacity-80 line-clamp-3">{body}</p>
          ) : null}
          {sourceId ? (
            <p className="text-[11px] opacity-70">Source ID: {sourceId}</p>
          ) : null}
          {sourceUrl ? (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-sky-600 hover:underline dark:text-sky-300"
            >
              <ExternalLink className="h-3 w-3" />
              Open source
            </a>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function getPreviousWaIds(
  identity: WhatsAppIdentityInfo | null | undefined
): string[] {
  if (!identity || !Array.isArray(identity.previousWaIds)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of identity.previousWaIds) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function formatPhoneForDisplay(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return raw;
  return `+${digits}`;
}

/**
 * Rendered when Meta has re-pinned this WhatsApp chat to a new phone number
 * (via a `system.user_changed_number` webhook). The tooltip lists the
 * previously-seen numbers so agents can make sense of thread history that
 * predates the switch.
 */
function WhatsAppNumberChangedBadge({
  currentWaId,
  previousWaIds,
}: {
  currentWaId: string | null;
  previousWaIds: string[];
}) {
  const historyCount = previousWaIds.length;
  const label =
    historyCount > 1 ? `Number changed (${historyCount})` : "Number changed";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex shrink-0 cursor-help items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300"
        >
          <PhoneForwarded className="h-3 w-3" />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <div className="space-y-1 text-left">
          <p className="font-medium">Customer changed WhatsApp number</p>
          {currentWaId ? (
            <p className="text-xs">
              Current: {formatPhoneForDisplay(currentWaId)}
            </p>
          ) : null}
          {previousWaIds.length > 0 ? (
            <div className="text-[11px] opacity-80">
              <p>Previously:</p>
              <ul className="ml-3 list-disc">
                {previousWaIds.map(waId => (
                  <li key={waId}>{formatPhoneForDisplay(waId)}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function HandoffIndicator({
  assignedAtLabel,
  title,
}: {
  assignedAtLabel: string | null;
  title: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label="Handoff active"
          className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center text-sky-600"
          role="img"
          tabIndex={0}
        >
          <Bot className="h-3.5 w-3.5" />
          <span className="pointer-events-none absolute h-px w-4 rotate-[-32deg] bg-current" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <div className="space-y-0.5 text-left">
          <p className="font-medium">{title}</p>
          {assignedAtLabel ? <p>{assignedAtLabel}</p> : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function HeaderIdentity({
  avatarUrl,
  displayName,
  displaySubtitle,
  handoffAssignedAtLabel,
  handoffTitle,
  showHandoffIndicator,
  whatsappReferral,
  whatsappIdentity,
}: HeaderIdentityProps) {
  const showReferralBadge = hasWhatsAppReferral(whatsappReferral);
  const previousWaIds = getPreviousWaIds(whatsappIdentity);
  const showNumberChangedBadge = previousWaIds.length > 0;

  return (
    <div className="flex items-center gap-2 md:gap-3 flex-1 min-w-0 overflow-hidden">
      <Avatar className="size-8 md:size-9 shrink-0 border">
        <AvatarImage src={avatarUrl || undefined} />
        <AvatarFallback className="text-sm">
          {getNameInitials(displayName)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <p
            title={displayName}
            className="min-w-0 font-semibold text-sm md:text-base truncate leading-tight"
          >
            {displayName}
          </p>
          {showHandoffIndicator ? (
            <HandoffIndicator
              assignedAtLabel={handoffAssignedAtLabel}
              title={handoffTitle}
            />
          ) : null}
          {showReferralBadge && whatsappReferral ? (
            <WhatsAppReferralBadge referral={whatsappReferral} />
          ) : null}
          {showNumberChangedBadge ? (
            <WhatsAppNumberChangedBadge
              currentWaId={whatsappIdentity?.waId ?? null}
              previousWaIds={previousWaIds}
            />
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 md:gap-2 overflow-hidden">
          <p
            title={displaySubtitle}
            className="text-xs md:text-sm text-muted-foreground truncate"
          >
            {displaySubtitle}
          </p>
        </div>
      </div>
    </div>
  );
}

function BotStatusIcon({
  suppressedTooltipContent,
}: Pick<SwitchControlProps, "suppressedTooltipContent">) {
  if (!suppressedTooltipContent) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-help">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        {suppressedTooltipContent}
      </TooltipContent>
    </Tooltip>
  );
}

function SwitchControl({
  checked,
  compact = false,
  label,
  onCheckedChange,
  suppressedTooltipContent,
}: SwitchControlProps) {
  return (
    <div className="flex items-center gap-2">
      <BotStatusIcon suppressedTooltipContent={suppressedTooltipContent} />
      <span
        className={
          compact
            ? "text-[11px] text-muted-foreground"
            : "text-sm text-muted-foreground"
        }
      >
        {label}
      </span>
      <Switch
        aria-label={label}
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

function CsatButton({
  compact = false,
  disabled,
  isSending,
  isSent,
  onClick,
}: CsatButtonProps) {
  const button = (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      className={
        compact
          ? "gap-1.5 text-xs touch-manipulation"
          : "hidden md:inline-flex gap-1.5 text-xs touch-manipulation"
      }
    >
      <MessageSquareHeart
        className={`h-3.5 w-3.5 ${isSending ? "animate-pulse" : ""}`}
      />
      {compact ? (
        isSent ? (
          "Sent"
        ) : (
          "CSAT"
        )
      ) : (
        <span className="hidden lg:inline">
          {isSent ? "CSAT Sent" : "Send CSAT"}
        </span>
      )}
    </Button>
  );

  if (compact) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom">
        {isSent
          ? "CSAT request already sent"
          : "Send CSAT rating request to widget now"}
      </TooltipContent>
    </Tooltip>
  );
}

function QuickNoteButton({
  active,
  compact = false,
  label,
  onClick,
}: QuickNoteButtonProps) {
  const iconClassName = active
    ? "h-3.5 w-3.5 text-amber-600 dark:text-amber-300"
    : "h-3.5 w-3.5 text-muted-foreground";

  if (compact) {
    return (
      <Button
        variant={active ? "secondary" : "outline"}
        size="icon"
        onClick={onClick}
        className="h-8 w-8 touch-manipulation"
        aria-label={label}
        aria-pressed={active}
      >
        <StickyNote className={iconClassName} />
      </Button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={active ? "secondary" : "ghost"}
          size="icon"
          onClick={onClick}
          className="h-8 w-8 shrink-0"
          aria-label={label}
          aria-pressed={active}
        >
          <StickyNote className={iconClassName} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function ConversationHeader({
  avatarUrl,
  conversationId,
  mutate,
  onCoachToggle,
  airiBotEnabled = false,
  airiScenariosEnabled = airiBotEnabled,
  airiCoachEnabled = true,
  conversationStatus,
  conversationChannel,
  onOpenInfo,
  actions,
  renderInfo,
  conversationTitle,
  conversationSubtitle,
  handoff = null,
  suppressedTooltipContent,
  whatsappReferral = null,
  whatsappIdentity = null,
  quickNote = null,
  onQuickNoteChange,
}: ConversationHeaderProps) {
  const t = useTranslations("ConversationDetailView");
  // Optimistic switch values until the revalidated conversation catches up.
  const [airiOverrides, setAiriOverrides] = React.useState<
    Partial<Record<AiriSetting, boolean>>
  >({});
  const [reopening, setReopening] = React.useState(false);
  const [csatSending, setCsatSending] = React.useState(false);
  const [csatSent, setCsatSent] = React.useState(false);
  const [quickNoteOpen, setQuickNoteOpen] = React.useState(false);
  const [quickNoteDraft, setQuickNoteDraft] = React.useState(quickNote || "");
  const [quickNoteSaving, setQuickNoteSaving] = React.useState(false);

  const airiValues: Record<AiriSetting, boolean> = {
    bot: airiOverrides.bot ?? airiBotEnabled,
    scenarios: airiOverrides.scenarios ?? airiScenariosEnabled,
    coach: airiOverrides.coach ?? airiCoachEnabled,
  };
  const handoffStartedAtLabel = handoff?.startedAt?.toLocaleString();
  const handoffAssignedAtLabel = handoffStartedAtLabel
    ? t("handoffBannerAssignedAt", { time: handoffStartedAtLabel })
    : null;
  const isClosed = conversationStatus === "closed";
  const canSendCsat =
    conversationChannel === "web_widget" && conversationStatus !== "closed";
  const hasQuickNote = Boolean(quickNote?.trim());

  function openQuickNoteDialog() {
    setQuickNoteDraft(quickNote || "");
    setQuickNoteOpen(true);
  }

  function handleQuickNoteOpenChange(open: boolean) {
    setQuickNoteOpen(open);
    if (!open) {
      setQuickNoteDraft(quickNote || "");
    }
  }

  function setAiriOverride(setting: AiriSetting, value: boolean | undefined) {
    setAiriOverrides(current => ({ ...current, [setting]: value }));
  }

  async function patchAiriSetting(setting: AiriSetting, checked: boolean) {
    const automation = t("automationLabel");
    const toasts = {
      bot: {
        enabled: t("toasts.botEnabled"),
        disabled: t("toasts.botDisabled"),
        failed: t("toasts.failedToToggleAiriBot"),
      },
      scenarios: {
        enabled: `${automation} ${t("enabled")}`,
        disabled: `${automation} ${t("disabled")}`,
        failed: `${automation} ${t("failed")}`,
      },
      coach: {
        enabled: t("toasts.coachEnabled"),
        disabled: t("toasts.coachDisabled"),
        failed: t("toasts.failedToToggleAiriCoach"),
      },
    }[setting];
    const previousOverride = airiOverrides[setting];
    const previousValue = airiValues[setting];
    setAiriOverride(setting, checked);
    if (setting === "coach") onCoachToggle?.(checked);

    try {
      const response = await fetch(
        `/api/conversations/${conversationId}/airi`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [AIRI_SETTING_FIELDS[setting]]: checked }),
        }
      );

      if (!response.ok) {
        throw new Error(await readResponseError(response, ""));
      }

      toast.success(checked ? toasts.enabled : toasts.disabled);
      if (await revalidateConversation(mutate)) {
        setAiriOverride(setting, undefined);
      }
    } catch (error) {
      setAiriOverride(setting, previousOverride);
      if (setting === "coach") onCoachToggle?.(previousValue);
      const detail = (error as Error).message;
      toast.error(detail ? `${toasts.failed}: ${detail}` : toasts.failed);
    }
  }

  async function handleReopen() {
    setReopening(true);

    try {
      const response = await fetch(
        `/api/conversations/${conversationId}/reopen`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }
      );

      if (!response.ok) {
        throw new Error(
          await readResponseError(response, t("toasts.failedToReopen"))
        );
      }

      toast.success(t("toasts.reopened"));
      await mutate();
    } catch (error) {
      toast.error(`${t("toasts.failedToReopen")}: ${(error as Error).message}`);
    } finally {
      setReopening(false);
    }
  }

  async function handleSendCsat() {
    if (csatSending || csatSent) {
      return;
    }

    setCsatSending(true);

    try {
      const response = await fetch(
        `/api/conversations/${conversationId}/send-widget-csat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }
      );

      if (!response.ok) {
        throw new Error(
          await readResponseError(response, "Failed to send CSAT")
        );
      }

      setCsatSent(true);
      toast.success("CSAT request sent to widget");
    } catch (error) {
      toast.error(`Failed to send CSAT: ${(error as Error).message}`);
    } finally {
      setCsatSending(false);
    }
  }

  async function saveQuickNote(nextNoteRaw: string | null) {
    if (quickNoteSaving) return;

    const normalizedNote =
      nextNoteRaw === null ? null : nextNoteRaw.trim().slice(0, 1000) || null;
    setQuickNoteSaving(true);

    try {
      const response = await fetch(
        `/api/conversations/${conversationId}/quick-note`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: normalizedNote }),
        }
      );

      if (!response.ok) {
        throw new Error(
          await readResponseError(response, t("toasts.failedToSaveQuickNote"))
        );
      }

      const payload = (await response.json().catch(() => null)) as {
        note?: string | null;
      } | null;
      const savedNote =
        payload && Object.prototype.hasOwnProperty.call(payload, "note")
          ? (payload.note ?? null)
          : normalizedNote;

      onQuickNoteChange?.(savedNote);
      setQuickNoteDraft(savedNote || "");
      setQuickNoteOpen(false);
      toast.success(
        savedNote ? t("toasts.quickNoteSaved") : t("toasts.quickNoteCleared")
      );
      await mutate();
    } catch (error) {
      toast.error(
        `${t("toasts.failedToSaveQuickNote")}: ${(error as Error).message}`
      );
    } finally {
      setQuickNoteSaving(false);
    }
  }

  const switchControls = (compact: boolean) => (
    <>
      <SwitchControl
        compact={compact}
        checked={airiValues.bot}
        label={t("bot")}
        onCheckedChange={checked => void patchAiriSetting("bot", checked)}
        suppressedTooltipContent={suppressedTooltipContent}
      />
      <SwitchControl
        compact={compact}
        checked={airiValues.scenarios}
        label={t("automationLabel")}
        onCheckedChange={checked => void patchAiriSetting("scenarios", checked)}
      />
      <SwitchControl
        compact={compact}
        checked={airiValues.coach}
        label={t("coach")}
        onCheckedChange={checked => void patchAiriSetting("coach", checked)}
      />
    </>
  );

  return (
    <>
      <div className="@container/conversation-header min-w-0">
        <div className="flex min-w-0 items-center justify-between gap-1 md:gap-2">
          <HeaderIdentity
            avatarUrl={avatarUrl}
            displayName={conversationTitle}
            displaySubtitle={conversationSubtitle}
            handoffAssignedAtLabel={handoffAssignedAtLabel}
            handoffTitle={t("handoffBannerTitle")}
            showHandoffIndicator={Boolean(handoff) && !airiValues.bot}
            whatsappReferral={whatsappReferral}
            whatsappIdentity={whatsappIdentity}
          />
          <div
            className="flex shrink-0 items-center gap-0.5 md:gap-1"
            suppressHydrationWarning
          >
            {isClosed ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleReopen}
                disabled={reopening}
                className="gap-1.5 text-xs touch-manipulation hidden @min-[40rem]/conversation-header:inline-flex"
                aria-label={t("reopen")}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 md:h-4 md:w-4 ${reopening ? "animate-spin" : ""}`}
                />
                <span className="hidden lg:inline">{t("reopen")}</span>
              </Button>
            ) : null}

            <div className="hidden @min-[40rem]/conversation-header:flex items-center gap-0.5 md:gap-1">
              {switchControls(false)}
            </div>

            <div className="hidden @min-[40rem]/conversation-header:flex items-center gap-1">
              {canSendCsat ? (
                <CsatButton
                  disabled={csatSending || csatSent}
                  isSending={csatSending}
                  isSent={csatSent}
                  onClick={handleSendCsat}
                />
              ) : null}

              <QuickNoteButton
                active={hasQuickNote}
                label={t("quickNote")}
                onClick={openQuickNoteDialog}
              />
            </div>

            {actions}

            {onOpenInfo ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={onOpenInfo}
                className="size-[44px] md:size-8 shrink-0"
                aria-label={t("showInfo")}
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {renderInfo?.(
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2 [&>div]:relative [&>div]:min-w-0 [&>div]:flex-col [&>div]:gap-2 [&>div]:rounded-lg [&>div]:bg-muted/50 [&>div]:px-1 [&>div]:py-2 [&>div>span[data-state]]:absolute [&>div>span[data-state]]:right-1 [&>div>span[data-state]]:top-1">
            {switchControls(true)}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openQuickNoteDialog}
              className="min-h-10 gap-2"
            >
              <StickyNote className="size-4" aria-hidden />
              {t("quickNote")}
            </Button>
            {isClosed && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={reopening}
                onClick={handleReopen}
                className="min-h-10 gap-2"
              >
                <RefreshCw className="size-4" aria-hidden />
                {t("reopen")}
              </Button>
            )}
            {canSendCsat ? (
              <CsatButton
                compact
                disabled={csatSending || csatSent}
                isSending={csatSending}
                isSent={csatSent}
                onClick={handleSendCsat}
              />
            ) : null}
          </div>
        </div>
      )}

      <Dialog open={quickNoteOpen} onOpenChange={handleQuickNoteOpenChange}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("quickNoteTitle")}</DialogTitle>
            <DialogDescription>{t("quickNoteDescription")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Textarea
              aria-label={t("quickNoteTextarea")}
              value={quickNoteDraft}
              onChange={event => setQuickNoteDraft(event.currentTarget.value)}
              maxLength={1000}
              rows={5}
              className="resize-none"
            />
            <p className="text-right text-xs text-muted-foreground">
              {quickNoteDraft.trim().length}/1000
            </p>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => void saveQuickNote(null)}
              disabled={quickNoteSaving}
            >
              {t("clearQuickNote")}
            </Button>
            <Button
              onClick={() => void saveQuickNote(quickNoteDraft)}
              disabled={quickNoteSaving}
            >
              {quickNoteSaving ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t("saveQuickNote")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

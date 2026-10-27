"use client";

import { ScenarioInlineNotice } from "@/components/scenarios/scenario-inline-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { normalizeEditableTemplateFlowId } from "@/lib/scenarios/whatsapp-template-flow";
import { cn } from "@/lib/utils";
import { Loader2, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, type SyntheticEvent } from "react";
import type { EditableWhatsAppTemplateButton } from "./template-editor-utils";
import {
  getTemplateButtonScreens,
  resolveTemplateFlowScreenChoice,
  templateButtonNeedsFirstScreen,
  type TemplateFlowScreenLookup,
  type TemplateFlowScreens,
} from "./template-flow-screens";

const CARD_CONTROL_CLASS = "nodrag nopan nokey";
const FIELD_CLASS =
  "h-8 w-full min-w-0 flex-1 border-zinc-300/80 bg-white px-2 text-[11px] shadow-none dark:border-zinc-700 dark:bg-zinc-950";
// The notice palette, so a screen the form lost reads as a warning even when
// the trigger cuts its label short.
const MISSING_SCREEN_CLASS =
  "border-amber-300/70 text-amber-800 dark:border-amber-500/30 dark:text-amber-300";

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

type FirstScreenControlProps = {
  id: string;
  value: string;
  /** The row's error line, while it shows this field's error. */
  errorId?: string;
  onChange: (screenId: string) => void;
};

/**
 * The screen a form button opens its form on. It lists the form's screens
 * when WhatsApp returns them, and takes a typed screen id otherwise.
 */
export function WhatsAppTemplateFlowFirstScreenField({
  button,
  lookup,
  errorId,
  onChange,
}: {
  button: EditableWhatsAppTemplateButton;
  lookup?: TemplateFlowScreenLookup;
  errorId?: string;
  onChange: (screenId: string) => void;
}) {
  const t = useTranslations("Scenarios");
  const id = useId();
  if (!templateButtonNeedsFirstScreen(button)) return null;

  const screens = getTemplateButtonScreens(button, lookup);
  const flowId = normalizeEditableTemplateFlowId(button.flowId);
  const failedId = `${id}-failed`;
  const control = { id, value: button.navigateScreen ?? "", errorId, onChange };
  return (
    <div
      data-testid="template-flow-first-screen"
      className="flex w-full min-w-0 flex-col gap-1"
    >
      <Label
        htmlFor={id}
        className="text-[10px] font-medium leading-snug text-muted-foreground"
      >
        {t("whatsappTemplateFirstScreen")}
      </Label>
      <div className="flex h-8 w-full min-w-0 items-center gap-1">
        {screens.status === "loading" || screens.status === "ready" ? (
          <FirstScreenSelect {...control} screens={screens} />
        ) : (
          <FirstScreenInput
            {...control}
            noticeId={screens.status === "failed" ? failedId : undefined}
          />
        )}
        {lookup && screens.status !== "manual" ? (
          <FirstScreenReloadButton
            busy={screens.status === "loading" || lookup.isRefreshing(flowId)}
            onReload={() => lookup.refresh(flowId)}
          />
        ) : null}
      </div>
      {screens.status === "failed" ? (
        // Describes the typed input, so screen readers hear why it's there.
        <div id={failedId}>
          <ScenarioInlineNotice data-testid="template-flow-first-screen-failed">
            {t("whatsappTemplateFirstScreenLoadFailed")}
          </ScenarioInlineNotice>
        </div>
      ) : null}
    </div>
  );
}

function FirstScreenSelect({
  id,
  value,
  errorId,
  onChange,
  screens,
}: FirstScreenControlProps & {
  screens: Extract<TemplateFlowScreens, { status: "loading" | "ready" }>;
}) {
  const t = useTranslations("Scenarios");
  // A saved screen the form lost stays visible instead of a blank picker.
  const { screenIds, unlisted, missing } = resolveTemplateFlowScreenChoice(
    value,
    screens
  );
  const unlistedLabel = missing
    ? t("whatsappTemplateFirstScreenMissing", { screen: unlisted })
    : unlisted;
  return (
    <Select
      value={value}
      disabled={screens.status !== "ready"}
      onValueChange={next => {
        // Form resets can send an empty native change; it is not a choice.
        if (next) onChange(next);
      }}
    >
      <SelectTrigger
        id={id}
        // Long ids truncate; the full text stays one hover away.
        title={unlistedLabel || value || undefined}
        data-missing-screen={missing ? "" : undefined}
        aria-invalid={Boolean(errorId)}
        aria-describedby={errorId}
        className={cn(
          CARD_CONTROL_CLASS,
          FIELD_CLASS,
          "text-left",
          missing && MISSING_SCREEN_CLASS
        )}
        onKeyDown={stopPropagation}
      >
        <SelectValue
          placeholder={t("whatsappTemplateFirstScreenPlaceholder")}
        />
      </SelectTrigger>
      <SelectContent
        className="max-w-[min(20rem,calc(100vw-2rem))]"
        position="popper"
      >
        {unlisted ? (
          <SelectItem value={unlisted} title={unlistedLabel} disabled>
            <span className="truncate">{unlistedLabel}</span>
          </SelectItem>
        ) : null}
        {screenIds.map(screenId => (
          <SelectItem key={screenId} value={screenId} title={screenId}>
            <span className="truncate">{screenId}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function FirstScreenInput({
  id,
  value,
  errorId,
  noticeId,
  onChange,
}: FirstScreenControlProps & {
  /** The line saying the screens couldn't be read. */
  noticeId?: string;
}) {
  const t = useTranslations("Scenarios");
  const describedBy = [noticeId, errorId].filter(Boolean).join(" ");
  return (
    <Input
      id={id}
      value={value}
      aria-invalid={Boolean(errorId)}
      aria-describedby={describedBy || undefined}
      placeholder={t("whatsappTemplateFirstScreenExample")}
      onChange={event => onChange(event.target.value)}
      onKeyDown={stopPropagation}
      className={cn(CARD_CONTROL_CLASS, FIELD_CLASS)}
    />
  );
}

function FirstScreenReloadButton({
  busy,
  onReload,
}: {
  busy: boolean;
  onReload: () => void;
}) {
  const t = useTranslations("Scenarios");
  const label = busy
    ? t("whatsappTemplateFirstScreenLoading")
    : t("whatsappTemplateFirstScreenReload");
  const Icon = busy ? Loader2 : RefreshCw;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            CARD_CONTROL_CLASS,
            "h-8 w-8 shrink-0 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800",
            busy && "cursor-wait opacity-70"
          )}
          // aria-disabled instead of disabled keeps keyboard focus on the
          // button, as the form health notice's "Check again" does.
          aria-disabled={busy}
          aria-busy={busy}
          aria-label={label}
          onPointerDown={stopPropagation}
          onClick={event => {
            event.stopPropagation();
            if (!busy) onReload();
          }}
        >
          <Icon
            className={cn("h-3.5 w-3.5", busy && "animate-spin")}
            aria-hidden
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

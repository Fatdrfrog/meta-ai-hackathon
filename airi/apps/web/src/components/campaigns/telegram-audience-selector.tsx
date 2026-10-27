"use client";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE } from "@icecore/scenario-contracts";

export const TELEGRAM_AUDIENCE_RATE_HINT = "Free ~30/s. Paid 1000/s off.";

export type TelegramAudienceMode =
  | "manual"
  | typeof SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE;

export type TelegramAudienceSelectorSource = {
  id: string;
  name?: string | null;
  credentials?: {
    bot_username?: string | null;
  } | null;
};

function formatSourceLabel(source: TelegramAudienceSelectorSource): string {
  return source.credentials?.bot_username
    ? `@${source.credentials.bot_username}`
    : source.name || source.id;
}

export function TelegramAudienceSelector({
  audienceMode,
  className,
  disabled = false,
  isLoadingSources = false,
  isLoadingSubscribers = false,
  knownLabel = "Known",
  loadingText = "Loading...",
  manualLabel = "Manual",
  onAudienceModeChange,
  onSourceChange,
  rateHint = TELEGRAM_AUDIENCE_RATE_HINT,
  selectedSourceId,
  selectorClassName,
  showAudienceModes = true,
  sourceSelectLabel = "Bot",
  sourceSelectPlaceholder = "Select bot",
  sources,
  subscriberCount,
  subscriberCountText,
}: {
  audienceMode: TelegramAudienceMode;
  className?: string;
  disabled?: boolean;
  isLoadingSources?: boolean;
  isLoadingSubscribers?: boolean;
  knownLabel?: string;
  loadingText?: string;
  manualLabel?: string;
  onAudienceModeChange: (mode: TelegramAudienceMode) => void;
  onSourceChange: (sourceId: string) => void;
  rateHint?: string;
  selectedSourceId: string;
  selectorClassName?: string;
  showAudienceModes?: boolean;
  sourceSelectLabel?: string;
  sourceSelectPlaceholder?: string;
  sources: TelegramAudienceSelectorSource[];
  subscriberCount: number;
  subscriberCountText?: string;
}) {
  const hasKnownAudience = Boolean(selectedSourceId && subscriberCount > 0);
  const resolvedSubscriberCountText =
    subscriberCountText || `${subscriberCount.toLocaleString()} known`;

  return (
    <div
      className={cn("space-y-3 rounded-md border bg-muted/10 p-3", className)}
    >
      {showAudienceModes ? (
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            type="button"
            size="sm"
            variant={audienceMode === "manual" ? "default" : "outline"}
            className="h-auto min-h-8 justify-start px-2 py-1 text-left text-xs whitespace-normal"
            disabled={disabled}
            onClick={() => onAudienceModeChange("manual")}
          >
            {manualLabel}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={
              audienceMode ===
              SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE
                ? "default"
                : "outline"
            }
            className="h-auto min-h-8 justify-start px-2 py-1 text-left text-xs whitespace-normal"
            disabled={
              disabled ||
              isLoadingSources ||
              isLoadingSubscribers ||
              !hasKnownAudience
            }
            onClick={() =>
              onAudienceModeChange(
                SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE
              )
            }
          >
            {knownLabel}
          </Button>
        </div>
      ) : null}
      <div className="space-y-1">
        <Label className="text-[10px] uppercase text-muted-foreground">
          {sourceSelectLabel}
        </Label>
        <Select
          value={selectedSourceId}
          onValueChange={onSourceChange}
          disabled={disabled || isLoadingSources || sources.length <= 1}
        >
          <SelectTrigger className={cn("h-8 text-xs", selectorClassName)}>
            <SelectValue placeholder={sourceSelectPlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {sources.map(source => (
              <SelectItem key={source.id} value={source.id}>
                {formatSourceLabel(source)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="text-[11px] text-muted-foreground">
          {isLoadingSubscribers ? loadingText : resolvedSubscriberCountText}
        </div>
        <div className="text-[10px] text-muted-foreground">{rateHint}</div>
      </div>
    </div>
  );
}

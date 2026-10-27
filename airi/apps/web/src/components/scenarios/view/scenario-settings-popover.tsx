"use client";

import {
  DEFAULT_SCENARIO_ENTRY_POLICY,
  type ScenarioEntryPolicy,
  type ScenarioRoutingSettingsPatch,
  type ScenarioSummary,
} from "@/components/scenarios/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { Loader2, Settings2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";

type ScenarioSettingsPopoverProps = {
  scenario: ScenarioSummary;
  disabled?: boolean;
  triggerClassName?: string;
  onSettingsChange: (
    scenarioId: string,
    patch: ScenarioRoutingSettingsPatch
  ) => Promise<boolean> | boolean;
};

export function ScenarioSettingsPopover({
  scenario,
  disabled = false,
  triggerClassName,
  onSettingsChange,
}: ScenarioSettingsPopoverProps) {
  const t = useTranslations("Scenarios");
  const isMobile = useIsMobile();
  const entryPolicy = scenario.entryPolicy ?? DEFAULT_SCENARIO_ENTRY_POLICY;
  const [pendingSaveCount, setPendingSaveCount] = useState(0);
  const isSaving = pendingSaveCount > 0;
  const controlsDisabled = disabled || isSaving;
  const settingsLabel = t("scenarioSettingsFor", {
    name: scenario.name,
  });

  const persistSettingsPatch = useCallback(
    async (patch: ScenarioRoutingSettingsPatch): Promise<boolean> => {
      setPendingSaveCount(current => current + 1);
      try {
        return await Promise.resolve(onSettingsChange(scenario._id, patch));
      } catch {
        return false;
      } finally {
        setPendingSaveCount(current => Math.max(0, current - 1));
      }
    },
    [onSettingsChange, scenario._id]
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={controlsDisabled}
          className={cn("h-7 w-7 rounded-md", triggerClassName)}
          aria-label={settingsLabel}
          aria-busy={isSaving}
          title={settingsLabel}
          onClick={event => {
            event.stopPropagation();
          }}
        >
          {isSaving ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Settings2 className="h-3 w-3" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side={isMobile ? "bottom" : "right"}
        align={isMobile ? "end" : "start"}
        className="w-72 max-w-[calc(100vw-1rem)] space-y-4 p-3"
        aria-label={settingsLabel}
        aria-busy={isSaving}
      >
        <div className="space-y-1">
          <p className="text-sm font-semibold">{settingsLabel}</p>
          <p className="text-xs text-muted-foreground">
            {t("scenarioSettingsHint")}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`scenario-entry-policy-${scenario._id}`}>
            {t("scenarioEntryPolicy")}
          </Label>
          <Select
            value={entryPolicy}
            disabled={controlsDisabled}
            onValueChange={value => {
              void persistSettingsPatch({
                entryPolicy: value as ScenarioEntryPolicy,
              });
            }}
          >
            <SelectTrigger
              id={`scenario-entry-policy-${scenario._id}`}
              className="h-8 w-full"
              aria-label={t("scenarioEntryPolicy")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="once_per_conversation">
                {t("scenarioEntryOncePerConversation")}
              </SelectItem>
              <SelectItem value="repeatable">
                {t("scenarioEntryRepeatable")}
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs leading-4 text-muted-foreground">
            {t("scenarioEntryPolicyHint")}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

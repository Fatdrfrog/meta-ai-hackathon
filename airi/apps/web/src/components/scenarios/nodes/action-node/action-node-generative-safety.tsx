"use client";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MAX_GENERATIVE_AI_DAILY_LIMIT,
  type GenerativeAISafetyConfig,
} from "@icecore/scenario-contracts";
import { cn } from "@/lib/utils";
import { useId } from "react";
import { ScenarioCheckboxField } from "../../scenario-checkbox-field";
import { ScenarioCollapsibleSection } from "../../scenario-collapsible-section";
import { ScenarioInfoHint } from "../../scenario-info-hint";
import type { TranslateFn } from "../../types";

const DAILY_LIMIT_CHOICES = [1, 2, 3, 5, 10, MAX_GENERATIVE_AI_DAILY_LIMIT];
const NO_LIMIT = "none";

/** What a customer can make this node generate, and how often. */
export function ActionNodeGenerativeSafety({
  safety,
  onChange,
  t,
  className,
  contentClassName,
}: {
  safety: GenerativeAISafetyConfig;
  onChange: (safety: GenerativeAISafetyConfig) => void;
  t: TranslateFn;
  className?: string;
  /** Pads the fields to line up with the section header. */
  contentClassName?: string;
}) {
  const limitId = useId();
  const limitHintId = `${limitId}-hint`;
  // A limit saved outside these choices stays selectable.
  const limits = [
    ...new Set([
      ...DAILY_LIMIT_CHOICES,
      ...(safety.dailyLimit === null ? [] : [safety.dailyLimit]),
    ]),
  ].sort((left, right) => left - right);
  const screenLabel = t("generativeAIScreenCustomerText");
  const limitLabel = t("generativeAIDailyLimit");

  return (
    <ScenarioCollapsibleSection
      title={t("generativeAISafetyTitle")}
      summary={t("generativeAISafetySummary", {
        screen: safety.screenCustomerText ? "on" : "off",
        limit:
          safety.dailyLimit === null ? NO_LIMIT : String(safety.dailyLimit),
      })}
      className={className}
      data-testid="generative-ai-safety"
    >
      <div className={cn("space-y-2", contentClassName)}>
        <ScenarioCheckboxField
          label={screenLabel}
          hint={t("generativeAIScreenCustomerTextHint")}
          hintMode="info"
          hintLabel={t("infoHintLabel", { topic: screenLabel })}
          checked={safety.screenCustomerText}
          onCheckedChange={screenCustomerText =>
            onChange({ ...safety, screenCustomerText })
          }
        />
        <div className="space-y-1">
          <div className="flex items-center gap-0.5">
            <Label htmlFor={limitId} className="text-[11px] font-medium">
              {limitLabel}
            </Label>
            <ScenarioInfoHint
              label={t("infoHintLabel", { topic: limitLabel })}
              describedById={limitHintId}
            >
              {t("generativeAIDailyLimitHint")}
            </ScenarioInfoHint>
          </div>
          <Select
            value={
              safety.dailyLimit === null ? NO_LIMIT : String(safety.dailyLimit)
            }
            onValueChange={value =>
              onChange({
                ...safety,
                dailyLimit: value === NO_LIMIT ? null : Number(value),
              })
            }
          >
            <SelectTrigger
              id={limitId}
              aria-describedby={limitHintId}
              className="nodrag nopan nokey w-full bg-background text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {limits.map(limit => {
                const label = t("generativeAIDailyLimitOption", {
                  count: limit,
                });
                return (
                  <SelectItem
                    key={limit}
                    value={String(limit)}
                    textValue={label}
                  >
                    {label}
                  </SelectItem>
                );
              })}
              <SelectItem value={NO_LIMIT}>
                {t("generativeAIDailyLimitNone")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </ScenarioCollapsibleSection>
  );
}

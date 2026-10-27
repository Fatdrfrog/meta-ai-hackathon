"use client";

import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useId } from "react";
import {
  readScenarioPromptInputBehavior,
  SCENARIO_PROMPT_INPUT_WAIT_HOURS,
  type ScenarioPromptInputAsk,
  type ScenarioPromptInputBehavior,
  type ScenarioPromptInputWaitHours,
} from "@icecore/scenario-contracts";
import { ScenarioCheckboxField } from "../../../scenario-checkbox-field";
import { ScenarioCollapsibleSection } from "../../../scenario-collapsible-section";
import { ScenarioInfoHint } from "../../../scenario-info-hint";
import type { TranslateFn } from "../../../types";

const WAIT_MESSAGE_KEYS: Record<ScenarioPromptInputWaitHours, string> = {
  1: "whatsappServicePromptInputsWaitHour",
  24: "whatsappServicePromptInputsWaitDay",
  168: "whatsappServicePromptInputsWaitWeek",
};

/**
 * How long the ask waits and, after a tap, how it reads a typed reply. The
 * section starts closed; its summary keeps the paid reminder visible.
 */
export function ServiceMessagePromptInputReplyRules({
  ask,
  behavior,
  t,
  onBehaviorChange,
}: {
  ask: ScenarioPromptInputAsk;
  /** The defaults apply to rules it omits. */
  behavior: ScenarioPromptInputBehavior | undefined;
  t: TranslateFn;
  onBehaviorChange: (behavior: ScenarioPromptInputBehavior) => void;
}) {
  const waitLabelId = useId();
  const replyRules = readScenarioPromptInputBehavior({
    promptInputBehavior: behavior,
  });
  const changeBehavior = (patch: ScenarioPromptInputBehavior) =>
    onBehaviorChange({ ...behavior, ...patch });
  const nudgeOn = ask === "choice" && replyRules.nudgeOnce;
  const waitLabel = t("whatsappServicePromptInputsWait");
  const nudgeLabel = t("whatsappServicePromptInputsNudge");

  return (
    <ScenarioCollapsibleSection
      title={t("whatsappServicePromptInputsReplyRules")}
      summary={t("whatsappServicePromptInputsReplyRulesSummary", {
        wait: t(WAIT_MESSAGE_KEYS[replyRules.waitHours]),
        nudge: nudgeOn ? "on" : "off",
      })}
      className="-mx-2 -mb-2 rounded-b-md"
      data-testid="whatsapp-service-prompt-input-settings"
    >
      <div className="space-y-2 px-3 pb-2.5 pt-0.5">
        <div className="grid gap-1 text-[11px]">
          <div className="flex min-w-0 items-center gap-0.5">
            <span id={waitLabelId}>{waitLabel}</span>
            <ScenarioInfoHint
              label={t("infoHintLabel", { topic: waitLabel })}
              className="-my-1"
            >
              {t("whatsappServicePromptInputsWaitHint")}
            </ScenarioInfoHint>
          </div>
          <Select
            value={String(replyRules.waitHours)}
            onValueChange={value => {
              const waitHours = SCENARIO_PROMPT_INPUT_WAIT_HOURS.find(
                hours => String(hours) === value
              );
              if (waitHours) changeBehavior({ waitHours });
            }}
          >
            <SelectTrigger
              size="sm"
              aria-labelledby={waitLabelId}
              className="nodrag w-full min-w-0 bg-background text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCENARIO_PROMPT_INPUT_WAIT_HOURS.map(hours => (
                <SelectItem key={hours} value={String(hours)}>
                  {t(WAIT_MESSAGE_KEYS[hours])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {ask === "choice" ? (
          <div className="space-y-1.5">
            <ScenarioCheckboxField
              label={t("whatsappServicePromptInputsTypedChoice")}
              hint={t("whatsappServicePromptInputsTypedChoiceHint")}
              hintMode="info"
              hintLabel={t("infoHintLabel", {
                topic: t("whatsappServicePromptInputsTypedChoice"),
              })}
              labelClassName="text-[11px] leading-5"
              checked={replyRules.typedChoice}
              onCheckedChange={typedChoice => changeBehavior({ typedChoice })}
            />
            <div className="flex flex-wrap items-start gap-x-1.5 gap-y-0.5">
              <ScenarioCheckboxField
                label={nudgeLabel}
                hint={t("whatsappServicePromptInputsNudgeHint")}
                hintMode="info"
                hintLabel={t("infoHintLabel", { topic: nudgeLabel })}
                labelClassName="text-[11px] leading-5"
                checked={replyRules.nudgeOnce}
                onCheckedChange={nudgeOnce => changeBehavior({ nudgeOnce })}
              />
              <Badge
                variant="outline"
                className="mt-0.5 h-5 border-amber-300 px-1.5 text-[10px] font-normal text-amber-800 dark:border-amber-500/40 dark:text-amber-300"
              >
                {t("whatsappServiceExtraCost")}
              </Badge>
            </div>
          </div>
        ) : null}
      </div>
    </ScenarioCollapsibleSection>
  );
}

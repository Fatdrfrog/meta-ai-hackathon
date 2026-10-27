"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { projectActiveClientMessageFilters } from "@/lib/scenarios/client-message-trigger-criteria";
import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import type { KeyboardEventHandler } from "react";
import type {
  ScenarioNodeData,
  ScenarioUiLinkedScenarioOption,
} from "../types";
import { buildClientMessageTriggerPresentation } from "../view/client-message-trigger-presentation";
import type { ScenarioLinkEditorNodeData } from "../view/node-enrichment/types";
import { buildScenarioTriggerSummaryChips } from "../view/scenario-builder-summary-labels";
import { NONE_OPTION_VALUE } from "./utils";

type Translate = (
  key: string,
  values?: Record<string, string | number | Date>
) => string;

export function resolveLinkedScenarioTriggerSummary(
  scenario: ScenarioUiLinkedScenarioOption | undefined,
  t: Translate
): string | null {
  if (!scenario) return null;
  const triggerSummaries = Array.isArray(scenario.triggers)
    ? scenario.triggers
    : [];
  if (triggerSummaries.length > 1) {
    return t("scenarioTriggerCount", { count: triggerSummaries.length });
  }
  const primaryTriggerSummary = triggerSummaries[0];
  const triggerConfig = primaryTriggerSummary?.triggerConfig;
  if (!triggerConfig) return null;
  if (triggerConfig.entryPointType === "business_event") {
    return buildScenarioTriggerSummaryChips(triggerConfig, t).join(" · ");
  }
  const criteria = projectActiveClientMessageFilters(triggerConfig);
  return buildClientMessageTriggerPresentation(criteria, t).linkedSummary;
}

/** The persisted link for a Select value; the saved name is a snapshot. */
export function buildScenarioLinkSelectionPatch(
  value: string,
  options: readonly ScenarioUiLinkedScenarioOption[]
): Partial<ScenarioNodeData> {
  if (value === NONE_OPTION_VALUE) {
    return { linkedScenarioId: undefined, linkedScenarioName: undefined };
  }
  const option = options.find(candidate => candidate.id === value);
  return {
    linkedScenarioId: value,
    linkedScenarioName: option?.name ?? value,
  };
}

/** Linked-scenario picker shared by the inline card and the settings panel. */
export function ScenarioLinkSelect({
  data,
  id,
  triggerClassName,
  onTriggerKeyDown,
  keepMissingSelection = false,
}: {
  data: ScenarioLinkEditorNodeData;
  id?: string;
  triggerClassName?: string;
  onTriggerKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  /** Show a saved scenario that is no longer offered instead of a blank value. */
  keepMissingSelection?: boolean;
}) {
  const t = useTranslations("Scenarios");
  const linkedScenarioId = data.linkedScenarioId || "";
  const scenarioOptions = data.uiScenarioOptions ?? [];
  const onPatch = data.uiOnPatch;
  const missingSelection =
    keepMissingSelection &&
    Boolean(linkedScenarioId) &&
    !scenarioOptions.some(option => option.id === linkedScenarioId);

  return (
    <Select
      value={linkedScenarioId || NONE_OPTION_VALUE}
      onValueChange={value => {
        if (!onPatch) return;
        onPatch(buildScenarioLinkSelectionPatch(value, scenarioOptions));
      }}
    >
      <SelectTrigger
        id={id}
        className={triggerClassName}
        onKeyDown={onTriggerKeyDown}
      >
        <SelectValue placeholder={t("scenarioLinkSelectPlaceholder")} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE_OPTION_VALUE}>
          {t("scenarioLinkNone")}
        </SelectItem>
        {missingSelection ? (
          <SelectItem value={linkedScenarioId}>
            {t("scenarioLinkMissing", {
              name: data.linkedScenarioName || linkedScenarioId,
            })}
          </SelectItem>
        ) : null}
        {scenarioOptions.map(option => (
          <SelectItem key={option.id} value={option.id}>
            {option.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Settings panel body for a sub-scenario link. */
export function LinkNodeSettings({
  nodeId,
  data,
}: {
  nodeId: string;
  data: ScenarioLinkEditorNodeData;
}) {
  const t = useTranslations("Scenarios");
  const linkedScenarioId = data.linkedScenarioId || "";
  const scenarioOptions = data.uiScenarioOptions ?? [];
  const selectedScenario = scenarioOptions.find(
    option => option.id === linkedScenarioId
  );
  const missingSelection = Boolean(linkedScenarioId) && !selectedScenario;
  const triggerSummary = resolveLinkedScenarioTriggerSummary(
    selectedScenario,
    t
  );
  const selectId = `scenario-link-${nodeId}`;

  return (
    <FieldGroup className="gap-5">
      <Field className="gap-2">
        <FieldLabel htmlFor={selectId}>
          {t("scenarioLinkSettingsLabel")}
        </FieldLabel>
        <ScenarioLinkSelect
          id={selectId}
          data={data}
          triggerClassName="w-full"
          keepMissingSelection
        />
        {scenarioOptions.length === 0 ? (
          <FieldDescription>{t("scenarioLinkNoOptions")}</FieldDescription>
        ) : (
          <FieldDescription>{t("scenarioLinkSettingsHint")}</FieldDescription>
        )}
      </Field>
      {missingSelection ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertDescription>{t("scenarioLinkMissingHint")}</AlertDescription>
        </Alert>
      ) : null}
      {triggerSummary ? (
        <p
          className={cn(
            "flex min-w-0 items-start gap-2 rounded-md bg-orange-50 px-3 py-2 text-xs text-orange-700",
            "dark:bg-orange-950/40 dark:text-orange-300"
          )}
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {triggerSummary}
          </span>
        </p>
      ) : null}
    </FieldGroup>
  );
}

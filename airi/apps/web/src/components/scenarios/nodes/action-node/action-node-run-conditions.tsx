"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  MAX_SCENARIO_ACTION_RUN_CONDITIONS,
  normalizeScenarioActionRuleId,
  type ScenarioActionRunCondition,
} from "@icecore/scenario-contracts";
import { Plus, Trash2 } from "lucide-react";
import { useId, useState, type ReactNode, type SyntheticEvent } from "react";
import type { ScenarioAudienceOptions, TranslateFn } from "../../types";
import { ScenarioCustomerMultiSelect } from "../customer-multi-select";
import { ScenarioIntegerInput } from "../integer-input";
import {
  isRunConditionValueRemoved,
  selectOptionsFor,
  type ActionRunConditionType,
  type PendingConditionType,
} from "./action-node-run-condition-values";

type ActionNodeRunConditionsEditorProps = {
  audienceOptions: ScenarioAudienceOptions;
  conditions: ScenarioActionRunCondition[];
  readOnly: boolean;
  t: TranslateFn;
  onChange: (conditions: ScenarioActionRunCondition[]) => void;
};

const RUN_CONDITION_TYPES = [
  "classification",
  "internal_label",
  "specific_customers",
  "has_purchase_history",
  "funnel_stage",
  "last_seen_days",
] as const satisfies readonly ActionRunConditionType[];

/** Row titles complete "Only if…". */
const RUN_CONDITION_LABEL_KEYS: Record<ActionRunConditionType, string> = {
  classification: "runIfClassification",
  internal_label: "runIfInternalLabel",
  specific_customers: "runIfSpecificCustomers",
  has_purchase_history: "runIfHasPurchaseHistory",
  funnel_stage: "runIfFunnelStage",
  last_seen_days: "runIfInactiveFor",
};

const DEFAULT_INACTIVE_DAYS = 30;
const EMPTY_OPTIONS_VALUE = "__empty__";

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

function createConditionId(): string {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  return normalizeScenarioActionRuleId(`condition_${suffix}`);
}

function ConditionRowShell({
  children,
  disabled,
  label,
  onDelete,
  t,
  trailing,
}: {
  children?: ReactNode;
  disabled: boolean;
  label: string;
  onDelete: () => void;
  t: TranslateFn;
  /** Inline controls after the title, such as the inactive days input. */
  trailing?: ReactNode;
}) {
  return (
    <div
      className="space-y-1.5 py-2 first:pt-0 last:pb-0"
      data-testid="action-run-condition"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-[11px] font-medium">
          {label}
        </span>
        {trailing}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="nodrag nopan nokey ml-auto h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
          disabled={disabled}
          onClick={event => {
            event.stopPropagation();
            onDelete();
          }}
          onPointerDown={stopPropagation}
          aria-label={t("actionRunIfRemoveCondition")}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
      {children}
    </div>
  );
}

/**
 * Picks one option for a condition. A saved value that is no longer offered
 * keeps its text and says it was removed.
 */
function RunConditionOptionSelect({
  disabled,
  label,
  options,
  t,
  value,
  onValueChange,
}: {
  disabled: boolean;
  label: string;
  options: string[];
  t: TranslateFn;
  value: string;
  onValueChange: (value: string) => void;
}) {
  const errorId = useId();
  const removed = isRunConditionValueRemoved(value, options);
  return (
    <div className="space-y-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <Select
          value={value}
          disabled={disabled}
          onValueChange={next => {
            if (next !== EMPTY_OPTIONS_VALUE) onValueChange(next);
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label={label}
            aria-invalid={removed || undefined}
            aria-describedby={removed ? errorId : undefined}
            className="nodrag nopan nokey h-8 min-w-0 flex-1 text-[11px]"
            onClick={stopPropagation}
            onPointerDown={stopPropagation}
          >
            <SelectValue placeholder={t("runIfChoose")}>
              {value || undefined}
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="nodrag nopan nokey">
            {options.length > 0 ? (
              options.map(option => (
                <SelectItem key={option} value={option} className="text-xs">
                  {option}
                </SelectItem>
              ))
            ) : (
              <SelectItem
                value={EMPTY_OPTIONS_VALUE}
                disabled
                className="text-xs"
              >
                {t("runIfNoOptions")}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        {removed ? (
          <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px]">
            {t("runIfValueRemoved")}
          </Badge>
        ) : null}
      </div>
      {removed ? (
        <p id={errorId} className="text-[11px] text-destructive">
          {t("runIfValueRemovedError")}
        </p>
      ) : null}
    </div>
  );
}

function ActionRunConditionRow({
  audienceOptions,
  condition,
  disabled,
  onChange,
  onDelete,
  t,
}: {
  audienceOptions: ScenarioAudienceOptions;
  condition: ScenarioActionRunCondition;
  disabled: boolean;
  onChange: (condition: ScenarioActionRunCondition) => void;
  onDelete: () => void;
  t: TranslateFn;
}) {
  const label = t(RUN_CONDITION_LABEL_KEYS[condition.type]);

  return (
    <ConditionRowShell
      label={label}
      disabled={disabled}
      onDelete={onDelete}
      t={t}
      trailing={
        condition.type === "last_seen_days" ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            <ScenarioIntegerInput
              aria-label={t("runIfInactiveDaysLabel")}
              min={1}
              disabled={disabled}
              value={condition.minimumDays}
              defaultValue={DEFAULT_INACTIVE_DAYS}
              onValueCommit={minimumDays =>
                onChange({ ...condition, minimumDays })
              }
              className="nodrag nopan nokey h-7 w-14 px-1.5 text-[11px]"
              onPointerDown={stopPropagation}
              onClick={stopPropagation}
            />
            {t("runIfDaysSuffix")}
          </span>
        ) : null
      }
    >
      {condition.type === "classification" ? (
        <RunConditionOptionSelect
          label={label}
          disabled={disabled}
          value={condition.category}
          options={audienceOptions.classificationCategories}
          t={t}
          onValueChange={category => onChange({ ...condition, category })}
        />
      ) : null}
      {condition.type === "internal_label" ? (
        <RunConditionOptionSelect
          label={label}
          disabled={disabled}
          value={condition.label}
          options={audienceOptions.internalLabels}
          t={t}
          onValueChange={labelValue =>
            onChange({ ...condition, label: labelValue })
          }
        />
      ) : null}
      {condition.type === "specific_customers" ? (
        <ScenarioCustomerMultiSelect
          customers={audienceOptions.customers}
          selectedCustomerIds={condition.customerIds}
          disabled={disabled}
          t={t}
          onToggle={customerId => {
            const customerIds = condition.customerIds.includes(customerId)
              ? condition.customerIds.filter(id => id !== customerId)
              : [...condition.customerIds, customerId];
            if (customerIds.length === 0) return onDelete();
            onChange({ ...condition, customerIds });
          }}
        />
      ) : null}
      {condition.type === "funnel_stage" ? (
        <RunConditionOptionSelect
          label={label}
          disabled={disabled}
          value={condition.stage}
          options={audienceOptions.funnelStages}
          t={t}
          onValueChange={stage => onChange({ ...condition, stage })}
        />
      ) : null}
    </ConditionRowShell>
  );
}

function PendingRunConditionRow({
  audienceOptions,
  onCancel,
  onCreate,
  t,
  type,
}: {
  audienceOptions: ScenarioAudienceOptions;
  onCancel: () => void;
  onCreate: (condition: ScenarioActionRunCondition) => void;
  t: TranslateFn;
  type: PendingConditionType;
}) {
  const [id] = useState(createConditionId);
  const label = t(RUN_CONDITION_LABEL_KEYS[type]);

  return (
    <ConditionRowShell label={label} disabled={false} onDelete={onCancel} t={t}>
      {type === "specific_customers" ? (
        <ScenarioCustomerMultiSelect
          customers={audienceOptions.customers}
          selectedCustomerIds={[]}
          t={t}
          onToggle={customerId =>
            onCreate({ id, type, customerIds: [customerId] })
          }
        />
      ) : (
        <RunConditionOptionSelect
          label={label}
          disabled={false}
          value=""
          options={selectOptionsFor(type, audienceOptions)}
          t={t}
          onValueChange={value => {
            if (type === "classification") {
              onCreate({ id, type, category: value });
            } else if (type === "internal_label") {
              onCreate({ id, type, label: value });
            } else {
              onCreate({ id, type, stage: value });
            }
          }}
        />
      )}
    </ConditionRowShell>
  );
}

export function ActionNodeRunConditionsEditor({
  audienceOptions,
  conditions,
  readOnly,
  t,
  onChange,
}: ActionNodeRunConditionsEditorProps) {
  const [pendingConditionType, setPendingConditionType] =
    useState<PendingConditionType | null>(null);
  const atLimit = conditions.length >= MAX_SCENARIO_ACTION_RUN_CONDITIONS;

  const addCondition = (condition: ScenarioActionRunCondition): void => {
    onChange([...conditions, condition]);
    setPendingConditionType(null);
  };

  const selectConditionType = (type: ActionRunConditionType): void => {
    if (type === "has_purchase_history") {
      addCondition({ id: createConditionId(), type });
      return;
    }
    if (type === "last_seen_days") {
      addCondition({
        id: createConditionId(),
        type,
        minimumDays: DEFAULT_INACTIVE_DAYS,
      });
      return;
    }
    setPendingConditionType(type);
  };

  return (
    <div className="pb-2">
      <div className="divide-y divide-border/60">
        {conditions.map(condition => (
          <ActionRunConditionRow
            key={condition.id}
            audienceOptions={audienceOptions}
            condition={condition}
            disabled={readOnly}
            onChange={nextCondition =>
              onChange(
                conditions.map(current =>
                  current.id === condition.id ? nextCondition : current
                )
              )
            }
            onDelete={() =>
              onChange(
                conditions.filter(current => current.id !== condition.id)
              )
            }
            t={t}
          />
        ))}
        {pendingConditionType && !readOnly ? (
          <PendingRunConditionRow
            audienceOptions={audienceOptions}
            onCancel={() => setPendingConditionType(null)}
            onCreate={addCondition}
            t={t}
            type={pendingConditionType}
          />
        ) : null}
      </div>
      {atLimit ? (
        <p
          className="mt-1 px-1.5 text-[11px] text-muted-foreground"
          data-testid="action-run-conditions-limit"
        >
          {t("actionRunIfMax", { max: MAX_SCENARIO_ACTION_RUN_CONDITIONS })}
        </p>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="nodrag nopan nokey mt-1 h-7 px-1.5 text-[11px]"
              disabled={readOnly || Boolean(pendingConditionType)}
              onClick={stopPropagation}
              onPointerDown={stopPropagation}
            >
              <Plus className="mr-1 h-3 w-3" aria-hidden />
              {t("actionRunIfAddCondition")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {RUN_CONDITION_TYPES.map(type => (
              <DropdownMenuItem
                key={type}
                className="text-xs"
                onSelect={() => selectConditionType(type)}
              >
                {t(RUN_CONDITION_LABEL_KEYS[type])}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

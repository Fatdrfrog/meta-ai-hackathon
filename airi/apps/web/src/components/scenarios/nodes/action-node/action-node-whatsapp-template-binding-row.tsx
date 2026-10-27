"use client";

import { useTranslations } from "next-intl";
import type {
  ScenarioWhatsAppTemplateBinding,
  ScenarioWhatsAppTemplateBindingIssue,
  ScenarioWhatsAppTemplateContextKey,
} from "@icecore/scenario-contracts";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  SCENARIO_SELECT_TRIGGER_HIDE_DESCRIPTION_CLASS,
  ScenarioSelectItemContent,
} from "../../scenario-select-item-description";
import {
  TEMPLATE_BINDING_CONTEXT_ALIASES,
  TEMPLATE_BINDING_CONTEXT_GROUPS,
  TEMPLATE_BINDING_CONTEXT_LABELS,
  TEMPLATE_BINDING_ISSUE_MESSAGE_KEYS,
  formatTemplateBindingParameterLabel,
  type TemplateBindingParameter,
  type TemplateBindingPromptInput,
  type TemplateBindingSampleSource,
} from "./action-node-whatsapp-template-binding-labels";

type BindingIssue = ScenarioWhatsAppTemplateBindingIssue | undefined;

type BindingFieldProps = {
  parameterId: string;
  inputId: string;
  errorId: string;
  label: string;
  binding: ScenarioWhatsAppTemplateBinding | undefined;
  promptInputs: readonly TemplateBindingPromptInput[];
  onTouch: (id: string) => void;
  onUpdate: (id: string, binding: ScenarioWhatsAppTemplateBinding) => void;
};

/** One template variable: where its value comes from, and that value. */
export function ActionNodeWhatsAppTemplateBindingRow({
  nodeId,
  parameter,
  binding,
  issue,
  promptInputs,
  onTouch,
  onUpdate,
}: {
  nodeId: string;
  parameter: TemplateBindingParameter;
  binding: ScenarioWhatsAppTemplateBinding | undefined;
  /** The issue to show now; unset rows stay quiet until touched. */
  issue: BindingIssue;
  promptInputs: readonly TemplateBindingPromptInput[];
  onTouch: (id: string) => void;
  onUpdate: (id: string, binding: ScenarioWhatsAppTemplateBinding) => void;
}) {
  const t = useTranslations("Scenarios");
  const inputId = `${nodeId}-binding-${parameter.id}`;
  const errorId = `${inputId}-error`;
  const label = formatTemplateBindingParameterLabel(parameter, t);
  const sourceMissing =
    issue?.code === "binding_required" ||
    issue?.code === "binding_source_invalid";
  const fieldProps: BindingFieldProps = {
    parameterId: parameter.id,
    inputId,
    errorId,
    label,
    binding,
    promptInputs,
    onTouch,
    onUpdate,
  };
  return (
    <div className="min-w-0 space-y-1.5 rounded-md bg-muted/30 p-2">
      <Label htmlFor={`${inputId}-source`} className="break-words text-xs">
        {label}
      </Label>
      <TemplateBindingSourceSelect
        {...fieldProps}
        sourceMissing={sourceMissing}
      />
      <TemplateBindingValueField {...fieldProps} issue={issue} />
      {binding?.source === "context" && binding.key.startsWith("cart.") ? (
        <p className="text-[11px] text-muted-foreground">
          {t("whatsappTemplateBindingsCartHint")}
        </p>
      ) : null}
      {parameter.component === "button" && parameter.url ? (
        <p className="break-words text-[11px] text-muted-foreground">
          {t("whatsappTemplateBindingUrlHint", {
            url: parameter.url,
          })}
        </p>
      ) : null}
      {issue ? (
        <p id={errorId} role="alert" className="text-[11px] text-destructive">
          {t(TEMPLATE_BINDING_ISSUE_MESSAGE_KEYS[issue.code])}
        </p>
      ) : null}
    </div>
  );
}

function TemplateBindingSourceSelect({
  parameterId,
  inputId,
  errorId,
  label,
  binding,
  promptInputs,
  sourceMissing,
  onTouch,
  onUpdate,
}: BindingFieldProps & { sourceMissing: boolean }) {
  const t = useTranslations("Scenarios");
  return (
    <Select
      value={binding?.source ?? ""}
      onOpenChange={open => {
        if (!open) onTouch(parameterId);
      }}
      onValueChange={source => {
        if (source === "literal") onUpdate(parameterId, { source, value: "" });
        else if (source === "context")
          onUpdate(parameterId, {
            source,
            key: "customer_name",
          });
        else if (source === "prompt_input")
          onUpdate(parameterId, {
            source,
            key: promptInputs[0]?.key ?? "",
          });
      }}
    >
      <SelectTrigger
        id={`${inputId}-source`}
        data-testid={`template-binding-source-${parameterId}`}
        className={cn(
          "w-full min-w-0 bg-background text-xs",
          SCENARIO_SELECT_TRIGGER_HIDE_DESCRIPTION_CLASS
        )}
        aria-label={`${label}: ${t("whatsappTemplateBindingSource")}`}
        aria-invalid={sourceMissing || undefined}
        aria-describedby={sourceMissing ? errorId : undefined}
      >
        <SelectValue placeholder={t("whatsappTemplateBindingChooseSource")} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="literal">
          {t("whatsappTemplateBindingLiteral")}
        </SelectItem>
        <SelectItem value="context">
          {t("whatsappTemplateBindingContext")}
        </SelectItem>
        <SelectItem
          value="prompt_input"
          textValue={t("whatsappTemplateBindingPromptInput")}
          disabled={promptInputs.length === 0}
        >
          {promptInputs.length === 0 ? (
            <ScenarioSelectItemContent
              label={t("whatsappTemplateBindingPromptInput")}
              description={t("whatsappTemplateBindingsNoInputs")}
            />
          ) : (
            t("whatsappTemplateBindingPromptInput")
          )}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

/** The fixed value input, or the picker for a context or collected value. */
function TemplateBindingValueField({
  parameterId,
  inputId,
  errorId,
  label,
  binding,
  promptInputs,
  issue,
  onTouch,
  onUpdate,
}: BindingFieldProps & { issue: BindingIssue }) {
  const t = useTranslations("Scenarios");
  if (binding?.source === "literal") {
    return (
      <Input
        id={inputId}
        data-testid={`template-binding-value-${parameterId}`}
        value={binding.value}
        onChange={event =>
          onUpdate(parameterId, {
            source: "literal",
            value: event.target.value,
          })
        }
        onBlur={() => onTouch(parameterId)}
        aria-label={`${label}: ${t("whatsappTemplateBindingLiteral")}`}
        aria-invalid={Boolean(issue)}
        aria-describedby={issue ? errorId : undefined}
        className="min-w-0 bg-background text-xs"
        placeholder={t("whatsappTemplateBindingValuePlaceholder")}
      />
    );
  }
  if (binding?.source === "context" || binding?.source === "prompt_input") {
    return (
      <TemplateBindingKeySelect
        parameterId={parameterId}
        errorId={errorId}
        label={label}
        binding={binding}
        promptInputs={promptInputs}
        issue={issue}
        onUpdate={onUpdate}
      />
    );
  }
  return null;
}

function TemplateBindingKeySelect({
  parameterId,
  errorId,
  label,
  binding,
  promptInputs,
  issue,
  onUpdate,
}: Pick<
  BindingFieldProps,
  "parameterId" | "errorId" | "label" | "promptInputs" | "onUpdate"
> & {
  binding: TemplateBindingSampleSource;
  issue: BindingIssue;
}) {
  const t = useTranslations("Scenarios");
  return (
    <Select
      value={
        binding.source === "context"
          ? (TEMPLATE_BINDING_CONTEXT_ALIASES[binding.key] ?? binding.key)
          : binding.key
      }
      onValueChange={key =>
        onUpdate(
          parameterId,
          binding.source === "context"
            ? {
                source: "context",
                key: key as ScenarioWhatsAppTemplateContextKey,
              }
            : { source: "prompt_input", key }
        )
      }
    >
      <SelectTrigger
        data-testid={`template-binding-${binding.source === "context" ? "context" : "input"}-${parameterId}`}
        className="w-full min-w-0 bg-background text-xs"
        aria-label={`${label}: ${t(binding.source === "context" ? "whatsappTemplateBindingContext" : "whatsappTemplateBindingPromptInput")}`}
        aria-invalid={Boolean(issue)}
        aria-describedby={issue ? errorId : undefined}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        className={binding.source === "context" ? "max-h-64" : undefined}
      >
        {binding.source === "context" ? (
          <TemplateBindingContextOptions />
        ) : (
          <TemplateBindingPromptInputOptions
            inputKey={binding.key}
            promptInputs={promptInputs}
          />
        )}
      </SelectContent>
    </Select>
  );
}

function TemplateBindingContextOptions() {
  const t = useTranslations("Scenarios");
  return (
    <>
      {TEMPLATE_BINDING_CONTEXT_GROUPS.map(group => (
        <SelectGroup key={group.label}>
          <SelectLabel className="flex flex-col items-start gap-0.5">
            <span>{t(group.label)}</span>
            {group.description ? (
              <span className="text-[10px] font-normal text-muted-foreground">
                {t(group.description)}
              </span>
            ) : null}
          </SelectLabel>
          {group.keys.map(key => (
            <SelectItem key={key} value={key}>
              {t(TEMPLATE_BINDING_CONTEXT_LABELS[key])}
            </SelectItem>
          ))}
        </SelectGroup>
      ))}
    </>
  );
}

function TemplateBindingPromptInputOptions({
  inputKey,
  promptInputs,
}: {
  inputKey: string;
  promptInputs: readonly TemplateBindingPromptInput[];
}) {
  // A removed input stays listed, disabled, so the trigger still names it.
  const unavailableInput = !promptInputs.some(input => input.key === inputKey);
  return (
    <>
      {unavailableInput && inputKey ? (
        <SelectItem value={inputKey} disabled>
          {inputKey}
        </SelectItem>
      ) : null}
      {promptInputs.map(input => (
        <SelectItem key={input.key} value={input.key}>
          {input.label || input.key}
        </SelectItem>
      ))}
    </>
  );
}

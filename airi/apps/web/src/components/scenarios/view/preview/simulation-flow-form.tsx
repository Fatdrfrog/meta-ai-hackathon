"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  buildWhatsAppFlowEndpointTopology,
  evaluateWhatsAppFlowPayload,
  normalizeWhatsAppFlowReplyValues,
  resolveWhatsAppFlowLayoutContent,
  resolveWhatsAppFlowNextScreenId,
  type WhatsAppFlowConfig,
  type WhatsAppFlowScreenAction,
} from "@icecore/scenario-contracts";
import { ArrowLeft, ChevronRight, MoreVertical } from "lucide-react";
import type {
  FlowJsonPreview,
  FlowPreviewComponent,
} from "@/components/scenarios/builders/whatsapp/flow-json-preview";
import { WHATSAPP_ACTION_BUTTON_COLOR } from "@/components/scenarios/builders/whatsapp/action-colors";
import { FlowTextPreview } from "@/components/scenarios/builders/whatsapp/flow-text-preview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { ScenarioSimulationEvent } from "@/lib/scenarios/scenario-simulation-types";

type FormValues = Extract<ScenarioSimulationEvent, { kind: "flow" }>["values"];

function FlowCheckboxOptions({
  enabled,
  fieldId,
  options,
  selected,
  onChange,
}: {
  enabled: boolean;
  fieldId: string;
  options?: Array<{ id: string; title: string; description?: string }>;
  selected: string | string[] | undefined;
  onChange: (id: string, value: string | string[]) => void;
}) {
  const selectedIds = new Set(Array.isArray(selected) ? selected : []);
  return options?.map(option => (
    <label
      key={option.id}
      className="flex min-h-11 items-center gap-2 break-words text-sm"
    >
      <Checkbox
        disabled={!enabled}
        checked={selectedIds.has(option.id)}
        onCheckedChange={checked => {
          const next = new Set(selectedIds);
          if (checked) next.add(option.id);
          else next.delete(option.id);
          onChange(fieldId, [...next]);
        }}
      />
      <span>
        {option.title}
        {option.description ? (
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {option.description}
          </span>
        ) : null}
      </span>
    </label>
  ));
}

/** The existing Flow editor changes field definitions; this form collects test answers. */
type SimulationFlowFormProps = {
  config: WhatsAppFlowConfig;
  enabled: boolean;
  onSubmit: (values: FormValues) => void;
  onComplete?: (payload: Record<string, unknown>) => void;
  initialScreenId?: string;
  preview?: FlowJsonPreview;
};

export function SimulationFlowForm(props: SimulationFlowFormProps) {
  const sessionKey = useMemo(
    () =>
      JSON.stringify([
        props.config,
        props.initialScreenId,
        props.preview?.componentsByScreen,
      ]),
    [props.config, props.initialScreenId, props.preview?.componentsByScreen]
  );
  return <SimulationFlowFormSession key={sessionKey} {...props} />;
}

function SimulationFlowFormSession({
  config,
  enabled,
  onSubmit,
  onComplete,
  initialScreenId,
  preview,
}: SimulationFlowFormProps) {
  const t = useTranslations("Scenarios");
  const prefix = useId();
  const firstScreenId = config.screens[0]?.id;
  const requestedScreenId =
    initialScreenId ??
    (config.flowNavigationMode === "data_endpoint"
      ? firstScreenId
      : (config.flowActionPayload?.screen ?? firstScreenId));
  const [screenId, setScreenId] = useState(
    config.screens.some(screen => screen.id === requestedScreenId)
      ? requestedScreenId
      : firstScreenId
  );
  const [answers, setAnswers] = useState<Record<string, FormValues>>({});
  const [legacyValues, setLegacyValues] = useState<FormValues>({});
  const [history, setHistory] = useState<string[]>([]);
  const [dataByScreen, setDataByScreen] = useState<
    Record<string, Record<string, unknown>>
  >({});
  const [actionError, setActionError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusAfterNavigation = useRef(false);
  useEffect(() => {
    if (!focusAfterNavigation.current) return;
    focusAfterNavigation.current = false;
    heading.current?.focus();
  }, [screenId]);
  const index = config.screens.findIndex(screen => screen.id === screenId);
  const screen = config.screens[index];
  const graph = config.flowNavigationMode === "static_graph";
  const values = graph
    ? screen
      ? (answers[screen.id] ?? {})
      : {}
    : legacyValues;
  const allValues = graph
    ? (Object.assign({}, ...Object.values(answers), values) as FormValues)
    : legacyValues;
  const examples = Object.fromEntries(
    Object.entries(screen?.data ?? {})
      .filter(([, schema]) => Object.hasOwn(schema, "__example__"))
      .map(([key, schema]) => [key, schema.__example__])
  );
  const data = screen ? (dataByScreen[screen.id] ?? examples) : {};
  const topology = useMemo(() => {
    if (config.flowNavigationMode !== "data_endpoint") return null;
    try {
      return buildWhatsAppFlowEndpointTopology(config);
    } catch {
      return null;
    }
  }, [config]);
  const invalid =
    !screen || (config.flowNavigationMode === "data_endpoint" && !topology);
  if (invalid)
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("simulationInvalidForm")}
      </p>
    );
  const terminal = graph
    ? screen.terminal === true
    : index === config.screens.length - 1 ||
      Boolean(topology && !topology.routing[screen.id]?.length);
  const canSubmit = screen.fields.every(field => {
    if (field.fieldType === "NavigationList") return true;
    const value = values[field.id];
    return (
      !field.required ||
      (Array.isArray(value) ? value.length > 0 : Boolean(value?.trim()))
    );
  });
  const set = (id: string, value: string | string[]) => {
    setActionError(null);
    if (graph)
      setAnswers(current => ({
        ...current,
        [screen.id]: { ...current[screen.id], [id]: value },
      }));
    else setLegacyValues(current => ({ ...current, [id]: value }));
  };
  const navigate = (
    targetId: string | undefined,
    payload: Record<string, unknown> = {}
  ) => {
    if (!targetId || !config.screens.some(target => target.id === targetId)) {
      setActionError(t("simulationActionUnavailable"));
      return;
    }
    setHistory(current => [...current, screen.id]);
    setDataByScreen(current => ({ ...current, [targetId]: payload }));
    setActionError(null);
    focusAfterNavigation.current = true;
    setScreenId(targetId);
  };
  const performAction = (action: WhatsAppFlowScreenAction) => {
    if (!enabled || !canSubmit) return;
    if (
      action.name === "data_exchange" ||
      (action.name === "complete" && !terminal)
    ) {
      setActionError(t("simulationActionUnavailable"));
      return;
    }
    const result = evaluateWhatsAppFlowPayload(action.payload, {
      form: values,
      data,
    });
    if (!result.ok) {
      setActionError(t("simulationPayloadUnavailable"));
      return;
    }
    if (action.name === "navigate") {
      navigate(action.nextScreenId, result.value);
      return;
    }
    if (onComplete) {
      onComplete(result.value);
      return;
    }
    if (
      Object.values(result.value).every(
        value =>
          typeof value === "string" ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value)) ||
          (Array.isArray(value) &&
            value.every(item => typeof item === "string"))
      )
    )
      onSubmit(
        Object.fromEntries(
          Object.entries(result.value).map(([key, value]) => [
            key,
            typeof value === "number" || typeof value === "boolean"
              ? normalizeWhatsAppFlowReplyValues(value)[0]
              : value,
          ])
        ) as FormValues
      );
    else setActionError(t("simulationPayloadUnavailable"));
  };
  const actionAvailable = (action: WhatsAppFlowScreenAction) => {
    if (action.name === "data_exchange") return false;
    if (action.name === "navigate") {
      const target = action.nextScreenId;
      return config.screens.some(screen => screen.id === target);
    }
    return terminal;
  };
  const advanceOrSubmit = () => {
    if (!enabled || !canSubmit) return;
    if (graph) {
      if (screen.footer) performAction(screen.footer.action);
      return;
    }
    if (terminal) onSubmit(allValues);
    else
      navigate(
        topology
          ? resolveWhatsAppFlowNextScreenId(screen.id, allValues, topology)
          : config.screens[index + 1]?.id
      );
  };
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex min-w-0 items-center gap-2">
        {history.length ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("simulationBack")}
            disabled={!enabled}
            onClick={() => {
              focusAfterNavigation.current = true;
              setScreenId(history[history.length - 1]);
              setHistory(current => current.slice(0, -1));
              setActionError(null);
            }}
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
        ) : null}
        <h3
          ref={heading}
          tabIndex={-1}
          className="min-w-0 flex-1 scroll-mt-4 break-words font-semibold outline-none"
        >
          {screen.title}
        </h3>
        <MoreVertical
          className="size-4 text-muted-foreground"
          aria-hidden="true"
        />
      </div>
      {preview?.usesExampleData ||
      (graph &&
        Object.keys(examples).length > 0 &&
        !Object.hasOwn(dataByScreen, screen.id)) ? (
        <p className="text-xs text-muted-foreground">
          {t("simulationExampleData")}
        </p>
      ) : null}
      <fieldset disabled={!enabled} className="space-y-3">
        {(
          preview?.componentsByScreen[screen.id] ??
          resolveWhatsAppFlowLayoutContent(screen)
        ).map((component: FlowPreviewComponent, componentIndex) => {
          if (component.kind === "unsupported")
            return (
              <p
                key={`unsupported:${componentIndex}`}
                className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
              >
                {t("simulationUnsupportedComponent", {
                  component: component.component,
                })}
              </p>
            );
          if (component.kind === "text")
            return (
              <FlowTextPreview
                key={`text:${component.id}`}
                type={component.type}
                text={component.text}
              />
            );
          const field = screen.fields.find(
            candidate => candidate.id === component.fieldId
          );
          if (!field) return null;
          const id = `${prefix}-${screen.id}-${field.id}`;
          const current = values[field.id];
          const scalar = typeof current === "string" ? current : "";
          const label = `${field.label}${field.required ? " *" : ""}`;
          const helperId = field.helperText ? `${id}-help` : undefined;
          if (field.fieldType === "NavigationList")
            return (
              <div key={`field:${field.id}`} className="min-w-0">
                {field.navigationItems?.map((item, itemIndex) => (
                  <Button
                    key={itemIndex}
                    type="button"
                    variant="ghost"
                    className="h-auto min-h-14 w-full justify-between gap-3 rounded-none px-0 py-3 text-left whitespace-normal [&:not(:last-child)]:border-b [&:not(:last-child)]:border-border/50"
                    disabled={!enabled || !actionAvailable(item.action)}
                    onClick={() => performAction(item.action)}
                  >
                    <span className="min-w-0 break-words">
                      <span className="block text-sm font-medium">
                        {item.title}
                      </span>
                      {item.description ? (
                        <span className="mt-1 block text-xs font-normal text-muted-foreground">
                          {item.description}
                        </span>
                      ) : null}
                    </span>
                    <ChevronRight
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </Button>
                ))}
                {field.navigationItems?.some(
                  item => item.action.name === "data_exchange"
                ) ? (
                  <p className="text-xs text-muted-foreground">
                    {t("simulationActionUnavailable")}
                  </p>
                ) : null}
              </div>
            );
          if (
            field.fieldType === "CheckboxGroup" ||
            field.fieldType === "RadioButtonsGroup"
          )
            return (
              <fieldset
                key={`field:${field.id}`}
                className="space-y-2"
                aria-describedby={helperId}
              >
                <legend className="mb-1 break-words text-sm">{label}</legend>
                {field.fieldType === "RadioButtonsGroup" ? (
                  <RadioGroup
                    value={scalar}
                    onValueChange={value => set(field.id, value)}
                    disabled={!enabled}
                    required={field.required}
                    aria-label={label}
                  >
                    {field.options?.map(option => (
                      <label
                        key={option.id}
                        className="flex min-h-11 items-center gap-2 break-words text-sm"
                      >
                        <RadioGroupItem value={option.id} />
                        <span>
                          {option.title}
                          {option.description ? (
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              {option.description}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </RadioGroup>
                ) : (
                  <FlowCheckboxOptions
                    enabled={enabled}
                    fieldId={field.id}
                    options={field.options}
                    selected={current}
                    onChange={set}
                  />
                )}
                {field.helperText && (
                  <p id={helperId} className="text-xs text-muted-foreground">
                    {field.helperText}
                  </p>
                )}
              </fieldset>
            );
          return (
            <div
              key={`field:${field.id}`}
              className="min-w-0 space-y-1.5 text-sm"
            >
              <label htmlFor={id} className="block break-words">
                {label}
              </label>
              {field.fieldType === "Dropdown" ? (
                <select
                  id={id}
                  className="h-10 w-full min-w-0 max-w-full rounded-md border bg-background px-2"
                  required={field.required}
                  aria-describedby={helperId}
                  value={scalar}
                  onChange={event => set(field.id, event.target.value)}
                >
                  <option value="">{t("simulationSelectOption")}</option>
                  {field.options?.map(option => (
                    <option key={option.id} value={option.id}>
                      {option.title}
                    </option>
                  ))}
                </select>
              ) : field.fieldType === "TextArea" ? (
                <Textarea
                  id={id}
                  required={field.required}
                  aria-describedby={helperId}
                  maxLength={1024}
                  value={scalar}
                  onChange={event => set(field.id, event.target.value)}
                />
              ) : (
                <Input
                  id={id}
                  type={field.fieldType === "DatePicker" ? "date" : "text"}
                  required={field.required}
                  aria-describedby={helperId}
                  maxLength={1024}
                  value={scalar}
                  onChange={event => set(field.id, event.target.value)}
                />
              )}
              {field.helperText && (
                <p id={helperId} className="text-xs text-muted-foreground">
                  {field.helperText}
                </p>
              )}
            </div>
          );
        })}
      </fieldset>
      {actionError ? (
        <p role="alert" className="text-xs text-destructive">
          {actionError}
        </p>
      ) : null}
      {!graph || screen.footer ? (
        <Button
          type="button"
          variant="secondary"
          className="h-auto min-h-10 w-full whitespace-normal py-2"
          style={{
            backgroundColor: WHATSAPP_ACTION_BUTTON_COLOR,
            color: "white",
          }}
          disabled={
            !enabled ||
            !canSubmit ||
            (graph && screen.footer?.action.name === "data_exchange")
          }
          onClick={advanceOrSubmit}
        >
          {graph
            ? screen.footer?.label
            : terminal
              ? config.flowSubmitLabel || t("simulationSubmitForm")
              : t("simulationNextScreen")}
        </Button>
      ) : null}
      {graph && screen.footer?.action.name === "data_exchange" ? (
        <p className="text-xs text-muted-foreground">
          {t("simulationActionUnavailable")}
        </p>
      ) : null}
    </div>
  );
}

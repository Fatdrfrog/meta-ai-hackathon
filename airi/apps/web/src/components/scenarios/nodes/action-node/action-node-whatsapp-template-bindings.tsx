"use client";

import {
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  type SyntheticEvent,
} from "react";
import { useTranslations } from "next-intl";
import {
  getScenarioWhatsAppTemplateDefaultContextKey,
  getScenarioWhatsAppTemplateFallbackContextKey,
  listScenarioWhatsAppTemplateParameters,
  renderScenarioWhatsAppTemplateBindingPreview,
  resolveScenarioWhatsAppTemplateBindings,
  validateScenarioWhatsAppTemplateBindings,
  type ScenarioWhatsAppTemplateBinding,
  type ScenarioWhatsAppTemplateBindings,
  type WhatsAppComponent,
} from "@icecore/scenario-contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { WhatsAppActionRenderer } from "../../builders/whatsapp/action-renderer";
import { ScenarioCollapsibleSection } from "../../scenario-collapsible-section";
import { ScenarioInfoHint } from "../../scenario-info-hint";
import { ScenarioInlineNotice } from "../../scenario-inline-notice";
import { buildWhatsAppTemplatePreview } from "../../view/preview/utils";
import { ActionNodeWhatsAppTemplateBindingRow } from "./action-node-whatsapp-template-binding-row";
import {
  formatTemplateBindingParameterLabel,
  formatTemplateBindingSourceLabel,
  type TemplateBindingParameter,
  type TemplateBindingPromptInput,
  type TemplateBindingSampleSource,
} from "./action-node-whatsapp-template-binding-labels";

const NO_PROMPT_INPUTS: readonly TemplateBindingPromptInput[] = [];

type TemplateBindingPreview = {
  id: string;
  label: string | undefined;
  preview: ReturnType<typeof buildWhatsAppTemplatePreview>;
};

const CARD_CONTROL_CLASS = "nodrag nopan nokey";

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

/**
 * What a send without values puts in a variable whose data is missing. This
 * editor shows only on conversation steps (a campaign's first step takes
 * recipient columns), where the name is the customer's WhatsApp or saved
 * name and "Customer" when unknown, and a missing phone or link is "-".
 * Conversation and chat ids are always known.
 */
function describeMissingDefaults(
  parameters: readonly TemplateBindingParameter[]
): "name" | "dash" | "both" | null {
  const fallbacks = new Set(
    parameters.map(parameter =>
      getScenarioWhatsAppTemplateFallbackContextKey(parameter.variable)
    )
  );
  const name = fallbacks.has("customer_name");
  const dash = fallbacks.has("phone") || fallbacks.has("link");
  if (name && dash) return "both";
  if (name) return "name";
  return dash ? "dash" : null;
}

export function ActionNodeWhatsAppTemplateBindings({
  nodeId,
  components,
  bindings,
  promptInputs = NO_PROMPT_INPUTS,
  collapsible = false,
  onChange,
}: {
  nodeId: string;
  components?: WhatsAppComponent[];
  bindings?: ScenarioWhatsAppTemplateBindings;
  promptInputs?: readonly TemplateBindingPromptInput[];
  /** The legacy canvas card folds the editor into a section with a summary. */
  collapsible?: boolean;
  onChange: (value: ScenarioWhatsAppTemplateBindings) => void;
}) {
  const t = useTranslations("Scenarios");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const parameters = useMemo(
    () => listScenarioWhatsAppTemplateParameters(components),
    [components]
  );
  const issues = useMemo(
    () =>
      bindings
        ? validateScenarioWhatsAppTemplateBindings({
            components,
            bindings,
            availablePromptInputKeys: promptInputs.map(input => input.key),
          })
        : [],
    [components, bindings, promptInputs]
  );
  const sampleSources = useMemo(() => {
    const result = new Map<string, TemplateBindingSampleSource>();
    for (const parameter of parameters) {
      const binding = bindings?.parameters?.[parameter.id];
      if (
        binding &&
        (binding.source === "context" || binding.source === "prompt_input") &&
        typeof binding.key === "string"
      )
        result.set(`${binding.source}:${binding.key}`, binding);
    }
    return [...result.entries()];
  }, [parameters, bindings]);
  const resolvedPreview = useMemo(() => {
    if (!bindings || !previewOpen) return null;
    const values: Record<string, string> = {};
    const collected: Record<string, string> = {};
    for (const [id, source] of sampleSources) {
      const value = samples[id] || "";
      if (source.source === "context") values[source.key] = value;
      else collected[source.key] = value;
    }
    return resolveScenarioWhatsAppTemplateBindings({
      components,
      bindings,
      values,
      promptInputs: collected,
      availablePromptInputKeys: promptInputs.map(input => input.key),
    });
  }, [bindings, previewOpen, sampleSources, samples, components, promptInputs]);
  const previews = useMemo((): TemplateBindingPreview[] => {
    if (!resolvedPreview) return [];
    const rendered = renderScenarioWhatsAppTemplateBindingPreview(
      components ?? [],
      resolvedPreview.values
    );
    const makePreview = (items: WhatsAppComponent[]) =>
      buildWhatsAppTemplatePreview({
        components: items,
        context: {},
        preserveUnresolvedVariables: true,
        translate: t,
      });
    return [
      { id: "message", label: undefined, preview: makePreview(rendered) },
      ...rendered.flatMap(component =>
        component.type === "CAROUSEL"
          ? component.cards.map((card, index) => ({
              id: `card-${index}`,
              label: t("whatsappTemplateBindingCard", { index: index + 1 }),
              preview: makePreview(card.components),
            }))
          : []
      ),
    ];
  }, [components, resolvedPreview, t]);

  const parameterIds = new Set(parameters.map(parameter => parameter.id));
  const hasStaleBindings = issues.some(
    issue => !issue.parameterId || !parameterIds.has(issue.parameterId)
  );
  const issueFor = (parameter: TemplateBindingParameter) =>
    issues.find(item => item.parameterId === parameter.id);
  // Unset rows stay quiet until the merchant works on them.
  const visibleIssueFor = (parameter: TemplateBindingParameter) => {
    const issue = issueFor(parameter);
    if (!issue) return undefined;
    return touched.has(parameter.id) ||
      bindings?.parameters?.[parameter.id] !== undefined
      ? issue
      : undefined;
  };
  const setCount = bindings
    ? parameters.filter(parameter => !issueFor(parameter)).length
    : 0;
  const visibleErrorCount = bindings
    ? parameters.filter(parameter => visibleIssueFor(parameter)).length
    : 0;

  function touch(id: string) {
    setTouched(previous =>
      previous.has(id) ? previous : new Set(previous).add(id)
    );
  }

  function updateParameter(
    id: string,
    binding: ScenarioWhatsAppTemplateBinding
  ) {
    touch(id);
    onChange({
      version: 1,
      parameters: { ...bindings?.parameters, [id]: binding },
    });
  }

  function resetBindings() {
    setTouched(new Set());
    onChange({ version: 1, parameters: {} });
  }

  if (parameters.length === 0 && !hasStaleBindings) return null;

  const missingDefaults = describeMissingDefaults(parameters);
  const staleNotice = hasStaleBindings ? (
    <ScenarioInlineNotice
      data-testid="template-bindings-stale"
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(CARD_CONTROL_CLASS, "h-7 px-2 text-[11px]")}
          onPointerDown={stopPropagation}
          onClick={event => {
            event.stopPropagation();
            resetBindings();
          }}
        >
          {t("whatsappTemplateBindingsReset")}
        </Button>
      }
    >
      {t("whatsappTemplateBindingsStale")}
    </ScenarioInlineNotice>
  ) : null;

  const editor =
    parameters.length === 0 ? null : !bindings ? (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {t("whatsappTemplateBindingsLegacyHint")}
        </p>
        <ul
          data-testid="template-bindings-defaults"
          className="space-y-1 text-xs"
        >
          {parameters.map(parameter => (
            <li
              key={parameter.id}
              className="flex min-w-0 items-baseline justify-between gap-2"
            >
              <span className="min-w-0 break-words text-muted-foreground">
                {formatTemplateBindingParameterLabel(parameter, t)}
              </span>
              <span className="shrink-0 font-medium">
                {formatTemplateBindingSourceLabel(
                  {
                    source: "context",
                    key: getScenarioWhatsAppTemplateDefaultContextKey(
                      parameter.variable
                    ),
                  },
                  promptInputs,
                  t
                )}
              </span>
            </li>
          ))}
        </ul>
        {missingDefaults ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="template-bindings-default-missing"
          >
            {t("whatsappTemplateBindingsDefaultMissing", {
              fallback: missingDefaults,
            })}
          </p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(CARD_CONTROL_CLASS, "h-auto whitespace-normal")}
          onPointerDown={stopPropagation}
          onClick={event => {
            event.stopPropagation();
            onChange({ version: 1, parameters: {} });
          }}
        >
          {t("whatsappTemplateBindingsConfigure")}
        </Button>
      </div>
    ) : (
      <>
        <div className="space-y-3">
          {parameters.map(parameter => (
            <ActionNodeWhatsAppTemplateBindingRow
              key={parameter.id}
              nodeId={nodeId}
              parameter={parameter}
              binding={bindings.parameters?.[parameter.id]}
              issue={visibleIssueFor(parameter)}
              promptInputs={promptInputs}
              onTouch={touch}
              onUpdate={updateParameter}
            />
          ))}
        </div>
        <TemplateBindingsPreview
          nodeId={nodeId}
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          sampleSources={sampleSources}
          samples={samples}
          onSamplesChange={setSamples}
          promptInputs={promptInputs}
          missingValues={Boolean(resolvedPreview?.issues.length)}
          previews={previews}
        />
      </>
    );

  return (
    <TemplateBindingsFrame
      nodeId={nodeId}
      collapsible={collapsible}
      bindings={bindings}
      setCount={setCount}
      total={parameters.length}
      errorCount={visibleErrorCount}
      staleNotice={staleNotice}
      editor={editor}
    />
  );
}

/** Sample values for each read source, and the message they would produce. */
function TemplateBindingsPreview({
  nodeId,
  open,
  onOpenChange,
  sampleSources,
  samples,
  onSamplesChange,
  promptInputs,
  missingValues,
  previews,
}: {
  nodeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sampleSources: ReadonlyArray<[string, TemplateBindingSampleSource]>;
  samples: Record<string, string>;
  onSamplesChange: Dispatch<SetStateAction<Record<string, string>>>;
  promptInputs: readonly TemplateBindingPromptInput[];
  missingValues: boolean;
  previews: readonly TemplateBindingPreview[];
}) {
  const t = useTranslations("Scenarios");
  return (
    <ScenarioCollapsibleSection
      variant="inline"
      title={t("whatsappTemplateBindingsPreview")}
      open={open}
      onOpenChange={onOpenChange}
      data-testid="template-binding-preview-section"
    >
      <div className="space-y-3 pt-2" data-testid="template-binding-preview">
        {sampleSources.map(([id, source]) => (
          <div key={id} className="space-y-1">
            <Label
              htmlFor={`${nodeId}-sample-${id}`}
              className="break-words text-xs"
            >
              {formatTemplateBindingSourceLabel(source, promptInputs, t)}
            </Label>
            <Input
              id={`${nodeId}-sample-${id}`}
              data-testid={`template-binding-sample-${id}`}
              value={samples[id] || ""}
              onChange={event =>
                onSamplesChange(previous => ({
                  ...previous,
                  [id]: event.target.value,
                }))
              }
              placeholder={t("whatsappTemplateBindingSamplePlaceholder")}
              className="min-w-0 text-xs"
            />
          </div>
        ))}
        {missingValues ? (
          <p
            role="status"
            className="text-xs text-amber-700 dark:text-amber-400"
          >
            {t("whatsappTemplateBindingsPreviewMissing")}
          </p>
        ) : null}
        {previews.map(({ id, label, preview }) =>
          preview ? (
            <div key={id} className="min-w-0 space-y-1">
              {label ? <p className="text-xs font-medium">{label}</p> : null}
              <WhatsAppActionRenderer
                surface="message"
                headerText={preview.headerText}
                headerMediaFormat={preview.headerMediaFormat}
                headerMediaUrl={preview.headerMediaUrl}
                bodyText={preview.bodyText}
                footerText={preview.footerText}
                buttons={preview.buttons}
                fitContent
                align="start"
              />
            </div>
          ) : null
        )}
      </div>
    </ScenarioCollapsibleSection>
  );
}

/**
 * The legacy canvas card folds the editor into a section with a summary; the
 * settings panel shows it under a heading.
 */
function TemplateBindingsFrame({
  nodeId,
  collapsible,
  bindings,
  setCount,
  total,
  errorCount,
  staleNotice,
  editor,
}: {
  nodeId: string;
  collapsible: boolean;
  bindings: ScenarioWhatsAppTemplateBindings | undefined;
  setCount: number;
  total: number;
  errorCount: number;
  staleNotice: ReactNode;
  editor: ReactNode;
}) {
  const t = useTranslations("Scenarios");
  const title = t("whatsappTemplateBindingsTitle");
  const hint = {
    label: t("infoHintLabel", { topic: title }),
    text: t("whatsappTemplateBindingsHint"),
  };

  if (!collapsible) {
    return (
      <section
        className="nodrag nowheel w-full min-w-0 space-y-3 rounded-lg border bg-background p-3"
        data-testid={`template-bindings-${nodeId}`}
      >
        <div className="flex min-w-0 items-center gap-1">
          <h4 className="text-sm font-medium">{title}</h4>
          {bindings ? (
            <ScenarioInfoHint label={hint.label}>{hint.text}</ScenarioInfoHint>
          ) : null}
        </div>
        {staleNotice}
        {editor}
      </section>
    );
  }

  return (
    <div
      className="nodrag nowheel w-full min-w-0 space-y-2"
      data-testid={`template-bindings-${nodeId}`}
    >
      {staleNotice}
      {editor ? (
        <ScenarioCollapsibleSection
          title={title}
          summary={
            bindings
              ? t("whatsappTemplateBindingsSummary", { set: setCount, total })
              : t("whatsappTemplateBindingsLegacyHint")
          }
          info={bindings ? hint : undefined}
          errorCount={errorCount}
          keepMounted
          defaultOpen={bindings !== undefined && setCount < total}
          className="rounded-lg border bg-background"
          data-testid="template-bindings-section"
        >
          <div className="space-y-3 px-3 pb-3 pt-1">{editor}</div>
        </ScenarioCollapsibleSection>
      ) : null}
    </div>
  );
}

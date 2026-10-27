"use client";

import {
  resolveWhatsAppFlowLayoutContent,
  type WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ChevronRight,
  FileJson,
  MoreVertical,
  RefreshCw,
  X,
} from "lucide-react";
import type { FlowJsonPreview } from "@/components/scenarios/builders/whatsapp/flow-json-preview";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FlowFieldChoiceMarker,
  FlowFieldInputSample,
} from "@/components/scenarios/builders/whatsapp/flow-field-preview";
import { resolveFlowSubmitButtonLabel } from "@/lib/scenarios/whatsapp-flow-ui-locale";
import { WHATSAPP_ACTION_BUTTON_COLOR } from "@/components/scenarios/builders/whatsapp/action-colors";
import { FlowTextPreview } from "@/components/scenarios/builders/whatsapp/flow-text-preview";

const MOBILE_SURFACE_CLASS =
  "mx-auto flex w-full max-w-[340px] min-w-0 flex-col overflow-hidden rounded-[1.5rem] bg-background shadow-[0_4px_24px_-8px_rgba(15,23,42,0.18)] ring-1 ring-black/5 dark:ring-white/10";

export type FlowGalleryPreviewModel =
  | { kind: "visual"; config: WhatsAppFlowConfig }
  | { kind: "document"; preview: FlowJsonPreview }
  | {
      kind: "advanced";
      screens: Array<{ id: string; title: string }>;
      totalScreens?: number;
    }
  | { kind: "empty" };

type FlowGalleryPreviewProps = {
  model?: FlowGalleryPreviewModel | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
};

function AdvancedFlowNotice({ screenId }: { screenId?: string }) {
  const t = useTranslations("WhatsAppFlows.gallery");
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      <p className="flex items-center gap-1.5 font-medium">
        <FileJson className="size-4" aria-hidden="true" />
        {t("advancedTitle")}
      </p>
      <p className="leading-relaxed">{t("advancedDescription")}</p>
      {screenId ? (
        <p
          className="line-clamp-2 [overflow-wrap:anywhere] font-mono"
          title={screenId}
        >
          {screenId}
        </p>
      ) : null}
    </div>
  );
}

export function FlowGalleryPreview({
  model,
  loading,
  error,
  onRetry,
}: FlowGalleryPreviewProps) {
  const t = useTranslations("WhatsAppFlows.gallery");
  const scenarioT = useTranslations("Scenarios");
  const titleId = useId();
  const [selectedScreenIndex, setSelectedScreenIndex] = useState(0);
  if (loading || (!model && !error)) {
    return (
      <div
        role="status"
        className={`${MOBILE_SURFACE_CLASS} min-h-64 gap-4 p-5`}
      >
        <span className="sr-only">{t("loading")}</span>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  if (error) {
    return (
      <div
        className={`${MOBILE_SURFACE_CLASS} min-h-64 justify-center p-5 text-sm text-muted-foreground`}
      >
        <p>{t("loadFailed")}</p>
        <p
          className="mt-1 line-clamp-2 [overflow-wrap:anywhere] text-xs"
          title={error}
        >
          {error}
        </p>
        {onRetry ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={onRetry}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {t("retry")}
          </Button>
        ) : null}
      </div>
    );
  }
  const screens =
    model?.kind === "visual"
      ? model.config.screens
      : model?.kind === "document"
        ? model.preview.config.screens
        : model?.kind === "advanced"
          ? model.screens
          : [];
  const activeScreenIndex =
    selectedScreenIndex < screens.length ? selectedScreenIndex : 0;
  const activeScreen = screens[activeScreenIndex];
  const screenCount =
    model?.kind === "advanced"
      ? (model.totalScreens ?? screens.length)
      : model?.kind === "document"
        ? model.preview.totalScreens
        : screens.length;
  if (!activeScreen) {
    return (
      <div className={`${MOBILE_SURFACE_CLASS} min-h-64 justify-center p-5`}>
        {model?.kind === "advanced" ? (
          <>
            <AdvancedFlowNotice />
            <p className="mt-2 text-[11px] text-muted-foreground">
              {t("screenCount", { count: screenCount })}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">{t("emptyTitle")}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {t("emptyDescription")}
            </p>
          </>
        )}
      </div>
    );
  }
  const config =
    model?.kind === "visual"
      ? model.config
      : model?.kind === "document"
        ? model.preview.config
        : null;
  const fields = config?.screens[activeScreenIndex]?.fields ?? [];
  const previewComponents =
    model?.kind === "document"
      ? model.preview.componentsByScreen[activeScreen.id]
      : null;
  const content =
    previewComponents ??
    (config
      ? resolveWhatsAppFlowLayoutContent(config.screens[activeScreenIndex])
      : []);
  const visibleContent = content.slice(0, 4);
  const hiddenFieldCount =
    fields.length -
    visibleContent.filter(component => component.kind === "field").length;
  const hiddenUnsupportedComponents = content
    .slice(4)
    .flatMap(component =>
      component.kind === "unsupported" ? [component.component] : []
    );
  const footerLabel =
    config?.flowNavigationMode === "static_graph"
      ? config.screens[activeScreenIndex]?.footer?.label
      : config
        ? resolveFlowSubmitButtonLabel(config)
        : null;
  return (
    <div className="min-w-0 space-y-3">
      <div
        role="group"
        aria-label={t("screens")}
        className="flex min-w-0 gap-1 overflow-x-auto pb-1"
      >
        {screens.map((screen, index) => (
          <Button
            key={index}
            type="button"
            size="xs"
            variant={index === activeScreenIndex ? "secondary" : "ghost"}
            aria-pressed={index === activeScreenIndex}
            title={screen.title || t("screen", { number: index + 1 })}
            className="h-8 max-w-40 shrink-0"
            onClick={() => setSelectedScreenIndex(index)}
          >
            <span className="truncate">
              {screen.title || t("screen", { number: index + 1 })}
            </span>
          </Button>
        ))}
      </div>
      <section aria-labelledby={titleId} className={MOBILE_SURFACE_CLASS}>
        <div className="flex min-w-0 items-center gap-3 px-5 py-4">
          <X
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <h3
            id={titleId}
            className="min-w-0 flex-1 line-clamp-2 [overflow-wrap:anywhere] text-[15px] font-semibold"
            title={activeScreen.title}
          >
            {activeScreen.title ||
              t("screen", { number: activeScreenIndex + 1 })}
          </h3>
          <MoreVertical
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </div>
        <div className="min-h-52 space-y-4 px-5 pt-1 pb-5">
          {config ? (
            <>
              {visibleContent.map((component, componentIndex) => {
                if (component.kind === "unsupported")
                  return (
                    <p
                      key={`unsupported:${componentIndex}`}
                      className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                    >
                      {scenarioT("simulationUnsupportedComponent", {
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
                const field = fields.find(
                  candidate => candidate.id === component.fieldId
                );
                if (!field) return null;
                if (field.fieldType === "NavigationList")
                  return (
                    <div key={`field:${field.id}`} className="min-w-0">
                      {field.navigationItems
                        ?.slice(0, 4)
                        .map((item, itemIndex) => (
                          <div
                            key={itemIndex}
                            className="flex min-w-0 items-center justify-between gap-2 py-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-border/40"
                          >
                            <div className="min-w-0">
                              <p className="line-clamp-2 [overflow-wrap:anywhere] text-[13px] font-medium">
                                {item.title}
                              </p>
                              {item.description ? (
                                <p className="mt-1 line-clamp-2 [overflow-wrap:anywhere] text-xs text-muted-foreground">
                                  {item.description}
                                </p>
                              ) : null}
                            </div>
                            <ChevronRight
                              className="size-4 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                          </div>
                        ))}
                      {(field.navigationItems?.length ?? 0) > 4 ? (
                        <p className="text-[10px] text-muted-foreground">
                          {t("moreOptions", {
                            count: field.navigationItems!.length - 4,
                          })}
                        </p>
                      ) : null}
                    </div>
                  );
                const choice =
                  field.fieldType === "RadioButtonsGroup" ||
                  field.fieldType === "CheckboxGroup";
                const options = field.options ?? [];
                return (
                  <div key={`field:${field.id}`} className="min-w-0">
                    <div className="flex items-start gap-1.5">
                      <p
                        className="min-w-0 flex-1 line-clamp-2 [overflow-wrap:anywhere] text-[13px] font-medium"
                        title={field.label}
                      >
                        {field.label || field.id}
                      </p>
                      {field.required ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {t("required")}
                        </span>
                      ) : null}
                    </div>
                    {field.helperText ? (
                      <p
                        className="mt-1 line-clamp-2 [overflow-wrap:anywhere] text-xs text-muted-foreground"
                        title={field.helperText}
                      >
                        {field.helperText}
                      </p>
                    ) : null}
                    {!choice ? (
                      <FlowFieldInputSample
                        fieldType={field.fieldType}
                        className={
                          field.fieldType === "TextArea"
                            ? "min-h-16 rounded-lg bg-transparent px-3 py-2 text-xs text-muted-foreground dark:bg-transparent dark:text-muted-foreground"
                            : "h-10 rounded-lg bg-transparent px-3 text-xs text-muted-foreground dark:bg-transparent dark:text-muted-foreground"
                        }
                      />
                    ) : null}
                    {choice && options.length ? (
                      <div className="mt-2 space-y-3">
                        {options.slice(0, 2).map(option => (
                          <div
                            key={option.id}
                            className="flex min-w-0 items-start gap-2.5 text-xs text-muted-foreground"
                          >
                            {choice ? (
                              <span className="mt-0.5" aria-hidden="true">
                                <FlowFieldChoiceMarker
                                  radio={
                                    field.fieldType === "RadioButtonsGroup"
                                  }
                                />
                              </span>
                            ) : null}
                            <span
                              className="line-clamp-2 [overflow-wrap:anywhere]"
                              title={option.title}
                            >
                              {option.title}
                              {option.description ? (
                                <span className="mt-0.5 block text-xs text-muted-foreground">
                                  {option.description}
                                </span>
                              ) : null}
                            </span>
                          </div>
                        ))}
                        {options.length > 2 ? (
                          <p className="text-[10px] text-muted-foreground">
                            {t("moreOptions", { count: options.length - 2 })}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {hiddenUnsupportedComponents.length ? (
                <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {scenarioT("simulationUnsupportedComponent", {
                    component: [...new Set(hiddenUnsupportedComponents)].join(
                      ", "
                    ),
                  })}
                </p>
              ) : null}
              {hiddenFieldCount > 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  {t("moreFields", { count: hiddenFieldCount })}
                </p>
              ) : null}
            </>
          ) : (
            <AdvancedFlowNotice screenId={activeScreen.id} />
          )}
        </div>
        {footerLabel ? (
          <div className="mt-auto px-5 pt-2 pb-5">
            <div
              className="rounded-lg px-3 py-2.5 text-center text-[13px] font-semibold text-white"
              style={{ backgroundColor: WHATSAPP_ACTION_BUTTON_COLOR }}
            >
              {footerLabel}
            </div>
          </div>
        ) : null}
      </section>
      <div className="mx-auto w-full max-w-[340px] space-y-1 px-1 text-xs text-muted-foreground">
        {config?.headerText ? (
          <p
            className="line-clamp-2 [overflow-wrap:anywhere] font-medium text-foreground"
            title={config.headerText}
          >
            {config.headerText}
          </p>
        ) : null}
        {config?.bodyText ? (
          <p
            className="line-clamp-2 [overflow-wrap:anywhere]"
            title={config.bodyText}
          >
            {config.bodyText}
          </p>
        ) : null}
        {config?.footerText ? (
          <p
            className="line-clamp-2 [overflow-wrap:anywhere] text-[11px]"
            title={config.footerText}
          >
            {config.footerText}
          </p>
        ) : null}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {t("screenCount", { count: screenCount })}
      </p>
      {model?.kind === "document" && model.preview.usesExampleData ? (
        <p className="text-[11px] text-muted-foreground">
          {scenarioT("simulationExampleData")}
        </p>
      ) : null}
    </div>
  );
}

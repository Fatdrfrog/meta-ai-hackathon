"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "next-intl";
import { useLayoutEffect, type ComponentProps } from "react";
import type { TelegramReplyBuilder } from "../../builders/telegram";
import { scenarioEditorChunks } from "../../scenario-editor-chunks";
import { lazyScenarioChunkComponent } from "../../scenario-lazy-chunk";
import { ScenarioHiddenSourceHandles } from "../../scenario-hidden-source-handles";
import { ScenarioLazyChunkBoundary } from "../../scenario-lazy-chunk-boundary";
import { useLatestRef } from "../../view/use-latest-ref";
import type { ActionNodeGenerativeAISection } from "./action-node-generative-ai-section";
import type { ActionNodeSettings } from "./action-node-settings";
import type { ActionNodeWhatsAppServiceMessageSection } from "./action-node-whatsapp-service-message-section";
import type { ActionNodeWhatsAppTemplateSection } from "./action-node-whatsapp-template-section";

/*
 * Editors for one kind of action, downloaded when a step of that kind shows.
 * Import them only through these wrappers: a static import would put the
 * editor back in the Scenarios page's first load. The node's ResizeObserver
 * re-measures its handles when an editor replaces its placeholder.
 */

const ServiceMessageSectionChunk = lazyScenarioChunkComponent(
  scenarioEditorChunks.whatsAppServiceMessageSection,
  module => module.ActionNodeWhatsAppServiceMessageSection
);
const TemplateSectionChunk = lazyScenarioChunkComponent(
  scenarioEditorChunks.whatsAppTemplateSection,
  module => module.ActionNodeWhatsAppTemplateSection
);
const GenerativeAISectionChunk = lazyScenarioChunkComponent(
  scenarioEditorChunks.generativeAISection,
  module => module.ActionNodeGenerativeAISection
);
const ActionNodeSettingsChunk = lazyScenarioChunkComponent(
  scenarioEditorChunks.actionNodeSettings,
  module => module.ActionNodeSettings
);
const TelegramReplyBuilderChunk = lazyScenarioChunkComponent(
  scenarioEditorChunks.telegramReplyBuilder,
  module => module.TelegramReplyBuilder
);

/** Placeholder for an editor that is still loading. */
export function ActionNodeEditorLoading({ label }: { label: string }) {
  return (
    <div role="status" className="space-y-2">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-24 w-full" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

function ActionNodeSectionLoading() {
  const t = useTranslations("Scenarios");
  return <ActionNodeEditorLoading label={t("loadingItems")} />;
}

/** Canvas only: the linked routes whose dots the section draws. */
type SectionRouteAnchorProps = {
  routeAnchorHandleIds?: readonly string[];
  /** The section replaced its placeholder: measure the real dots. */
  onRouteAnchorsRemoved?: () => void;
};

/**
 * Invisible anchors for the section's linked routes while it downloads, so
 * their edges draw and React Flow finds their handles.
 */
function SectionRouteAnchors({
  routeAnchorHandleIds,
  onRouteAnchorsRemoved,
}: SectionRouteAnchorProps) {
  const onRemovedRef = useLatestRef(onRouteAnchorsRemoved);
  useLayoutEffect(() => () => onRemovedRef.current?.(), [onRemovedRef]);
  return routeAnchorHandleIds?.length ? (
    <ScenarioHiddenSourceHandles handleIds={routeAnchorHandleIds} />
  ) : null;
}

export function LazyActionNodeWhatsAppServiceMessageSection({
  routeAnchorHandleIds,
  onRouteAnchorsRemoved,
  ...props
}: ComponentProps<typeof ActionNodeWhatsAppServiceMessageSection> &
  SectionRouteAnchorProps) {
  return (
    <ScenarioLazyChunkBoundary
      chunk={scenarioEditorChunks.whatsAppServiceMessageSection}
      fallback={
        <>
          <ActionNodeSectionLoading />
          <SectionRouteAnchors
            routeAnchorHandleIds={routeAnchorHandleIds}
            onRouteAnchorsRemoved={onRouteAnchorsRemoved}
          />
        </>
      }
    >
      <ServiceMessageSectionChunk {...props} />
    </ScenarioLazyChunkBoundary>
  );
}

export function LazyActionNodeWhatsAppTemplateSection({
  routeAnchorHandleIds,
  onRouteAnchorsRemoved,
  ...props
}: ComponentProps<typeof ActionNodeWhatsAppTemplateSection> &
  SectionRouteAnchorProps) {
  return (
    <ScenarioLazyChunkBoundary
      chunk={scenarioEditorChunks.whatsAppTemplateSection}
      fallback={
        <>
          <ActionNodeEditorLoading label={props.loadingLabel} />
          <SectionRouteAnchors
            routeAnchorHandleIds={routeAnchorHandleIds}
            onRouteAnchorsRemoved={onRouteAnchorsRemoved}
          />
        </>
      }
    >
      <TemplateSectionChunk {...props} />
    </ScenarioLazyChunkBoundary>
  );
}

export function LazyActionNodeGenerativeAISection(
  props: ComponentProps<typeof ActionNodeGenerativeAISection>
) {
  return (
    <ScenarioLazyChunkBoundary
      chunk={scenarioEditorChunks.generativeAISection}
      fallback={<ActionNodeSectionLoading />}
    >
      <GenerativeAISectionChunk {...props} />
    </ScenarioLazyChunkBoundary>
  );
}

export function LazyTelegramReplyBuilder({
  routeAnchorHandleIds,
  onRouteAnchorsRemoved,
  ...props
}: ComponentProps<typeof TelegramReplyBuilder> & SectionRouteAnchorProps) {
  return (
    <ScenarioLazyChunkBoundary
      chunk={scenarioEditorChunks.telegramReplyBuilder}
      fallback={
        <>
          <ActionNodeSectionLoading />
          <SectionRouteAnchors
            routeAnchorHandleIds={routeAnchorHandleIds}
            onRouteAnchorsRemoved={onRouteAnchorsRemoved}
          />
        </>
      }
    >
      <TelegramReplyBuilderChunk {...props} />
    </ScenarioLazyChunkBoundary>
  );
}

/** Node settings for an action, downloaded when one is first opened. */
export function LazyActionNodeSettings(
  props: ComponentProps<typeof ActionNodeSettings>
) {
  return (
    <ScenarioLazyChunkBoundary
      chunk={scenarioEditorChunks.actionNodeSettings}
      fallback={<ActionNodeSectionLoading />}
    >
      <ActionNodeSettingsChunk {...props} />
    </ScenarioLazyChunkBoundary>
  );
}

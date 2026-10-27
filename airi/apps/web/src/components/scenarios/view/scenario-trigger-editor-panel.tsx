"use client";

import { useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { BusinessEventTriggerCatalog } from "../nodes/trigger-node/business-event-trigger-model";
import { LazyTriggerNodeSettings } from "../nodes/trigger-node/lazy-trigger-node-settings";
import type { ScenarioFlowNode, TranslateFn } from "../types";
import { enrichScenarioEditorNode } from "./node-enrichment/enrich-scenario-node";
import type { ScenarioTriggerEditorNodeData } from "./node-enrichment/types";
import { restoreScenarioNodeFocus } from "./node-settings/restore-scenario-node-focus";
import { useScenarioNodeEnrichment } from "./scenario-node-enrichment-context";

export function TriggerEditorPanel({
  nodeId,
  data,
  onClose,
  businessEventCatalog,
  onRefreshBusinessEventCatalog,
}: {
  nodeId: string;
  data: ScenarioTriggerEditorNodeData;
  onClose: () => void;
  businessEventCatalog?: BusinessEventTriggerCatalog;
  onRefreshBusinessEventCatalog?: () => void;
}) {
  const t = useTranslations("Scenarios") as TranslateFn;
  const contentRef = useRef<HTMLDivElement>(null);

  return (
    <Sheet
      open
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        ref={contentRef}
        className="w-full gap-0 overflow-hidden sm:max-w-[520px]"
        showCloseButton={false}
        data-scenario-trigger-editor={nodeId}
        onCloseAutoFocus={event => {
          event.preventDefault();
          // A replacement editor owns focus when selection or document changes.
          const nextEditor = document.querySelector(
            "[data-scenario-trigger-editor]"
          );
          if (nextEditor && nextEditor !== contentRef.current) return;
          restoreScenarioNodeFocus(nodeId);
        }}
      >
        <SheetHeader className="relative shrink-0 border-b p-5 pr-16">
          <SheetTitle className="flex items-center gap-2">
            <Zap className="size-4 shrink-0 text-amber-500" aria-hidden />
            {t("triggerEditorTitle")}
          </SheetTitle>
          <SheetDescription className="sr-only">
            {t("triggerEditorDescription")}
          </SheetDescription>
          <SheetClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              className="absolute right-3 top-3"
              aria-label={t("triggerEditorClose")}
            >
              <X aria-hidden />
            </Button>
          </SheetClose>
        </SheetHeader>
        <LazyTriggerNodeSettings
          nodeId={nodeId}
          data={data}
          businessEventCatalog={businessEventCatalog}
          onRefreshBusinessEventCatalog={onRefreshBusinessEventCatalog}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5"
        />
        <SheetFooter className="shrink-0 border-t px-5 py-3">
          <SheetClose asChild>
            <Button
              type="button"
              variant="outline"
              className="w-full sm:ml-auto sm:w-auto"
            >
              {t("triggerEditorClose")}
            </Button>
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** Keep the editor outside React Flow's virtualized node renderers. */
export function ScenarioTriggerEditorPanel({
  nodes,
}: {
  nodes: ScenarioFlowNode[];
}) {
  const ctx = useScenarioNodeEnrichment();
  const selected = useMemo(() => {
    const node = nodes.find(item => item.id === ctx.selectedNodeId);
    if (!node || node.data.kind !== "trigger" || node.data.linkedConditionId)
      return null;
    const enriched = enrichScenarioEditorNode(node, ctx);
    if (enriched?.type !== "triggerNode") return null;
    return enriched.data.uiTriggerConfig.entryPointType === "whatsapp_qr"
      ? null
      : { id: enriched.id, data: enriched.data };
  }, [ctx, nodes]);

  if (!selected) return null;
  return (
    <TriggerEditorPanel
      key={`${ctx.scenarioSessionOwnerKey}:${selected.id}`}
      nodeId={selected.id}
      data={selected.data}
      businessEventCatalog={ctx.businessEventCatalog}
      onRefreshBusinessEventCatalog={ctx.refreshBusinessEventCatalog}
      onClose={() => ctx.callbacksRef.current.selectNodeById(null)}
    />
  );
}

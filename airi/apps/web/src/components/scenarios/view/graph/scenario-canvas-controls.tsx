"use client";
import {
  ScenarioGraphRedoButton,
  ScenarioGraphUndoButton,
} from "./undo-context";

import { Panel, useReactFlow, useViewport } from "@xyflow/react";
import { Maximize, Minus, Plus, Workflow } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

export function ScenarioCanvasControls({
  autoLayoutEnabled,
  onAutoLayoutChange,
}: {
  autoLayoutEnabled?: boolean;
  onAutoLayoutChange?: (enabled: boolean) => void;
}) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  const t = useTranslations("Scenarios");
  return (
    <Panel position="bottom-right" className="!m-3 max-w-[calc(100%_-_24px)]">
      <div
        role="group"
        aria-label={t("canvasControls")}
        className="nodrag nopan flex flex-wrap items-center justify-center gap-x-1 rounded-lg border bg-background p-1 shadow-sm"
      >
        <div className="flex shrink-0 items-center empty:hidden">
          <ScenarioGraphUndoButton iconOnly />
          <ScenarioGraphRedoButton />
          {onAutoLayoutChange && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("canvasAutoLayout")}
              title={t("canvasAutoLayout")}
              aria-pressed={autoLayoutEnabled}
              className={
                autoLayoutEnabled ? "text-primary bg-primary/10" : undefined
              }
              onClick={() => onAutoLayoutChange(!autoLayoutEnabled)}
            >
              <Workflow className="size-4" />
            </Button>
          )}
        </div>
        <fieldset className="m-0 flex shrink-0 items-center border-0 p-0">
          <legend className="sr-only">{t("canvasZoomControls")}</legend>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10"
            disabled={zoom <= 0.1}
            title={t("canvasZoomOut")}
            aria-label={t("canvasZoomOut")}
            onClick={() => void zoomOut({ duration: 150 })}
          >
            <Minus className="size-4" />
          </Button>
          <span
            className="w-12 text-center text-xs tabular-nums text-muted-foreground"
            aria-live="polite"
          >
            {Math.round(zoom * 100)}%
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10"
            disabled={zoom >= 1.6}
            title={t("canvasZoomIn")}
            aria-label={t("canvasZoomIn")}
            onClick={() => void zoomIn({ duration: 150 })}
          >
            <Plus className="size-4" />
          </Button>
          <div className="mx-1 h-5 border-l" />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10"
            title={t("canvasFitView")}
            aria-label={t("canvasFitView")}
            onClick={() =>
              void fitView({
                padding: 0.25,
                minZoom: 0.1,
                maxZoom: 1,
                duration: 200,
              })
            }
          >
            <Maximize className="size-4" />
          </Button>
        </fieldset>
      </div>
    </Panel>
  );
}

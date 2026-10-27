"use client";

import { createContext, useContext } from "react";
import { useTranslations } from "next-intl";
import { Redo2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ScenarioGraphHistoryControls = {
  undo: () => boolean;
  redo: () => boolean;
  canUndo: boolean;
  canRedo: boolean;
};

/** Long enough to notice the toast and press Undo. */
export const SCENARIO_UNDO_TOAST_DURATION_MS = 8000;

export const ScenarioGraphUndoContext = createContext<
  (() => boolean) | ScenarioGraphHistoryControls | undefined
>(undefined);

export function ScenarioGraphUndoButton({
  iconOnly = false,
}: {
  iconOnly?: boolean;
}) {
  const history = useContext(ScenarioGraphUndoContext);
  const t = useTranslations("Scenarios");
  if (!history) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size={iconOnly ? "icon" : "sm"}
      aria-label={t("whatsappServiceUndo")}
      disabled={typeof history === "function" ? false : !history.canUndo}
      onClick={() =>
        typeof history === "function" ? history() : history.undo()
      }
      title={t("whatsappServiceUndo")}
    >
      <Undo2 className="size-4" />
      {iconOnly ? null : t("whatsappServiceUndo")}
    </Button>
  );
}

export function ScenarioGraphRedoButton() {
  const history = useContext(ScenarioGraphUndoContext);
  const t = useTranslations("Scenarios");
  if (!history || typeof history === "function") return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      disabled={!history.canRedo}
      aria-label={t("canvasRedo")}
      title={t("canvasRedo")}
      onClick={() => history.redo()}
    >
      <Redo2 className="size-4" />
    </Button>
  );
}

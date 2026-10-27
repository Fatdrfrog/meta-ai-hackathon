"use client";

import { useMemo } from "react";
import { TemplateFlowHealthNotice } from "@/components/whatsapp-templates/template-flow-health-notice";
import type { useTemplateFlowFacts } from "@/hooks/use-template-flow-facts";
import {
  collectTemplateFlowIds,
  evaluateTemplateFlowHealth,
} from "@/lib/whatsapp/flows/template-flow-health";

type TemplateFlowFactsReader = Pick<
  ReturnType<typeof useTemplateFlowFacts>,
  "factsByFlowId" | "refresh" | "isRefreshing"
>;

/**
 * Warns on a template action when customers can't open its Flow button:
 * the Flow lost the button's screen, isn't published, or is gone.
 */
export function ActionNodeWhatsAppTemplateFlowHealth({
  components,
  flowFacts,
}: {
  /** The live catalog template when known, else the node's saved copy. */
  components: unknown;
  /**
   * The step's facts about its forms, shared with the first screen field so
   * "Check again" and "Reload screens" update both.
   */
  flowFacts: TemplateFlowFactsReader;
}) {
  const flowIds = useMemo(
    () => collectTemplateFlowIds(components),
    [components]
  );
  const { factsByFlowId, refresh, isRefreshing } = flowFacts;
  const health = useMemo(
    () => evaluateTemplateFlowHealth(components, factsByFlowId),
    [components, factsByFlowId]
  );

  return (
    <TemplateFlowHealthNotice
      health={health}
      variant="panel"
      className="w-full"
      checking={isRefreshing(flowIds)}
      onCheckAgain={() => void refresh(flowIds)}
    />
  );
}

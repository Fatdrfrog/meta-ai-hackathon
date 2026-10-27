import {
  isWhatsAppTemplateFormSubmittedSourceHandleId,
  parseFlowBranchSourceHandleId,
  parseTelegramBranchSourceHandleId,
  parseWhatsAppSessionChoiceSourceHandleId,
  parseWhatsAppTemplateButtonSourceHandleId,
} from "@icecore/scenario-contracts";
import { useMemo } from "react";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";

type LazyActionNodeSection = "serviceMessage" | "template" | "telegram";

/** Which route dots each lazily loaded editor section draws. */
const SECTION_OWNS_ROUTE_HANDLE: Record<
  LazyActionNodeSection,
  (handleId: string) => boolean
> = {
  serviceMessage: handleId =>
    Boolean(
      parseWhatsAppSessionChoiceSourceHandleId(handleId) ||
        parseFlowBranchSourceHandleId(handleId)
    ),
  template: handleId =>
    Boolean(
      parseWhatsAppTemplateButtonSourceHandleId(handleId) ||
        parseFlowBranchSourceHandleId(handleId) ||
        isWhatsAppTemplateFormSubmittedSourceHandleId(handleId)
    ),
  telegram: handleId => Boolean(parseTelegramBranchSourceHandleId(handleId)),
};

export type LazySectionRouteHandles = Readonly<
  Record<LazyActionNodeSection, readonly string[]>
>;

/**
 * The linked routes whose dots a lazily loaded section draws, by section.
 * While a section downloads, its placeholder anchors these routes so their
 * edges draw (and React Flow finds their handles). Routes the step draws
 * elsewhere are left out, so no handle id renders twice.
 */
export function listLazySectionRouteHandles(
  connectedHandleIds: readonly string[],
  shownElsewhere: readonly string[]
): LazySectionRouteHandles {
  const linked = connectedHandleIds.filter(
    handleId => !shownElsewhere.includes(handleId)
  );
  const routesOf = (section: LazyActionNodeSection) =>
    linked.filter(SECTION_OWNS_ROUTE_HANDLE[section]);
  return {
    serviceMessage: routesOf("serviceMessage"),
    template: routesOf("template"),
    telegram: routesOf("telegram"),
  };
}

export function useLazySectionRouteHandles(
  nodeData: ScenarioActionEditorNodeData,
  shownElsewhere: {
    hiddenHandleIds?: readonly string[];
    sourceHandles?: readonly { id: string }[];
  }
): LazySectionRouteHandles {
  const { hiddenHandleIds, sourceHandles } = shownElsewhere;
  const connectedHandleIds = nodeData.uiConnections.sourceHandleIds;
  return useMemo(
    () =>
      listLazySectionRouteHandles(connectedHandleIds, [
        ...(hiddenHandleIds ?? []),
        ...(sourceHandles ?? []).map(handle => handle.id),
      ]),
    [connectedHandleIds, hiddenHandleIds, sourceHandles]
  );
}

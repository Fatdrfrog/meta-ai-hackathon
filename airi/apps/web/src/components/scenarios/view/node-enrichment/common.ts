import type { ScenarioNodeEnrichmentContextValue } from "../scenario-node-enrichment-context";
import type { ScenarioEditorNodeBase } from "./types";

/** What every node's shared commands read from the enrichment context. */
export type ScenarioCommonEnrichmentView = Pick<
  ScenarioNodeEnrichmentContextValue,
  | "validationMode"
  | "nodeSettingsPanelEnabled"
  | "callbacksRef"
  | "nodeSettingsFocusRequestRef"
>;

export type ScenarioSourceHandleEnrichmentView = Pick<
  ScenarioNodeEnrichmentContextValue,
  "openNodePickerFromHandle"
>;

export function selectCommonEnrichmentView(
  ctx: ScenarioNodeEnrichmentContextValue
): ScenarioCommonEnrichmentView {
  return {
    validationMode: ctx.validationMode,
    nodeSettingsPanelEnabled: ctx.nodeSettingsPanelEnabled,
    callbacksRef: ctx.callbacksRef,
    nodeSettingsFocusRequestRef: ctx.nodeSettingsFocusRequestRef,
  };
}

/** The selected node id when it is `nodeId`, so other selections match. */
export function selectOwnNodeId(
  selectedNodeId: string | null | undefined,
  nodeId: string
): string | null {
  return selectedNodeId === nodeId ? nodeId : null;
}

export function buildCommonNodeEnrichment(
  nodeId: string,
  ctx: ScenarioCommonEnrichmentView
): Pick<
  ScenarioEditorNodeBase,
  | "uiOnSelect"
  | "uiOnOpenSettings"
  | "uiOnPatch"
  | "uiOnRemove"
  | "uiUsesSettingsPanel"
  | "uiValidationMode"
> {
  return {
    uiValidationMode: ctx.validationMode,
    uiUsesSettingsPanel: ctx.nodeSettingsPanelEnabled === true,
    uiOnSelect: () => ctx.callbacksRef.current.selectNodeById(nodeId),
    uiOnOpenSettings: ({ moveFocus }) => {
      ctx.nodeSettingsFocusRequestRef.current = moveFocus ? nodeId : null;
      ctx.callbacksRef.current.selectNodeById(nodeId);
    },
    uiOnPatch: patch => ctx.callbacksRef.current.updateNodeById(nodeId, patch),
    uiOnRemove: () => ctx.callbacksRef.current.removeNodeById(nodeId),
  };
}

export function buildSourceHandleEnrichment(
  nodeId: string,
  ctx: ScenarioSourceHandleEnrichmentView
): Required<Pick<ScenarioEditorNodeBase, "uiOnCreateNodeFromSourceHandle">> {
  return {
    uiOnCreateNodeFromSourceHandle: (sourceHandleId, clientX, clientY) =>
      ctx.openNodePickerFromHandle(nodeId, sourceHandleId, clientX, clientY),
  };
}

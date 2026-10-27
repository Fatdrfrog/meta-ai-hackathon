import { normalizeScenarioTriggerConfig } from "@/lib/scenarios/trigger-utils";
import type { ScenarioNodeEnrichmentContextValue } from "../scenario-node-enrichment-context";
import {
  buildCommonNodeEnrichment,
  buildSourceHandleEnrichment,
  selectCommonEnrichmentView,
  selectOwnNodeId,
  type ScenarioCommonEnrichmentView,
  type ScenarioSourceHandleEnrichmentView,
} from "./common";
import type {
  ScenarioPersistedNodeDataOfKind,
  ScenarioTriggerEditorNodeData,
} from "./types";

export type ScenarioTriggerEnrichmentView = ScenarioCommonEnrichmentView &
  ScenarioSourceHandleEnrichmentView &
  Pick<
    ScenarioNodeEnrichmentContextValue,
    | "t"
    | "workspaceId"
    | "audienceOptions"
    | "selectedNodeId"
    | "sourceCapabilities"
    | "getWhatsAppQrPickerProps"
  >;

export function resolveTriggerLabel(
  t: (key: string) => string,
  entryPointType?: string | null
): string {
  if (entryPointType === "business_event")
    return t("presetTriggerBusinessEvent");
  if (entryPointType === "customer_behavior")
    return t("presetTriggerCustomerBehavior");
  if (entryPointType === "whatsapp_qr") {
    return t("presetTriggerWhatsAppQr");
  }
  return t("presetTriggerIncoming");
}

const NO_WHATSAPP_QR_PICKER: ScenarioTriggerEnrichmentView["getWhatsAppQrPickerProps"] =
  () => null;

/**
 * What a trigger reads from the context. A QR trigger's picker props read
 * live save state when enriched, so no view can stand in for them: it has
 * none and is enriched again on every pass.
 */
export function selectTriggerEnrichmentView(
  nodeId: string,
  rawData: ScenarioPersistedNodeDataOfKind<"trigger">,
  ctx: ScenarioNodeEnrichmentContextValue
): ScenarioTriggerEnrichmentView | null {
  const triggerConfig = normalizeScenarioTriggerConfig({ nodeData: rawData });
  if (triggerConfig.entryPointType === "whatsapp_qr") return null;
  return {
    ...selectCommonEnrichmentView(ctx),
    openNodePickerFromHandle: ctx.openNodePickerFromHandle,
    t: ctx.t,
    workspaceId: ctx.workspaceId,
    audienceOptions: ctx.audienceOptions,
    selectedNodeId: selectOwnNodeId(ctx.selectedNodeId, nodeId),
    sourceCapabilities: ctx.sourceCapabilities,
    getWhatsAppQrPickerProps: NO_WHATSAPP_QR_PICKER,
  };
}

export function enrichTriggerNodeData(
  nodeId: string,
  rawData: ScenarioPersistedNodeDataOfKind<"trigger">,
  ctx: ScenarioTriggerEnrichmentView
): ScenarioTriggerEditorNodeData {
  const triggerConfig = normalizeScenarioTriggerConfig({ nodeData: rawData });
  const isWhatsAppQr = triggerConfig.entryPointType === "whatsapp_qr";

  return {
    ...rawData,
    ...buildCommonNodeEnrichment(nodeId, ctx),
    ...buildSourceHandleEnrichment(nodeId, ctx),
    uiNodeLabel: resolveTriggerLabel(ctx.t, triggerConfig.entryPointType),
    uiWorkspaceId: ctx.workspaceId,
    uiAudienceOptions: ctx.audienceOptions,
    uiIsEditorExpanded: isWhatsAppQr ? false : ctx.selectedNodeId === nodeId,
    uiHasMetaAdsConnection: ctx.sourceCapabilities.hasMetaAds,
    uiTriggerConfig: triggerConfig,
    uiOnTriggerConfigChange: patch =>
      ctx.callbacksRef.current.updateTriggerConfigById(nodeId, patch),
    ...(isWhatsAppQr
      ? {
          uiWhatsAppQrPicker: ctx.getWhatsAppQrPickerProps(nodeId),
        }
      : {}),
  };
}

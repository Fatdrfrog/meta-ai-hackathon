import "server-only";

import {
  extractWhatsAppQrReference,
  normalizeWhatsAppQrEntryPointId,
} from "@icecore/scenario-contracts";
import { Types } from "mongoose";
import connectDB from "@/lib/mongoose";
import { resolveScenarioTrigger } from "@/lib/scenarios/trigger-utils";
import {
  findWhatsAppQrCodeByReference,
  findWhatsAppQrEntryPointByNode,
} from "@/lib/whatsapp/qr-entry-points/queries";
import { Scenario } from "@/models/scenario";
import type { WhatsAppQrCodeRecord } from "@/models/whatsapp-qr-code";
import {
  WhatsAppQrEntryPoint,
  type WhatsAppQrEntryPointRecord,
} from "@/models/whatsapp-qr-entry-point";

export type WhatsAppQrScenarioAnchorNone = {
  kind: "none";
  effectiveText: string;
};

export type WhatsAppQrScenarioAnchorFailClosed = {
  kind: "fail_closed";
  effectiveText: string;
  reason: string;
  scenarioId?: string;
  scenarioName?: string;
  nodeId?: string;
  entryPointId?: string;
  codeId?: string;
};

export type WhatsAppQrScenarioAnchorSuccess = {
  kind: "anchored";
  effectiveText: string;
  scenarioId: string;
  nodeId: string;
  entryPointId: string;
  codeId: string;
  referencePresent: true;
};

export type WhatsAppQrScenarioAnchorResult =
  | WhatsAppQrScenarioAnchorNone
  | WhatsAppQrScenarioAnchorFailClosed
  | WhatsAppQrScenarioAnchorSuccess;

export type WhatsAppQrLoadedScenario = {
  scenarioId: string;
  name: string;
  status: string;
  deletedAt?: Date | string | null;
  nodes: Array<{ id: string; data?: unknown }>;
};

export type WhatsAppQrLoadedTrigger = {
  nodeId: string;
  enabled: boolean;
  entryPointType?: string;
  entryPointId?: string;
  entryPointIdMalformed?: boolean;
};

export const WHATSAPP_QR_RUNTIME_MISSING_POINTER_FALLBACK_ENABLED = true;

export type ResolveWhatsAppQrScenarioAnchorParams = {
  workspaceId: string;
  sourceId: string;
  messageText: string;
  loadCode?: (params: {
    workspaceId: string;
    sourceId: string;
    referenceCode: string;
  }) => Promise<WhatsAppQrCodeRecord | null>;
  loadEntryPoint?: (params: {
    workspaceId: string;
    entryPointId: string;
  }) => Promise<WhatsAppQrEntryPointRecord | null>;
  loadScenario?: (params: {
    workspaceId: string;
    scenarioId: string;
  }) => Promise<WhatsAppQrLoadedScenario | null>;
  loadTriggerNode?: (params: {
    scenario: WhatsAppQrLoadedScenario;
    nodeId: string;
  }) => Promise<WhatsAppQrLoadedTrigger | null>;
  loadLegacyEntryPointByNode?: (params: {
    workspaceId: string;
    scenarioId: string;
    nodeId: string;
  }) => Promise<WhatsAppQrEntryPointRecord | null>;
  allowLegacyMissingPointerFallback?: boolean;
};

function failClosed(
  effectiveText: string,
  reason: string,
  attribution?: {
    scenarioId?: string;
    scenarioName?: string;
    nodeId?: string;
    entryPointId?: string;
    codeId?: string;
  }
): WhatsAppQrScenarioAnchorFailClosed {
  return {
    kind: "fail_closed",
    effectiveText,
    reason,
    ...(attribution?.scenarioId ? { scenarioId: attribution.scenarioId } : {}),
    ...(attribution?.scenarioName
      ? { scenarioName: attribution.scenarioName }
      : {}),
    ...(attribution?.nodeId ? { nodeId: attribution.nodeId } : {}),
    ...(attribution?.entryPointId
      ? { entryPointId: attribution.entryPointId }
      : {}),
    ...(attribution?.codeId ? { codeId: attribution.codeId } : {}),
  };
}

async function defaultLoadCode(params: {
  workspaceId: string;
  sourceId: string;
  referenceCode: string;
}): Promise<WhatsAppQrCodeRecord | null> {
  return findWhatsAppQrCodeByReference(params);
}

async function defaultLoadEntryPoint(params: {
  workspaceId: string;
  entryPointId: string;
}): Promise<WhatsAppQrEntryPointRecord | null> {
  await connectDB();
  return WhatsAppQrEntryPoint.findOne({
    workspaceId: params.workspaceId,
    entryPointId: params.entryPointId,
  }).lean<WhatsAppQrEntryPointRecord | null>();
}

async function defaultLoadScenario(params: {
  workspaceId: string;
  scenarioId: string;
}): Promise<WhatsAppQrLoadedScenario | null> {
  if (!Types.ObjectId.isValid(params.scenarioId)) return null;
  await connectDB();
  const scenario = await Scenario.findOne({
    _id: params.scenarioId,
    workspaceId: params.workspaceId,
  })
    .select("_id name status deletedAt nodes")
    .lean<{
      _id: { toString(): string } | string;
      name?: string;
      status?: string;
      deletedAt?: Date | string | null;
      nodes?: Array<{ id: string; data?: unknown }>;
    } | null>();
  if (!scenario) return null;
  return {
    scenarioId: String(scenario._id),
    name:
      typeof scenario.name === "string" && scenario.name.trim()
        ? scenario.name.trim()
        : "Scenario",
    status: typeof scenario.status === "string" ? scenario.status : "draft",
    deletedAt: scenario.deletedAt ?? null,
    nodes: Array.isArray(scenario.nodes) ? scenario.nodes : [],
  };
}

async function defaultLoadTriggerNode(params: {
  scenario: WhatsAppQrLoadedScenario;
  nodeId: string;
}): Promise<WhatsAppQrLoadedTrigger | null> {
  const node = params.scenario.nodes.find(
    candidate => candidate.id === params.nodeId
  );
  if (!node) return null;
  const nodeData =
    node.data !== null &&
    typeof node.data === "object" &&
    !Array.isArray(node.data)
      ? (node.data as Record<string, unknown>)
      : null;
  if (nodeData?.kind !== "trigger") return null;

  const triggerConfig = resolveScenarioTrigger(node.data);
  const rawTriggerConfig =
    nodeData.triggerConfig !== null &&
    typeof nodeData.triggerConfig === "object" &&
    !Array.isArray(nodeData.triggerConfig)
      ? (nodeData.triggerConfig as Record<string, unknown>)
      : null;
  const rawEntryPointId = rawTriggerConfig?.entryPointId;
  const entryPointId = normalizeWhatsAppQrEntryPointId(
    triggerConfig.entryPointId
  );
  const rawEntryPointIdIsNonempty =
    typeof rawEntryPointId === "string"
      ? rawEntryPointId.trim().length > 0
      : rawEntryPointId !== undefined && rawEntryPointId !== null;
  return {
    nodeId: params.nodeId,
    enabled: triggerConfig.enabled !== false,
    ...(triggerConfig.entryPointType
      ? { entryPointType: triggerConfig.entryPointType }
      : {}),
    ...(entryPointId ? { entryPointId } : {}),
    ...(rawEntryPointIdIsNonempty && !entryPointId
      ? { entryPointIdMalformed: true }
      : {}),
  };
}

async function defaultLoadLegacyEntryPointByNode(params: {
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
}): Promise<WhatsAppQrEntryPointRecord | null> {
  return findWhatsAppQrEntryPointByNode(params);
}

export async function resolveWhatsAppQrScenarioAnchor(
  params: ResolveWhatsAppQrScenarioAnchorParams
): Promise<WhatsAppQrScenarioAnchorResult> {
  const workspaceId =
    typeof params.workspaceId === "string" ? params.workspaceId.trim() : "";
  const sourceId =
    typeof params.sourceId === "string" ? params.sourceId.trim() : "";
  const messageText =
    typeof params.messageText === "string" ? params.messageText : "";

  if (!workspaceId || !sourceId) {
    return { kind: "none", effectiveText: messageText };
  }

  const extracted = extractWhatsAppQrReference(messageText);
  const effectiveText = extracted.effectiveText;

  if (!extracted.referenceCode) {
    if (extracted.effectiveText !== extracted.rawText) {
      return failClosed(effectiveText, "ambiguous_reference");
    }
    return { kind: "none", effectiveText };
  }

  const loadCode = params.loadCode ?? defaultLoadCode;
  const loadEntryPoint = params.loadEntryPoint ?? defaultLoadEntryPoint;
  const loadScenario = params.loadScenario ?? defaultLoadScenario;
  const loadTriggerNode = params.loadTriggerNode ?? defaultLoadTriggerNode;
  const loadLegacyEntryPointByNode =
    params.loadLegacyEntryPointByNode ?? defaultLoadLegacyEntryPointByNode;
  const allowLegacyMissingPointerFallback =
    params.allowLegacyMissingPointerFallback ??
    WHATSAPP_QR_RUNTIME_MISSING_POINTER_FALLBACK_ENABLED;

  const code = await loadCode({
    workspaceId,
    sourceId,
    referenceCode: extracted.referenceCode,
  });
  if (!code) {
    return failClosed(effectiveText, "unknown_reference");
  }

  const codeAttribution = {
    entryPointId: code.entryPointId,
    codeId: code.codeId,
  };

  if (code.sourceId !== sourceId) {
    return failClosed(effectiveText, "source_mismatch", codeAttribution);
  }
  if (code.routingState !== "ENABLED") {
    return failClosed(effectiveText, "routing_disabled", codeAttribution);
  }
  if (code.providerState !== "ACTIVE") {
    return failClosed(effectiveText, "provider_inactive", codeAttribution);
  }
  // CURRENT + HISTORICAL remain routable; DETACHED fails closed.
  if (code.placementBindingState === "DETACHED") {
    return failClosed(effectiveText, "not_current", codeAttribution);
  }
  if (
    code.placementBindingState !== "CURRENT" &&
    code.placementBindingState !== "HISTORICAL"
  ) {
    return failClosed(effectiveText, "not_current", codeAttribution);
  }

  const entryPoint = await loadEntryPoint({
    workspaceId,
    entryPointId: code.entryPointId,
  });
  if (!entryPoint) {
    return failClosed(effectiveText, "entry_missing", codeAttribution);
  }
  if (entryPoint.entryPointId !== code.entryPointId) {
    return failClosed(effectiveText, "entry_missing", codeAttribution);
  }
  if (
    (entryPoint.assignmentState !== undefined &&
      entryPoint.assignmentState !== "assigned") ||
    typeof entryPoint.scenarioId !== "string" ||
    !entryPoint.scenarioId ||
    entryPoint.scenarioId.trim() !== entryPoint.scenarioId ||
    typeof entryPoint.nodeId !== "string" ||
    !entryPoint.nodeId ||
    entryPoint.nodeId.trim() !== entryPoint.nodeId
  ) {
    return failClosed(effectiveText, "entry_unassigned", {
      ...codeAttribution,
      entryPointId: entryPoint.entryPointId,
    });
  }

  const entryAttribution = {
    ...codeAttribution,
    scenarioId: entryPoint.scenarioId,
    nodeId: entryPoint.nodeId,
    entryPointId: entryPoint.entryPointId,
  };

  if (entryPoint.status === "DETACHED") {
    return failClosed(effectiveText, "entry_detached", entryAttribution);
  }
  if (entryPoint.status !== "ACTIVE") {
    return failClosed(effectiveText, "entry_inactive", entryAttribution);
  }
  if (entryPoint.sourceId && entryPoint.sourceId !== sourceId) {
    return failClosed(effectiveText, "source_mismatch", entryAttribution);
  }

  const scenario = await loadScenario({
    workspaceId,
    scenarioId: entryPoint.scenarioId,
  });
  if (!scenario || scenario.deletedAt) {
    return failClosed(effectiveText, "scenario_missing", entryAttribution);
  }

  const scenarioAttribution = {
    ...entryAttribution,
    scenarioId: scenario.scenarioId,
    scenarioName: scenario.name,
  };

  if (scenario.status !== "active") {
    return failClosed(effectiveText, "scenario_inactive", scenarioAttribution);
  }

  const trigger = await loadTriggerNode({
    scenario,
    nodeId: entryPoint.nodeId,
  });
  if (!trigger) {
    return failClosed(effectiveText, "trigger_missing", scenarioAttribution);
  }
  if (!trigger.enabled) {
    return failClosed(effectiveText, "trigger_disabled", scenarioAttribution);
  }
  if (trigger.entryPointType !== "whatsapp_qr") {
    return failClosed(effectiveText, "trigger_wrong_type", scenarioAttribution);
  }
  if (trigger.entryPointIdMalformed) {
    return failClosed(
      effectiveText,
      "trigger_entry_point_mismatch",
      scenarioAttribution
    );
  }
  if (trigger.entryPointId) {
    if (trigger.entryPointId !== entryPoint.entryPointId) {
      return failClosed(
        effectiveText,
        "trigger_entry_point_mismatch",
        scenarioAttribution
      );
    }
  } else {
    if (!allowLegacyMissingPointerFallback) {
      return failClosed(
        effectiveText,
        "trigger_entry_point_mismatch",
        scenarioAttribution
      );
    }
    const legacyProjection = await loadLegacyEntryPointByNode({
      workspaceId,
      scenarioId: scenario.scenarioId,
      nodeId: trigger.nodeId,
    });
    if (
      !legacyProjection ||
      legacyProjection.entryPointId !== entryPoint.entryPointId ||
      legacyProjection.scenarioId !== scenario.scenarioId ||
      legacyProjection.nodeId !== trigger.nodeId
    ) {
      return failClosed(
        effectiveText,
        "trigger_entry_point_mismatch",
        scenarioAttribution
      );
    }
  }

  return {
    kind: "anchored",
    effectiveText,
    scenarioId: scenario.scenarioId,
    nodeId: entryPoint.nodeId,
    entryPointId: entryPoint.entryPointId,
    codeId: code.codeId,
    referencePresent: true,
  };
}

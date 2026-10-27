export type WhatsAppQrReadiness =
  | "ready"
  | "draft"
  | "reconciling"
  | "detached"
  | "unhealthy";

type WhatsAppQrReadinessEntryPoint = {
  entryPointId: string;
  workspaceId: string;
  status: string;
  sourceId?: string;
  wabaId?: string;
  phoneNumberId?: string;
  currentCodeId?: string;
};

type WhatsAppQrReadinessCode = {
  codeId: string;
  workspaceId: string;
  entryPointId: string;
  sourceId: string;
  wabaId: string;
  phoneNumberId: string;
  providerCode?: string;
  deepLink?: string;
  placementBindingState: string;
  routingState: string;
  providerState: string;
};

function isCanonicalString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

export function isReadyActiveWhatsAppQrEntryPoint(
  entryPoint: WhatsAppQrReadinessEntryPoint,
  currentCode: WhatsAppQrReadinessCode | null | undefined
): boolean {
  return (
    entryPoint.status === "ACTIVE" &&
    isCanonicalString(entryPoint.sourceId) &&
    isCanonicalString(entryPoint.wabaId) &&
    isCanonicalString(entryPoint.phoneNumberId) &&
    isCanonicalString(entryPoint.currentCodeId) &&
    currentCode != null &&
    currentCode.workspaceId === entryPoint.workspaceId &&
    currentCode.entryPointId === entryPoint.entryPointId &&
    currentCode.codeId === entryPoint.currentCodeId &&
    currentCode.sourceId === entryPoint.sourceId &&
    currentCode.wabaId === entryPoint.wabaId &&
    currentCode.phoneNumberId === entryPoint.phoneNumberId &&
    currentCode.placementBindingState === "CURRENT" &&
    currentCode.routingState === "ENABLED" &&
    currentCode.providerState === "ACTIVE" &&
    isCanonicalString(currentCode.providerCode) &&
    isCanonicalString(currentCode.deepLink)
  );
}

export function resolveWhatsAppQrReadiness(params: {
  entryPoint: WhatsAppQrReadinessEntryPoint;
  currentCode: WhatsAppQrReadinessCode | null | undefined;
  reconcilePending: boolean;
}): WhatsAppQrReadiness {
  const { entryPoint, currentCode, reconcilePending } = params;
  if (reconcilePending) return "reconciling";
  if (entryPoint.status === "DETACHED") return "detached";
  if (entryPoint.status === "DRAFT") return "draft";
  return isReadyActiveWhatsAppQrEntryPoint(entryPoint, currentCode)
    ? "ready"
    : "unhealthy";
}

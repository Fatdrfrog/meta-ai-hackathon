export function resolveWhatsAppQrScenarioTriggerText(params: {
  channel: unknown;
  sourceId: unknown;
  rawText: string;
  effectiveText: string;
}): string {
  const hasResolvableSource =
    params.channel === "whatsapp" &&
    typeof params.sourceId === "string" &&
    params.sourceId.trim().length > 0;
  return hasResolvableSource ? params.rawText : params.effectiveText;
}

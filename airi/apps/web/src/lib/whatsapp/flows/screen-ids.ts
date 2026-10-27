export function extractWhatsAppFlowScreenIds(flowJson: unknown): string[] {
  if (!flowJson || typeof flowJson !== "object") {
    return [];
  }

  const screens = (flowJson as { screens?: unknown }).screens;
  if (!Array.isArray(screens)) {
    return [];
  }

  return Array.from(
    new Set(
      screens.flatMap(screen => {
        if (!screen || typeof screen !== "object") {
          return [];
        }

        const id = (screen as { id?: unknown }).id;
        return typeof id === "string" && id.trim() ? [id.trim()] : [];
      })
    )
  );
}

export function getFirstWhatsAppFlowScreenId(flowJson: unknown): string | null {
  return extractWhatsAppFlowScreenIds(flowJson)[0] ?? null;
}

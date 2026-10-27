function readErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = (value as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : undefined;
}

export function readTemplateCarouselCountError(
  carouselCardsError: unknown
): string | undefined {
  return readErrorMessage(carouselCardsError);
}

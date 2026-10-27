export function shouldHydrateKBEditorEntity({
  lastHydratedEntityKey,
  nextEntityKey,
}: {
  lastHydratedEntityKey: string | null;
  nextEntityKey: string;
}): boolean {
  return lastHydratedEntityKey !== nextEntityKey;
}

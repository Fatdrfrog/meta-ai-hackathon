export function shouldProcessEvenIfDuplicate(
  messageType: string | undefined,
): boolean {
  return (
    messageType === "edit" ||
    messageType === "revoke" ||
    messageType === "reaction"
  );
}

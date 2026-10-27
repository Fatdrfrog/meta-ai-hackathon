import { coerceNonEmptyString as normalizeOptionalString } from "@icecore/shared/lib/value-utils";

export function isScenarioTimeoutMessageId(value: unknown): boolean {
  return (
    normalizeOptionalString(value)?.startsWith("scenario-timeout:") ?? false
  );
}

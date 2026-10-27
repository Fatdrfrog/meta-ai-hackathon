import { readStringOrEmpty } from "@icecore/shared/lib/value-utils";

/** A Mongo id (or any other value) as a trimmed string; null and undefined give "". */
export function readId(value: unknown): string {
  return readStringOrEmpty(value, { coerce: true, trim: true });
}

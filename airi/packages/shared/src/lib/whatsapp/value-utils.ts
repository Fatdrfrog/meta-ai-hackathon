import {
  asNullableRecord,
  asRecord,
  readNonEmptyString,
  readNonEmptyStringOrUndefined,
  type UnknownRecord,
} from "../value-utils";

export type WhatsAppJsonRecord = UnknownRecord;

export function asWhatsAppRecord(value: unknown): WhatsAppJsonRecord {
  return asRecord(value);
}

export function asNullableWhatsAppRecord(
  value: unknown,
): WhatsAppJsonRecord | null {
  return asNullableRecord(value);
}

export function compactWhatsAppString(value: unknown): string | null {
  return readNonEmptyString(value);
}

export function compactWhatsAppStringOrUndefined(
  value: unknown,
): string | undefined {
  return readNonEmptyStringOrUndefined(value);
}

export function readWhatsAppBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

import { readTrimmedString } from "@icecore/shared/lib/value-utils";

export type InternalLabelOption = {
  id: string;
  name: string;
};

type InternalLabelOptionInput = {
  id?: string | null;
  name?: string | null;
};

const RESERVED_SELECT_VALUES = new Set(["all"]);

function isUsableDynamicSelectValue(value: string): boolean {
  return value.length > 0 && !RESERVED_SELECT_VALUES.has(value);
}

export function normalizeSelectStringOptions(
  values: ReadonlyArray<string | null | undefined>
): string[] {
  const seen = new Set<string>();
  const options: string[] = [];

  for (const rawValue of values) {
    const value = readTrimmedString(rawValue);
    const dedupeKey = value.toLowerCase();

    if (!isUsableDynamicSelectValue(dedupeKey) || seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    options.push(value);
  }

  return options;
}

export function normalizeInternalLabelOptions(
  labels: ReadonlyArray<InternalLabelOptionInput | null | undefined>
): InternalLabelOption[] {
  const seen = new Set<string>();
  const options: InternalLabelOption[] = [];

  for (const label of labels) {
    const name = readTrimmedString(label?.name);
    const dedupeKey = name.toLowerCase();

    if (!isUsableDynamicSelectValue(dedupeKey) || seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    options.push({
      id: readTrimmedString(label?.id) || name,
      name,
    });
  }

  return options;
}

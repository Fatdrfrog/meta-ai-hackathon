import type { StoredWhatsAppFlowFieldMetadataPreview } from "../types/message-preview";
import { isRecord, readTrimmedString } from "./value-utils";

const MAX_STORED_FLOW_FIELDS = 100;
const MAX_STORED_FLOW_OPTIONS_PER_FIELD = 200;

export function buildStoredWhatsAppFlowResponseFieldMetadata(
  flowConfig: unknown,
): StoredWhatsAppFlowFieldMetadataPreview[] | null {
  if (!isRecord(flowConfig) || !Array.isArray(flowConfig.screens)) {
    return null;
  }

  const metadata: StoredWhatsAppFlowFieldMetadataPreview[] = [];

  for (const rawScreen of flowConfig.screens) {
    if (!isRecord(rawScreen)) continue;

    const screenTitle = readTrimmedString(rawScreen.title);
    const fields = Array.isArray(rawScreen.fields) ? rawScreen.fields : [];

    for (const rawField of fields) {
      if (!isRecord(rawField)) continue;

      const id = readTrimmedString(rawField.id);
      if (!id) continue;

      const options = Array.isArray(rawField.options)
        ? rawField.options
            .map((option) => {
              if (!isRecord(option)) return null;
              const optionId = readTrimmedString(option.id);
              const optionTitle = readTrimmedString(option.title);
              if (!optionId || !optionTitle) return null;
              return { id: optionId, title: optionTitle };
            })
            .filter(
              (option): option is { id: string; title: string } =>
                option !== null,
            )
            .slice(0, MAX_STORED_FLOW_OPTIONS_PER_FIELD)
        : [];

      const fieldMetadata: StoredWhatsAppFlowFieldMetadataPreview = {
        id,
        label: readTrimmedString(rawField.label) || null,
        helperText: readTrimmedString(rawField.helperText) || null,
        screenTitle: screenTitle || null,
        options: options.length > 0 ? options : null,
      };

      metadata.push(fieldMetadata);
      if (metadata.length >= MAX_STORED_FLOW_FIELDS) {
        return metadata;
      }
    }
  }

  return metadata.length > 0 ? metadata : null;
}

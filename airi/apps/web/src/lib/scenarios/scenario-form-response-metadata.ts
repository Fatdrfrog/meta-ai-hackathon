import {
  listScenarioActionFormFields,
  type ScenarioActionForm,
} from "@icecore/scenario-contracts";
import { buildStoredWhatsAppFlowResponseFieldMetadata } from "@icecore/shared/lib/whatsapp-flow-response-metadata";
import type { StoredWhatsAppFlowFieldMetadataPreview } from "@icecore/shared/types/message-preview";

/** A sent form's field as its outbound message stores it, with its type. */
export type ScenarioFormResponseFieldMetadata =
  StoredWhatsAppFlowFieldMetadataPreview & { fieldType: string | null };

/**
 * The fields a form's send stores, so its reply reads as the form was sent.
 * A template's saved form and a static-graph Flow list the keys their reply
 * uses; any other Flow config keeps the stored screen fields as they always
 * were, each with its type. Null when the form lists no fields.
 */
export function buildScenarioFormResponseFieldMetadata(
  form: Pick<ScenarioActionForm, "flowConfig" | "fields"> | null | undefined
): ScenarioFormResponseFieldMetadata[] | null {
  if (!form) return null;
  const fields = listScenarioActionFormFields(form);
  if (form.fields || form.flowConfig.flowNavigationMode === "static_graph") {
    return fields.length > 0
      ? fields.map(field => ({
          id: field.responseKey,
          label: field.label,
          helperText: field.description || null,
          screenTitle: null,
          options: field.options.length > 0 ? field.options : null,
          fieldType: field.fieldType,
        }))
      : null;
  }
  const fieldTypes = new Map(
    fields.map(field => [field.responseKey, field.fieldType])
  );
  return (
    buildStoredWhatsAppFlowResponseFieldMetadata(form.flowConfig)?.map(
      field => ({ ...field, fieldType: fieldTypes.get(field.id) ?? null })
    ) ?? null
  );
}

import {
  listScenarioFormFieldsWithCoverage,
  MAX_SCENARIO_FORM_LABEL_CHARACTERS,
  MAX_SCENARIO_WHATSAPP_TEMPLATE_FORM_FIELDS,
  MAX_SCENARIO_WHATSAPP_TEMPLATE_FORM_OPTIONS,
  sliceScenarioAnswerText,
  type ScenarioFormField,
  type ScenarioWhatsAppTemplateForm,
} from "@icecore/scenario-contracts";
import { serializeCanonicalJson } from "@icecore/shared/lib/canonical-json";
import { sha256Hex } from "@icecore/shared/lib/sha256";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";
import { projectFlowJsonPreview } from "@/components/scenarios/builders/whatsapp/flow-json-preview";

/**
 * The answers a template's Flow sends, read from its Flow JSON: a template
 * step's saved form without the Flow id, form key and read time.
 */
export type TemplateFormAnswerSchema = Pick<
  ScenarioWhatsAppTemplateForm,
  "flowName" | "coverage" | "endpoint" | "fields"
> & { digest: string };

type TemplateFormAnswerField = ScenarioWhatsAppTemplateForm["fields"][number];

const MAX_DESCRIPTION_CHARACTERS = 160;
/** The saved fields together, as UTF-8 JSON; later fields are dropped. */
const MAX_FIELDS_BYTES = 32 * 1024;
const BRANCH_COMPONENTS = new Set(["If", "Switch"]);

function boundText(value: string, maxCharacters: number): string {
  const text = value.trim();
  return text.length <= maxCharacters
    ? text
    : `${sliceScenarioAnswerText(text, maxCharacters - 1).trimEnd()}…`;
}

/** A field as the saved form keeps it, so normalizing it changes nothing. */
function boundField(field: ScenarioFormField): TemplateFormAnswerField {
  return {
    responseKey: field.responseKey,
    label: field.label,
    description: boundText(field.description, MAX_DESCRIPTION_CHARACTERS),
    fieldType: field.fieldType,
    required: field.required,
    screenIndex: field.screenIndex,
    options: field.options
      .flatMap(option => {
        const id = option.id.trim();
        const title = boundText(
          option.title,
          MAX_SCENARIO_FORM_LABEL_CHARACTERS
        );
        return id && title ? [{ id, title }] : [];
      })
      .slice(0, MAX_SCENARIO_WHATSAPP_TEMPLATE_FORM_OPTIONS),
    ...(field.conditional ? { conditional: true } : {}),
  };
}

/**
 * The fields a template's Flow asks, for AI steps to read its answers. It
 * reads the Flow JSON the way the Flow preview does, so endpoint Flows and
 * Flows the editor can't import still list what they can.
 *
 * Answers it can't describe are left out: fields shown inside an If or a
 * Switch, or with options from Flow data. Coverage is "partial" when the Flow
 * can send an answer the fields don't list. The digest hashes the fields,
 * coverage and endpoint, so it changes exactly when the saved form would.
 */
export function buildTemplateFormAnswerSchema(params: {
  flowJson: unknown;
  flowName: string | null;
}): TemplateFormAnswerSchema | null {
  const raw = asNullableRecord(params.flowJson);
  const preview = projectFlowJsonPreview(params.flowJson, {
    maxOptions: MAX_SCENARIO_WHATSAPP_TEMPLATE_FORM_OPTIONS,
    keepDynamicallyVisibleFields: true,
  });
  if (!raw || !Array.isArray(raw.screens) || !preview) return null;

  const listing = listScenarioFormFieldsWithCoverage(preview.config);
  const undescribed = new Set(listing.undescribedResponseKeys);
  const listed = listing.fields.filter(
    field => !undescribed.has(field.responseKey)
  );
  const fields: TemplateFormAnswerField[] = [];
  const encoder = new TextEncoder();
  // "[", then each field with the "," or "]" after it.
  let bytes = 1;
  for (const field of listed.slice(
    0,
    MAX_SCENARIO_WHATSAPP_TEMPLATE_FORM_FIELDS
  )) {
    const bounded = boundField(field);
    bytes += encoder.encode(JSON.stringify(bounded)).length + 1;
    if (bytes > MAX_FIELDS_BYTES) break;
    fields.push(bounded);
  }

  const endpoint = Boolean(raw.data_api_version || raw.routing_model);
  const screensById = new Map(
    preview.config.screens.map(screen => [screen.id, screen])
  );
  const partial =
    endpoint ||
    preview.totalScreens > preview.config.screens.length ||
    raw.screens.some(candidate => {
      const screen = asNullableRecord(candidate);
      if (screen?.terminal !== true) return false;
      const projected =
        typeof screen.id === "string" ? screensById.get(screen.id) : null;
      return projected?.footer?.action.name !== "complete";
    }) ||
    Object.values(preview.componentsByScreen).some(components =>
      components.some(
        component =>
          component.kind === "unsupported" &&
          BRANCH_COMPONENTS.has(component.component)
      )
    ) ||
    undescribed.size > 0 ||
    listing.truncated ||
    fields.length < listed.length;
  const coverage = partial ? "partial" : "complete";
  return {
    flowName: params.flowName?.trim() || null,
    digest: sha256Hex(serializeCanonicalJson({ fields, coverage, endpoint })),
    coverage,
    endpoint,
    fields,
  };
}

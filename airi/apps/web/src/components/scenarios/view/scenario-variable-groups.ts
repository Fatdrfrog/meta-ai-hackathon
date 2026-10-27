import {
  scenarioFormAnswerToken,
  scenarioPromptInputToken,
} from "@icecore/scenario-contracts";
import type { TranslateFn } from "../types";
import type { ScenarioFormAnswerChoice } from "./node-enrichment/scenario-node-graph-index";
import { buildScenarioFormAnswerSourceNames } from "./scenario-form-answer-labels";
import {
  SCENARIO_TOKEN_FIELD_META,
  SCENARIO_TOKEN_FIELDS,
  SCENARIO_TOKEN_SOURCE_DESCRIPTION_KEYS,
  SCENARIO_TOKEN_SOURCE_LABEL_KEYS,
  SCENARIO_TOKEN_SOURCE_ORDER,
  type ScenarioTokenSource,
} from "./scenario-template-utils";

/** A Variables menu heading of its own, such as one form's answers. */
export type ScenarioVariableFieldGroup = { id: string; label: string };

export type ScenarioVariableExtraField = {
  token: string;
  label: string;
  /** The answer's question; empty when it has none. */
  description: string;
  /** Its menu heading; "Collected details" when omitted. */
  group?: ScenarioVariableFieldGroup;
  /** A short note beside it, such as "May be empty". */
  badge?: string;
  /**
   * A line that explains its group, such as why a form's fields aren't
   * listed. Arrow keys reach it; picking it inserts nothing. Its token only
   * identifies the row.
   */
  note?: boolean;
  /**
   * A form's text field read as `{{input.<id>}}`. It still renders, but
   * menus offer the form's own answers instead.
   */
  legacy?: boolean;
};

/** A Variables menu row. */
export type ScenarioVariableRowField = Pick<
  ScenarioVariableExtraField,
  "token" | "label" | "description" | "badge" | "note"
>;

export type ScenarioVariableGroup = {
  id: string;
  label: string;
  /** Shown under the heading only where the group needs explaining. */
  description?: string;
  /** Group words that also find its fields in search. */
  keywords: string[];
  fields: ScenarioVariableRowField[];
};

/** A node's scoped collected answers as variable-menu entries. */
export function buildScenarioPromptInputVariableFields(
  fields:
    | ReadonlyArray<{
        key: string;
        label: string;
        prompt: string;
        fromForm?: boolean;
      }>
    | undefined
): ScenarioVariableExtraField[] {
  return (fields ?? []).map(field => ({
    token: scenarioPromptInputToken(field.key),
    label: field.label,
    description: field.prompt.trim(),
    ...(field.fromForm ? { legacy: true } : {}),
  }));
}

/**
 * A field's line under its question: its helper text, or its screen's
 * title. A line another field of the form also has, or the form's own
 * name, doesn't tell the questions apart, so it is left out.
 */
function listFieldDescriptions(
  fields: ScenarioFormAnswerChoice["fields"],
  formName: string
): string[] {
  const counts = new Map<string, number>();
  for (const field of fields) {
    counts.set(field.description, (counts.get(field.description) ?? 0) + 1);
  }
  return fields.map(({ description }) =>
    counts.get(description) === 1 && description !== formName ? description : ""
  );
}

/**
 * The answers of the forms before a node, one menu group per form. A form
 * made in Meta or built only in WhatsApp has one note saying its fields
 * can't be listed, and a form whose fields leave answers out ends with a
 * note saying so.
 */
export function buildScenarioFormAnswerVariableFields(
  sources: readonly ScenarioFormAnswerChoice[] | undefined,
  t: TranslateFn
): ScenarioVariableExtraField[] {
  const names = buildScenarioFormAnswerSourceNames(sources);
  return (sources ?? []).flatMap((source): ScenarioVariableExtraField[] => {
    const name = names.get(source.nodeId) ?? source.formLabel;
    const group = {
      id: `form:${source.nodeId}`,
      label: t("variableGroupForm", { name }),
    };
    const note = (label: string): ScenarioVariableExtraField => ({
      token: `form.${source.formKey || source.nodeId}`,
      label,
      description: "",
      group,
      note: true,
    });
    if (source.schema === "unknown") {
      return [note(t("variableFormFieldsUnknown"))];
    }
    const descriptions = listFieldDescriptions(source.fields, name);
    const fields = source.fields.map((field, index) => ({
      token: scenarioFormAnswerToken(source.formKey, field.key),
      label: field.label,
      description: descriptions[index] ?? "",
      group,
      badge: field.mayBeEmpty ? t("variableFieldMayBeEmpty") : undefined,
    }));
    return source.partial
      ? [...fields, note(t("variableFormFieldsPartial"))]
      : fields;
  });
}

// Only these catalog groups need a line of explanation under their heading.
const SOURCES_WITH_VISIBLE_DESCRIPTION: ReadonlySet<ScenarioTokenSource> =
  new Set(["ads", "calendar", "picked"]);

function buildCatalogGroups(
  excludeSources: readonly ScenarioTokenSource[],
  t: TranslateFn
): ScenarioVariableGroup[] {
  const excluded = new Set(excludeSources);
  return SCENARIO_TOKEN_SOURCE_ORDER.filter(
    source => !excluded.has(source)
  ).map((source): ScenarioVariableGroup => {
    const description = t(SCENARIO_TOKEN_SOURCE_DESCRIPTION_KEYS[source]);
    return {
      id: source,
      label: t(SCENARIO_TOKEN_SOURCE_LABEL_KEYS[source]),
      description: SOURCES_WITH_VISIBLE_DESCRIPTION.has(source)
        ? description
        : undefined,
      keywords: [description],
      fields: SCENARIO_TOKEN_FIELDS[source].map(field => {
        const meta = SCENARIO_TOKEN_FIELD_META[field.token];
        return {
          token: field.token,
          label: t(meta?.labelKey ?? field.value),
          description: meta ? t(meta.descriptionKey) : "",
        };
      }),
    };
  });
}

/** Collected details first, then each field group in the order it appears. */
function buildAnswerGroups(
  extraFields: readonly ScenarioVariableExtraField[],
  t: TranslateFn
): ScenarioVariableGroup[] {
  const collected: ScenarioVariableGroup = {
    id: "prompt_inputs",
    label: t("variableGroupPromptInputs"),
    keywords: [],
    fields: [],
  };
  const groups = new Map([[collected.id, collected]]);
  for (const { group, legacy, ...field } of extraFields) {
    if (legacy) continue;
    const target = group
      ? (groups.get(group.id) ?? { ...group, keywords: [], fields: [] })
      : collected;
    groups.set(target.id, target);
    target.fields.push(field);
  }
  return [...groups.values()].filter(group => group.fields.length > 0);
}

/**
 * The Variables menu: the answers before this step, then the catalog.
 * `answersOnly` leaves out the catalog, for AI instructions, where only
 * answers are filled in.
 */
export function buildScenarioVariableGroups(
  {
    extraFields,
    excludeSources,
    answersOnly,
  }: {
    extraFields: readonly ScenarioVariableExtraField[];
    /** Catalog groups this field never offers. */
    excludeSources: readonly ScenarioTokenSource[];
    answersOnly: boolean;
  },
  t: TranslateFn
): ScenarioVariableGroup[] {
  const answerGroups = buildAnswerGroups(extraFields, t);
  return answersOnly
    ? answerGroups
    : [...answerGroups, ...buildCatalogGroups(excludeSources, t)];
}

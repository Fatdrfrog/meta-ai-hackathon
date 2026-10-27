import {
  findScenarioFormAnswerField,
  findScenarioFormAnswerMetaForm,
  listScenarioFormAnswerTokenReferences,
} from "@/lib/scenarios/scenario-form-answer-checks";
import { scenarioFormAnswerToken } from "@icecore/scenario-contracts";
import type { TranslateFn } from "../types";
import type { ScenarioFormAnswerChoice } from "./node-enrichment/scenario-node-graph-index";

type FormAnswerSources = readonly ScenarioFormAnswerChoice[] | undefined;

/**
 * Each form's name, by sending step: its step's name, else its Flow name.
 * Two forms with the same name also show their key, so they can be told
 * apart.
 */
export function buildScenarioFormAnswerSourceNames(
  sources: FormAnswerSources
): ReadonlyMap<string, string> {
  const names = (sources ?? []).map(source => ({
    source,
    name: source.label || source.formLabel,
  }));
  const counts = new Map<string, number>();
  for (const { name } of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return new Map(
    names.map(({ source, name }) => [
      source.nodeId,
      (counts.get(name) ?? 0) > 1 && source.formKey
        ? `${name} (${source.formKey})`
        : name,
    ])
  );
}

/** "Size · Order details": a form answer on a chip or in a step preview. */
export function formatScenarioFormAnswerChipLabel(
  fieldLabel: string,
  formName: string
): string {
  return `${fieldLabel} · ${formName}`;
}

export type ScenarioFormAnswerChip = {
  token: string;
  label: string;
  /** The step can run without this answer. */
  mayBeEmpty: boolean;
};

/** Every answer the forms before a step give, as one-click chips. */
export function listScenarioFormAnswerChips(
  sources: FormAnswerSources
): ScenarioFormAnswerChip[] {
  const names = buildScenarioFormAnswerSourceNames(sources);
  return (sources ?? []).flatMap(source =>
    source.fields.map(field => ({
      token: scenarioFormAnswerToken(source.formKey, field.key),
      label: formatScenarioFormAnswerChipLabel(
        field.label,
        names.get(source.nodeId) ?? source.formLabel
      ),
      mayBeEmpty: field.mayBeEmpty,
    }))
  );
}

/** The chip label of each form answer before a step, by token. */
export function buildScenarioFormAnswerTokenLabels(
  sources: FormAnswerSources
): ReadonlyMap<string, string> {
  return new Map(
    listScenarioFormAnswerChips(sources).map(chip => [chip.token, chip.label])
  );
}

/** Where the answers go: "AI writes" instructions or an image or video prompt. */
export type ScenarioFormAnswerNoticeConsumer = "ai_reply" | "generative";

export type ScenarioFormAnswerNoticeTexts = Readonly<{
  /** Answers no form before the step gives; they block activation. */
  unavailable: string | null;
  /** Answers the step may run without. */
  mayBeEmpty: string | null;
}>;

/** Past this many items, a notice says how many more there are. */
const MAX_LISTED_FORM_ANSWERS = 3;

function formatCappedList(items: readonly string[], t: TranslateFn): string {
  const listed = items.slice(0, MAX_LISTED_FORM_ANSWERS).join(", ");
  const more = items.length - MAX_LISTED_FORM_ANSWERS;
  return more > 0
    ? `${listed} ${t("formAnswersListMore", { count: more })}`
    : listed;
}

function quote(label: string, t: TranslateFn): string {
  return t("whatsappTemplateButtonQuoted", { label });
}

type FormAnswerEntry = {
  formName: string;
  fieldLabel: string;
  /** The customer can skip the form on the way to the step. */
  skippable: boolean;
};

/** “Order details” (Size, Colour), “Contact” (Email) and 2 more. */
function formatFieldsByForm(
  entries: readonly FormAnswerEntry[],
  t: TranslateFn
): string {
  const byForm = new Map<string, string[]>();
  for (const entry of entries.slice(0, MAX_LISTED_FORM_ANSWERS)) {
    byForm.set(entry.formName, [
      ...(byForm.get(entry.formName) ?? []),
      entry.fieldLabel,
    ]);
  }
  const listed = Array.from(
    byForm,
    ([formName, fields]) => `${quote(formName, t)} (${fields.join(", ")})`
  ).join(", ");
  const more = entries.length - MAX_LISTED_FORM_ANSWERS;
  return more > 0
    ? `${listed} ${t("formAnswersListMore", { count: more })}`
    : listed;
}

function joinSentences(sentences: ReadonlyArray<string | null>): string | null {
  const text = sentences.filter(Boolean).join(" ");
  return text || null;
}

type FormAnswerFindings = {
  missing: string[];
  metaTokens: string[];
  metaForms: string[];
  /** Answers the step may run without, in the prompt's order. */
  mayBeEmpty: FormAnswerEntry[];
};

function collectFormAnswerFindings(
  text: string,
  sources: FormAnswerSources
): FormAnswerFindings {
  const names = buildScenarioFormAnswerSourceNames(sources);
  const findings: FormAnswerFindings = {
    missing: [],
    metaTokens: [],
    metaForms: [],
    mayBeEmpty: [],
  };
  for (const reference of listScenarioFormAnswerTokenReferences(text)) {
    const token = `{{${reference.token}}}`;
    const match = findScenarioFormAnswerField(sources, reference);
    const metaForm = match
      ? null
      : findScenarioFormAnswerMetaForm(sources, reference);
    if (metaForm) {
      findings.metaTokens.push(token);
      findings.metaForms.push(names.get(metaForm.nodeId) ?? "");
    } else if (!match) {
      findings.missing.push(token);
    } else if (match.field.mayBeEmpty) {
      findings.mayBeEmpty.push({
        formName: names.get(match.source.nodeId) ?? match.source.formLabel,
        fieldLabel: match.field.label,
        skippable: match.source.availability === "some_paths",
      });
    }
  }
  return findings;
}

function describeUnavailable(
  findings: FormAnswerFindings,
  t: TranslateFn
): string | null {
  const metaForms = Array.from(new Set(findings.metaForms));
  return joinSentences([
    findings.missing.length > 0
      ? t("formAnswersUnavailableNotice", {
          count: findings.missing.length,
          tokens: formatCappedList(findings.missing, t),
        })
      : null,
    metaForms.length > 0
      ? t("formAnswersMetaFormNotice", {
          formCount: metaForms.length,
          forms: formatCappedList(
            metaForms.map(name => quote(name, t)),
            t
          ),
          tokens: formatCappedList(findings.metaTokens, t),
        })
      : null,
  ]);
}

function describeMayBeEmpty(
  findings: FormAnswerFindings,
  consumer: ScenarioFormAnswerNoticeConsumer,
  t: TranslateFn
): string | null {
  if (consumer === "ai_reply") {
    return findings.mayBeEmpty.length > 0
      ? t("formAnswersMayBeEmptyReply", {
          fields: formatFieldsByForm(findings.mayBeEmpty, t),
        })
      : null;
  }
  // A form the customer never sent makes the image or video step fail;
  // an optional answer of a form every path sends is only empty.
  const skippedForms = Array.from(
    new Set(
      findings.mayBeEmpty.flatMap(entry =>
        entry.skippable ? [entry.formName] : []
      )
    )
  );
  const optional = findings.mayBeEmpty.filter(entry => !entry.skippable);
  return joinSentences([
    skippedForms.length > 0
      ? t("formAnswersMaySkipForm", {
          forms: formatCappedList(
            skippedForms.map(name => quote(name, t)),
            t
          ),
        })
      : null,
    optional.length > 0
      ? t("formAnswersMayBeEmpty", {
          fields: formatFieldsByForm(optional, t),
        })
      : null,
  ]);
}

/**
 * What a prompt's form answers need the merchant to know: answers no form
 * before the step gives, answers of forms made in Meta, and answers that
 * may be empty there.
 */
export function describeScenarioFormAnswerNotices(
  text: string,
  sources: FormAnswerSources,
  consumer: ScenarioFormAnswerNoticeConsumer,
  t: TranslateFn
): ScenarioFormAnswerNoticeTexts {
  const findings = collectFormAnswerFindings(text, sources);
  return {
    unavailable: describeUnavailable(findings, t),
    mayBeEmpty: describeMayBeEmpty(findings, consumer, t),
  };
}

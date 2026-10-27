import type { ScenarioActionRoutingNormalization } from "./scenario-action-routing";
import type { WhatsAppFlowFieldType } from "./scenario-channel-configs";
import { parseWhatsAppFlowPayloadReference } from "./whatsapp-flow-static-graph";
import { readSingleWhatsAppTemplateFlowButtonFlowId } from "./whatsapp-interactive-replies";
import {
  isScenarioPromptInputKey,
  readScenarioActionFlowConfig,
  readScenarioFlowResponseRecord,
} from "./scenario-prompt-inputs";
import { isRecord, readTrimmedString as readText } from "./value-guards";

/*
 * Form answers: what the customer submitted in a scenario's forms (WhatsApp
 * Flows). They are kept per scenario like picked options, the latest
 * submission per sending node, and AI steps read them as
 * `{{form.<formKey>.<fieldKey>}}`. Values are the customer's own words and
 * stay raw here; consumers quote them when they render.
 */

/** Submissions kept for one scenario; the earliest is dropped past this. */
export const MAX_SCENARIO_FORM_SUBMISSIONS = 10;
/** Answers kept per submission; later ones are dropped. */
export const MAX_SCENARIO_FORM_SUBMISSION_FIELDS = 40;
export const MAX_SCENARIO_FORM_ANSWER_CHARACTERS = 1000;
/** All answers of one submission together; the answer that crosses it is cut. */
export const MAX_SCENARIO_FORM_SUBMISSION_CHARACTERS = 8000;
export const MAX_SCENARIO_FORM_LABEL_CHARACTERS = 60;
const MAX_ID_CHARACTERS = 256;
const MAX_SCENARIO_ID_CHARACTERS = 128;
const MAX_KEY_CHARACTERS = 32;

/** Template namespace of form answers: `{{form.<formKey>.<fieldKey>}}`. */
export const SCENARIO_FORM_ANSWER_NAMESPACE = "form";
const SCENARIO_FORM_ANSWER_TOKEN_PREFIX = `${SCENARIO_FORM_ANSWER_NAMESPACE}.`;
const FLOW_TOKEN_KEY = "flow_token";
const DEFAULT_FORM_KEY = "form";
const DEFAULT_FORM_LABEL = "Form";
const DEFAULT_FIELD_KEY = "field";
/** Reply keys that carry no answer unless the form names them as a field. */
const GENERIC_FLOW_RESPONSE_KEYS = new Set([
  "token",
  "message",
  "values",
  "wa_flow_response_keys",
]);

function readId(value: unknown, maxCharacters = MAX_ID_CHARACTERS): string {
  const id = readText(value);
  return id.length <= maxCharacters ? id : "";
}

/**
 * At most `maxCharacters` UTF-16 units of customer text, never cut inside a
 * character: an emoji on the limit is dropped whole, so no half of it
 * reaches storage or a model request.
 */
export function sliceScenarioAnswerText(
  value: string,
  maxCharacters: number,
): string {
  if (value.length <= maxCharacters) return value;
  const end = Math.max(0, maxCharacters);
  const lastUnit = value.charCodeAt(end - 1);
  return value.slice(
    0,
    lastUnit >= 0xd800 && lastUnit <= 0xdbff ? end - 1 : end,
  );
}

/**
 * One line, bounded: labels end up inside "[Form › Field]" references. A
 * long label ends at a word with "…"; one very long word is cut where it is.
 */
function readLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= MAX_SCENARIO_FORM_LABEL_CHARACTERS) return text;
  const cut = sliceScenarioAnswerText(
    text,
    MAX_SCENARIO_FORM_LABEL_CHARACTERS - 1,
  );
  const wordEnd =
    text.charAt(cut.length) === " " ? cut.length : cut.lastIndexOf(" ");
  const kept =
    wordEnd >= MAX_SCENARIO_FORM_LABEL_CHARACTERS / 2
      ? cut.slice(0, wordEnd)
      : cut;
  return `${kept.trimEnd()}…`;
}

function normalizeAnswer(value: string): string {
  return sliceScenarioAnswerText(
    value.replace(/\r\n?/g, "\n").trim(),
    MAX_SCENARIO_FORM_ANSWER_CHARACTERS,
  );
}

/** The key a reply uses for a field; `flow_token` is never an answer. */
function readResponseKey(value: unknown): string {
  const key = readId(value);
  return key === FLOW_TOKEN_KEY ? "" : key;
}

/** Form and field keys follow the answer-key rule: `^[a-z][a-z0-9_]{0,31}$`. */
export function isScenarioFormAnswerKey(value: string): boolean {
  return isScenarioPromptInputKey(value);
}

export function scenarioFormAnswerToken(
  formKey: string,
  fieldKey: string,
): string {
  return `${SCENARIO_FORM_ANSWER_TOKEN_PREFIX}${formKey.trim()}.${fieldKey.trim()}`;
}

/** The form and field an exact `form.<formKey>.<fieldKey>` token names. */
export function parseScenarioFormAnswerToken(
  token: string,
): { formKey: string; fieldKey: string } | null {
  if (!token.startsWith(SCENARIO_FORM_ANSWER_TOKEN_PREFIX)) return null;
  const keys = token.slice(SCENARIO_FORM_ANSWER_TOKEN_PREFIX.length).split(".");
  if (keys.length !== 2) return null;
  const [formKey = "", fieldKey = ""] = keys;
  return isScenarioFormAnswerKey(formKey) && isScenarioFormAnswerKey(fieldKey)
    ? { formKey, fieldKey }
    : null;
}

/** A form answer token whose form the customer has not submitted. */
export class ScenarioFormAnswerMissingError extends Error {
  readonly code = "SCENARIO_FORM_ANSWER_MISSING";

  constructor(readonly token: string) {
    super(`SCENARIO_FORM_ANSWER_MISSING: ${token}`);
    this.name = "ScenarioFormAnswerMissingError";
  }
}

/** Code-based, so a second copy of this module still recognizes the error. */
export function isScenarioFormAnswerMissingError(
  error: unknown,
): error is ScenarioFormAnswerMissingError {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === "SCENARIO_FORM_ANSWER_MISSING"
  );
}

/**
 * The values a Flow reply gave one field: text, a list, or an object naming
 * its selection. Routing matches Flow branches on these, and capture formats
 * them, so both read a reply the same way.
 */
export function normalizeWhatsAppFlowReplyValues(value: unknown): string[] {
  if (
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return [String(value)];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeWhatsAppFlowReplyValues(item));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("selected" in record) {
      return normalizeWhatsAppFlowReplyValues(record.selected);
    }
    if ("value" in record) {
      return normalizeWhatsAppFlowReplyValues(record.value);
    }
    if ("id" in record) {
      return normalizeWhatsAppFlowReplyValues(record.id);
    }
  }

  return [];
}

const SCENARIO_FORM_FIELD_TYPES: ReadonlySet<string> =
  new Set<WhatsAppFlowFieldType>([
    "TextInput",
    "TextArea",
    "Dropdown",
    "RadioButtonsGroup",
    "CheckboxGroup",
    "DatePicker",
  ]);

function readFieldType(value: unknown): WhatsAppFlowFieldType | null {
  return typeof value === "string" && SCENARIO_FORM_FIELD_TYPES.has(value)
    ? (value as WhatsAppFlowFieldType)
    : null;
}

export type ScenarioFormFieldOption = { id: string; title: string };

function readOptions(value: unknown): ScenarioFormFieldOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option) => {
    if (!isRecord(option)) return [];
    const id = readText(option.id);
    const title = readText(option.title);
    return id && title ? [{ id, title }] : [];
  });
}

/** "delivery_address" and "deliveryAddress" both read "Delivery address". */
export function humanizeScenarioAnswerKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[\s_.-]+/g, " ")
    .trim()
    .toLowerCase();
  if (!words) return "Field";
  return readLabel(`${words.charAt(0).toUpperCase()}${words.slice(1)}`);
}

function trimKey(value: string): string {
  return value.slice(0, MAX_KEY_CHARACTERS).replace(/_+$/, "");
}

/**
 * A valid key made from any text: ASCII letters, digits and `_`, led by a
 * letter. Accents are dropped; text with no usable character gives `fallback`.
 */
function slugifyKey(value: string, prefix: string, fallback: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) return fallback;
  return trimKey(/^[a-z]/.test(slug) ? slug : `${prefix}${slug}`);
}

/** `base`, else `base_2`, `base_3`… cut to fit; the key returned is claimed. */
function claimKey(base: string, used: Set<string>): string {
  let key = base;
  for (let copy = 2; used.has(key); copy += 1) {
    const suffix = `_${copy}`;
    key = `${trimKey(base.slice(0, MAX_KEY_CHARACTERS - suffix.length))}${suffix}`;
  }
  used.add(key);
  return key;
}

/**
 * The field key each reply key has in `{{form.<formKey>.<fieldKey>}}`. A key
 * that already fits the rule is its own field key and is claimed first; any
 * other gets an alias: lowercased, other characters as `_`, `f_` in front
 * when it does not start with a letter, cut to 32 characters and made unique
 * in the form with `_2`, `_3`…
 */
export function resolveScenarioFormFieldKeys(
  responseKeys: readonly string[],
): Map<string, string> {
  const keys = new Map<string, string>();
  const used = new Set<string>();
  for (const responseKey of responseKeys) {
    if (
      keys.has(responseKey) ||
      !isScenarioFormAnswerKey(responseKey) ||
      used.has(responseKey)
    ) {
      continue;
    }
    keys.set(responseKey, responseKey);
    used.add(responseKey);
  }
  for (const responseKey of responseKeys) {
    if (keys.has(responseKey)) continue;
    keys.set(
      responseKey,
      claimKey(slugifyKey(responseKey, "f_", DEFAULT_FIELD_KEY), used),
    );
  }
  return keys;
}

/** A question of a form, as its Flow config lists it. */
export type ScenarioFormField = {
  /** The field key in `{{form.<formKey>.<fieldKey>}}`. */
  key: string;
  /** The key the reply uses for this answer: the Flow field id. */
  responseKey: string;
  label: string;
  /** The helper text, else the screen title. */
  description: string;
  fieldType: WhatsAppFlowFieldType;
  required: boolean;
  /** The position of the field's screen in the Flow, from 0. */
  screenIndex: number;
  options: ScenarioFormFieldOption[];
  /** Another completion path can omit this answer entirely. */
  conditional?: boolean;
};

type ListedFormField = Omit<ScenarioFormField, "key">;
/**
 * What the Flow says about an answer. `undescribed`: nothing gave it a label,
 * a type or options, such as `${form.x}` naming a field the config lacks.
 */
type FieldMetadata = Partial<ListedFormField> & { undescribed?: true };
type GraphIncomingAction = {
  source: Record<string, unknown>;
  title: string;
  label: string;
  action: Record<string, unknown>;
};

function isDescribed(metadata: FieldMetadata): boolean {
  return (
    metadata.undescribed !== true &&
    Boolean(metadata.label || metadata.fieldType || metadata.options?.length)
  );
}

function listStaticGraphFormFields(screens: unknown[]): {
  listed: ListedFormField[];
  undescribedResponseKeys: string[];
  truncated: boolean;
} {
  const records = screens.slice(0, 20).filter(isRecord);
  const incoming = new Map<string, GraphIncomingAction[]>();
  for (const source of records) {
    const addAction = (action: unknown, title: string, label: string) => {
      if (!isRecord(action) || action.name !== "navigate") return;
      const target = readText(action.nextScreenId);
      if (!target) return;
      const entries = incoming.get(target) ?? [];
      entries.push({ source, title, label, action });
      incoming.set(target, entries);
    };
    if (isRecord(source.footer))
      addAction(source.footer.action, readText(source.title), "");
    if (!Array.isArray(source.fields)) continue;
    for (const field of source.fields.slice(0, 50)) {
      if (
        !isRecord(field) ||
        field.fieldType !== "NavigationList" ||
        !Array.isArray(field.navigationItems)
      )
        continue;
      for (const item of field.navigationItems.slice(0, 20)) {
        if (isRecord(item))
          addAction(
            item.action,
            readLabel(item.title),
            readLabel(field.label) || readLabel(source.title),
          );
      }
    }
  }

  const fieldMetadata = (
    screen: Record<string, unknown>,
    fieldId: string,
  ): FieldMetadata => {
    const field = Array.isArray(screen.fields)
      ? screen.fields
          .slice(0, 50)
          .find((value) => isRecord(value) && value.id === fieldId)
      : null;
    if (!isRecord(field)) return { required: false };
    return {
      label: readLabel(field.label),
      description: readText(field.helperText) || readText(screen.title),
      fieldType: readFieldType(field.fieldType) ?? "TextInput",
      required: field.required === true,
      options: readOptions(
        Array.isArray(field.options)
          ? field.options.slice(0, 200)
          : field.options,
      ),
    };
  };
  const mergeMetadata = (
    sources: FieldMetadata[],
    fallbackLabel: string,
  ): FieldMetadata => {
    const labels = new Set(
      sources
        .map((source) => source.label)
        .filter((value): value is string => Boolean(value)),
    );
    const descriptions = new Set(
      sources
        .map((source) => source.description)
        .filter((value): value is string => Boolean(value)),
    );
    const types = new Set(
      sources
        .map((source) => source.fieldType)
        .filter((value): value is WhatsAppFlowFieldType => Boolean(value)),
    );
    const options = new Map<string, ScenarioFormFieldOption>();
    for (const source of sources)
      for (const option of source.options ?? []) {
        const previous = options.get(option.id);
        options.set(
          option.id,
          previous && previous.title !== option.title
            ? { id: option.id, title: option.id }
            : option,
        );
      }
    return {
      label: labels.size === 1 ? [...labels][0]! : fallbackLabel,
      description: descriptions.size === 1 ? [...descriptions][0]! : "",
      fieldType:
        types.size === 1
          ? [...types][0]!
          : types.size > 1
            ? "TextInput"
            : options.size
              ? "Dropdown"
              : "TextInput",
      required:
        sources.length > 0 &&
        sources.every((source) => source.required === true),
      options: [...options.values()],
      ...(sources.some(isDescribed) ? {} : { undescribed: true }),
    };
  };
  const metadataCache = new Map<string, FieldMetadata>();
  let remainingMetadataWork = 10_000;
  const dataMetadata = (
    screen: Record<string, unknown>,
    dataId: string,
    visiting = new Set<string>(),
  ): FieldMetadata => {
    const visitKey = JSON.stringify([readText(screen.id), dataId]);
    const cached = metadataCache.get(visitKey);
    if (cached) return cached;
    if (visiting.has(visitKey)) return { required: false };
    if (--remainingMetadataWork < 0) return { required: false };
    const nextVisiting = new Set(visiting).add(visitKey);
    const metadata: FieldMetadata[] = [];
    for (const entry of incoming.get(readText(screen.id)) ?? []) {
      if (--remainingMetadataWork < 0) {
        metadata.push({ required: false });
        break;
      }
      if (
        !isRecord(entry.action.payload) ||
        !Object.hasOwn(entry.action.payload, dataId)
      ) {
        metadata.push({ required: false });
        continue;
      }
      const value = entry.action.payload[dataId];
      const reference = parseWhatsAppFlowPayloadReference(value);
      const source = reference
        ? reference.scope === "form"
          ? fieldMetadata(entry.source, reference.fieldId)
          : dataMetadata(entry.source, reference.fieldId, nextVisiting)
        : {
            label: entry.label,
            required: normalizeWhatsAppFlowReplyValues(value).length > 0,
            ...(typeof value === "string"
              ? { options: [{ id: value, title: entry.title || value }] }
              : {}),
          };
      metadata.push(source);
    }
    const resolved = mergeMetadata(metadata, humanizeScenarioAnswerKey(dataId));
    metadataCache.set(visitKey, resolved);
    return resolved;
  };

  const completions = records.flatMap((screen, screenIndex) => {
    const action = isRecord(screen.footer) ? screen.footer.action : null;
    return screen.terminal === true &&
      isRecord(action) &&
      action.name === "complete"
      ? [
          {
            screen,
            screenIndex,
            payload: isRecord(action.payload) ? action.payload : {},
          },
        ]
      : [];
  });
  const listed = new Map<
    string,
    { sources: FieldMetadata[]; screenIndex: number }
  >();
  let truncated = false;
  for (const { screen, screenIndex, payload } of completions) {
    const entries = Object.entries(payload);
    if (entries.length > MAX_SCENARIO_FORM_SUBMISSION_FIELDS) truncated = true;
    for (const [rawKey, value] of entries.slice(
      0,
      MAX_SCENARIO_FORM_SUBMISSION_FIELDS,
    )) {
      const responseKey = readResponseKey(rawKey);
      if (!responseKey) continue;
      const reference = parseWhatsAppFlowPayloadReference(value);
      const metadata = reference
        ? reference.scope === "form"
          ? fieldMetadata(screen, reference.fieldId)
          : dataMetadata(screen, reference.fieldId)
        : {
            required: normalizeWhatsAppFlowReplyValues(value).length > 0,
            ...(typeof value === "string"
              ? {
                  options: [{ id: value, title: value }],
                }
              : {}),
          };
      const previous = listed.get(responseKey);
      listed.set(responseKey, {
        sources: [
          ...(previous?.sources ?? []),
          {
            ...metadata,
            description: metadata.description || readText(screen.title),
          },
        ],
        screenIndex: previous?.screenIndex ?? screenIndex,
      });
    }
  }
  const undescribedResponseKeys: string[] = [];
  const fields = [...listed.entries()].map(([responseKey, entry]) => {
    const { undescribed, ...metadata } = mergeMetadata(
      entry.sources,
      humanizeScenarioAnswerKey(responseKey),
    );
    if (undescribed) undescribedResponseKeys.push(responseKey);
    return {
      ...metadata,
      responseKey,
      screenIndex: entry.screenIndex,
      conditional: completions.some(
        (completion) => !Object.hasOwn(completion.payload, responseKey),
      ),
    } as ListedFormField;
  });
  return { listed: fields, undescribedResponseKeys, truncated };
}

/** A form's fields, and what a Flow can send that they don't describe. */
export type ScenarioFormFieldCoverage = {
  fields: ScenarioFormField[];
  /**
   * Answers listed under a label made from their key: nothing in the config
   * describes them, such as a field shown inside an If.
   */
  undescribedResponseKeys: string[];
  /** A completion sends more answers than a submission keeps. */
  truncated: boolean;
};

/**
 * Every question a form asks, of all six field types, in screen order. A
 * field id that repeats on a later screen is the same answer and is listed
 * once. A Flow linked from Meta has no fields here.
 */
export function listScenarioFormFields(
  flowConfig: unknown,
): ScenarioFormField[] {
  return listScenarioFormFieldsWithCoverage(flowConfig).fields;
}

/** listScenarioFormFields, with what the listed fields leave out. */
export function listScenarioFormFieldsWithCoverage(
  flowConfig: unknown,
): ScenarioFormFieldCoverage {
  if (!isRecord(flowConfig) || !Array.isArray(flowConfig.screens))
    return { fields: [], undescribedResponseKeys: [], truncated: false };
  const graph =
    flowConfig.flowNavigationMode === "static_graph"
      ? listStaticGraphFormFields(flowConfig.screens)
      : { listed: [], undescribedResponseKeys: [], truncated: false };
  const listed: ListedFormField[] = graph.listed;
  const seen = new Set<string>();
  if (flowConfig.flowNavigationMode !== "static_graph")
    flowConfig.screens.forEach((screen, screenIndex) => {
      if (!isRecord(screen) || !Array.isArray(screen.fields)) return;
      for (const field of screen.fields) {
        if (!isRecord(field)) continue;
        const responseKey = readResponseKey(field.id);
        const fieldType = readFieldType(field.fieldType);
        if (!responseKey || !fieldType || seen.has(responseKey)) continue;
        seen.add(responseKey);
        listed.push({
          responseKey,
          label:
            readLabel(field.label) || humanizeScenarioAnswerKey(responseKey),
          description: readText(field.helperText) || readText(screen.title),
          fieldType,
          required: field.required === true,
          screenIndex,
          options: readOptions(field.options),
        });
      }
    });
  return {
    fields: keyFormFields(listed),
    undescribedResponseKeys: graph.undescribedResponseKeys,
    truncated: graph.truncated,
  };
}

function keyFormFields(
  listed: readonly ListedFormField[],
): ScenarioFormField[] {
  const keys = resolveScenarioFormFieldKeys(
    listed.map((field) => field.responseKey),
  );
  return listed.map((field) => ({
    key: keys.get(field.responseKey) ?? DEFAULT_FIELD_KEY,
    ...field,
  }));
}

export const SCENARIO_WHATSAPP_TEMPLATE_FORM_VERSION = 1 as const;
/** Fields a template's saved form keeps; later ones are dropped. */
export const MAX_SCENARIO_WHATSAPP_TEMPLATE_FORM_FIELDS = 40;
/** Options a saved form keeps per field; later ones are dropped. */
export const MAX_SCENARIO_WHATSAPP_TEMPLATE_FORM_OPTIONS = 100;
const FLOW_ID_PATTERN = /^\d+$/;

/**
 * The fields of the form a template step's FLOW button opens, as the builder
 * read them from the Flow: a Flow made in WhatsApp lists none in the step's
 * Flow config. Only the form readers read it, and only while its `flowId` is
 * the Flow the step's one FLOW button opens; routing never does.
 */
export type ScenarioWhatsAppTemplateForm = {
  version: typeof SCENARIO_WHATSAPP_TEMPLATE_FORM_VERSION;
  /** The Flow the fields were read from, as digits. */
  flowId: string;
  flowName: string | null;
  /** The form's key in `{{form.<formKey>.<fieldKey>}}`, kept across refreshes. */
  answersKey: string;
  /** A hash of the derived fields, coverage and endpoint, to tell they changed. */
  digest: string | null;
  /** "partial": the Flow can send answers these fields do not list. */
  coverage: "complete" | "partial";
  /** The Flow has an endpoint, which can skip every screen after the first. */
  endpoint: boolean;
  /** ISO time the fields were read, or empty. */
  readAt: string;
  fields: Array<Omit<ScenarioFormField, "key">>;
};

function normalizeTemplateFormField(value: unknown): ListedFormField | null {
  if (!isRecord(value)) return null;
  const responseKey = readResponseKey(value.responseKey);
  const fieldType = readFieldType(value.fieldType);
  if (!responseKey || !fieldType) return null;
  const screenIndex = value.screenIndex;
  return {
    responseKey,
    label: readLabel(value.label) || humanizeScenarioAnswerKey(responseKey),
    description: readText(value.description),
    fieldType,
    required: value.required === true,
    screenIndex:
      Number.isSafeInteger(screenIndex) && (screenIndex as number) >= 0
        ? (screenIndex as number)
        : 0,
    options: readOptions(value.options).slice(
      0,
      MAX_SCENARIO_WHATSAPP_TEMPLATE_FORM_OPTIONS,
    ),
    ...(value.conditional === true ? { conditional: true } : {}),
  };
}

/**
 * A template step's saved form, bounded. It is machine-written: a version
 * this code does not know, or a form without a digits-only Flow id, a valid
 * key or a field list, is unsupported, so it is kept as it is and never read.
 * Fields it cannot read are dropped one by one.
 */
export function normalizeScenarioWhatsAppTemplateForm(
  value: unknown,
): ScenarioActionRoutingNormalization<ScenarioWhatsAppTemplateForm> {
  if (value === null || value === undefined) {
    return { status: "absent", value: null };
  }
  const flowId = isRecord(value) ? readId(value.flowId) : "";
  const answersKey = isRecord(value) ? readText(value.answersKey) : "";
  if (
    !isRecord(value) ||
    value.version !== SCENARIO_WHATSAPP_TEMPLATE_FORM_VERSION ||
    !FLOW_ID_PATTERN.test(flowId) ||
    !isScenarioFormAnswerKey(answersKey) ||
    !Array.isArray(value.fields)
  ) {
    return {
      status: "unsupported",
      value: null,
      version: isRecord(value) ? value.version : undefined,
      raw: value,
    };
  }

  const fields: ListedFormField[] = [];
  const seen = new Set<string>();
  for (const item of value.fields) {
    if (fields.length >= MAX_SCENARIO_WHATSAPP_TEMPLATE_FORM_FIELDS) break;
    const field = normalizeTemplateFormField(item);
    if (!field || seen.has(field.responseKey)) continue;
    seen.add(field.responseKey);
    fields.push(field);
  }
  return {
    status: "supported",
    value: {
      version: SCENARIO_WHATSAPP_TEMPLATE_FORM_VERSION,
      flowId,
      flowName: readId(value.flowName) || null,
      answersKey,
      digest: readId(value.digest) || null,
      coverage: value.coverage === "complete" ? "complete" : "partial",
      endpoint: value.endpoint === true,
      readAt: readIsoTime(value.readAt),
      fields,
    },
  };
}

/**
 * A template step's saved form while the step's one FLOW button still opens
 * its Flow. A form saved for another Flow, such as an earlier template's, is
 * never read.
 */
function readCurrentWhatsAppTemplateForm(
  data: Record<string, unknown>,
): ScenarioWhatsAppTemplateForm | null {
  if (data.actionType !== "whatsapp_template") return null;
  const form = normalizeScenarioWhatsAppTemplateForm(
    data.actionWhatsAppTemplateForm,
  );
  return form.status === "supported" &&
    form.value.flowId ===
      readSingleWhatsAppTemplateFlowButtonFlowId(
        data.actionWhatsAppTemplateComponents,
      )
    ? form.value
    : null;
}

/**
 * The form a node sends, and whether a service message or a template sends
 * it. A template's form read from the Flow its button opens carries its
 * fields here, and `flowConfig` only names it; that config is never saved.
 */
export type ScenarioActionForm = {
  flowConfig: Record<string, unknown>;
  sender: "service_message" | "template";
  /** The template's saved form fields; read them with listScenarioActionFormFields. */
  fields?: ScenarioFormField[];
  /** The Flow the saved fields were read from. */
  snapshotFlowId?: string;
  /** The saved fields leave out answers the Flow can send. */
  partial?: true;
};

/**
 * A template's Flow config wins while it lists fields. Otherwise, such as for
 * a Flow linked from Meta, the template's saved form gives the fields, and
 * the config's own key, when it stores one, stays the form's key.
 */
export function readScenarioActionForm(
  data: unknown,
): ScenarioActionForm | null {
  if (!isRecord(data)) return null;
  const flowConfig = readScenarioActionFlowConfig(data);
  const config = isRecord(flowConfig) ? flowConfig : null;
  if (data.actionWhatsAppServiceMessage !== undefined) {
    return config ? { flowConfig: config, sender: "service_message" } : null;
  }
  const saved = readCurrentWhatsAppTemplateForm(data);
  if (!saved || (config && listScenarioFormFields(config).length > 0)) {
    return config ? { flowConfig: config, sender: "template" } : null;
  }
  return {
    flowConfig: {
      screens: [],
      answersKey: (config && readStoredFormKey(config)) || saved.answersKey,
      ...(saved.flowName ? { metaFlowName: saved.flowName } : {}),
      ...(saved.endpoint ? { flowNavigationMode: "data_endpoint" } : {}),
    },
    sender: "template",
    fields: keyFormFields(saved.fields),
    snapshotFlowId: saved.flowId,
    ...(saved.coverage === "partial" ? { partial: true } : {}),
  };
}

/**
 * The node's form as a send of `flowId` asked it, for a send that stored no
 * fields. Null when the node's saved form was read from another Flow: it
 * describes another form. A send of no known Flow reads the node's form.
 */
export function readScenarioActionFormForFlow(
  data: unknown,
  flowId: string | null | undefined,
): ScenarioActionForm | null {
  const form = readScenarioActionForm(data);
  const sentFlowId = readText(flowId);
  if (
    form?.snapshotFlowId &&
    sentFlowId &&
    form.snapshotFlowId !== sentFlowId
  ) {
    return null;
  }
  return form;
}

/** A form's questions: a template's saved form fields, else its Flow config's. */
export function listScenarioActionFormFields(
  form: Pick<ScenarioActionForm, "flowConfig" | "fields"> | null | undefined,
): ScenarioFormField[] {
  if (!form) return [];
  return form.fields ?? listScenarioFormFields(form.flowConfig);
}

function readStoredFormKey(flowConfig: Record<string, unknown>): string {
  const key = readText(flowConfig.answersKey);
  return isScenarioFormAnswerKey(key) ? key : "";
}

function readFlowNames(flowConfig: Record<string, unknown>): string[] {
  const providerReference = isRecord(flowConfig.providerReference)
    ? flowConfig.providerReference
    : null;
  return [
    readText(flowConfig.metaFlowName),
    readText(providerReference?.flowName),
  ].filter(Boolean);
}

function deriveFormKey(flowConfig: Record<string, unknown>): string {
  for (const name of readFlowNames(flowConfig)) {
    const key = slugifyKey(name, "form_", "");
    if (key) return key;
  }
  return DEFAULT_FORM_KEY;
}

/**
 * Each form's key in `{{form.<formKey>.<fieldKey>}}`, by sending node id. A
 * stored `answersKey` wins; a form without one gets a key from its Flow name,
 * or "form". Stored keys are claimed first, in node order, and any other key
 * takes `_2`, `_3`… so keys are unique in the scenario. The builder,
 * activation and the runtime all read keys here, so they agree.
 */
export function resolveScenarioFormKeys(
  nodes: ReadonlyArray<{ id: string; data?: unknown }>,
): Map<string, string> {
  const forms = nodes.flatMap((node) => {
    const form = readScenarioActionForm(node.data);
    return form ? [{ nodeId: node.id, flowConfig: form.flowConfig }] : [];
  });
  const keys = new Map<string, string>();
  const used = new Set<string>();
  for (const form of forms) {
    const stored = readStoredFormKey(form.flowConfig);
    if (!stored || used.has(stored) || keys.has(form.nodeId)) continue;
    keys.set(form.nodeId, stored);
    used.add(stored);
  }
  for (const form of forms) {
    if (keys.has(form.nodeId)) continue;
    const base =
      readStoredFormKey(form.flowConfig) || deriveFormKey(form.flowConfig);
    keys.set(form.nodeId, claimKey(base, used));
  }
  return keys;
}

/** The `answersKey` a form stores, when it is a valid key; else "". */
export function readScenarioStoredFormKey(flowConfig: unknown): string {
  return isRecord(flowConfig) ? readStoredFormKey(flowConfig) : "";
}

/** The names a form's key is made from: its Flow name, then its linked Flow's. */
export function listScenarioFormNames(flowConfig: unknown): string[] {
  return isRecord(flowConfig) ? readFlowNames(flowConfig) : [];
}

/**
 * The key a form newly gets: a slug of the first name that has one, else
 * "form", with `_2`, `_3`… until no key in `takenKeys` has it. The builder
 * stores it as the form's `answersKey` when the form is made or linked, so
 * it never changes after.
 */
export function claimScenarioFormKey(
  names: readonly string[],
  takenKeys: Iterable<string>,
): string {
  const base =
    names
      .map((name) => slugifyKey(name, "form_", ""))
      .find((slug) => slug.length > 0) ?? DEFAULT_FORM_KEY;
  return claimKey(base, new Set(takenKeys));
}

/** A form's name for AI steps: its Flow name, else its first screen title. */
export function readScenarioFormLabel(flowConfig: unknown): string {
  if (!isRecord(flowConfig)) return DEFAULT_FORM_LABEL;
  const firstScreen = Array.isArray(flowConfig.screens)
    ? flowConfig.screens[0]
    : null;
  for (const name of [
    ...readFlowNames(flowConfig),
    isRecord(firstScreen) ? firstScreen.title : "",
  ]) {
    const label = readLabel(name);
    if (label) return label;
  }
  return DEFAULT_FORM_LABEL;
}

/** A field as the sent form described it: a Flow config field or a stored snapshot. */
export type ScenarioFormFieldSchema = {
  id: string;
  label?: string | null;
  fieldType?: string | null;
  options?: ReadonlyArray<ScenarioFormFieldOption> | null;
};

function toFormFieldSchema(field: ScenarioFormField): ScenarioFormFieldSchema {
  return {
    id: field.responseKey,
    label: field.label,
    fieldType: field.fieldType,
    options: field.options,
  };
}

/** A form's questions as capture reads them, from its Flow config. */
export function listScenarioFormFieldSchemas(
  flowConfig: unknown,
): ScenarioFormFieldSchema[] {
  return listScenarioFormFields(flowConfig).map(toFormFieldSchema);
}

/** A node's form questions as capture reads them, saved form fields included. */
export function listScenarioActionFormFieldSchemas(
  form: ScenarioActionForm | null | undefined,
): ScenarioFormFieldSchema[] {
  return listScenarioActionFormFields(form).map(toFormFieldSchema);
}

const EPOCH_MILLISECONDS_PATTERN = /^\d{12,13}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Dates as sent. Older Flow versions sent the day as epoch milliseconds at
 * midnight in the customer's time zone; the nearest UTC midnight is that day.
 */
function formatDateAnswer(value: string): string {
  if (!EPOCH_MILLISECONDS_PATTERN.test(value)) return value;
  const day = new Date(Math.round(Number(value) / DAY_MS) * DAY_MS);
  return Number.isNaN(day.getTime()) ? value : day.toISOString().slice(0, 10);
}

/**
 * An answer as display text: the option title for a dropdown or radio
 * choice, checkbox titles joined with ", ", dates as sent, and "yes" or "no"
 * for an opt-in. An option the form does not list keeps the id it was sent
 * with. Bounded; media and other objects give "".
 */
export function formatScenarioFormAnswerValue(
  raw: unknown,
  field?: Pick<ScenarioFormFieldSchema, "fieldType" | "options"> | null,
): string {
  const values =
    typeof raw === "boolean"
      ? [raw ? "yes" : "no"]
      : typeof raw === "number"
        ? Number.isFinite(raw)
          ? [String(raw)]
          : []
        : normalizeWhatsAppFlowReplyValues(raw);
  const titles = new Map(
    readOptions(field?.options).map((option) => [option.id, option.title]),
  );
  const isDate = field?.fieldType === "DatePicker";
  return normalizeAnswer(
    values
      .map((value) =>
        isDate ? formatDateAnswer(value) : (titles.get(value) ?? value),
      )
      .join(", "),
  );
}

export type ScenarioFormAnswerFieldType = WhatsAppFlowFieldType | "unknown";

export type ScenarioFormAnswer = {
  /** The key the reply used: the Flow field id. */
  key: string;
  label: string;
  fieldType: ScenarioFormAnswerFieldType;
  /** Display text, as formatScenarioFormAnswerValue gives it. */
  value: string;
};

/**
 * One submission of a form. Only answered fields are kept: a blank optional
 * field is left out, so it reads as empty rather than as a missing form.
 */
export type ScenarioFormSubmission = {
  sourceActionNodeId: string;
  flowId: string | null;
  inboundMessageId: string;
  /** ISO time of the reply, or empty when a stored value had none. */
  submittedAt: string;
  fields: ScenarioFormAnswer[];
};

/** The submissions of one scenario, oldest first, the latest one per node. */
export type ScenarioFormAnswers = {
  scenarioId: string;
  submissions: ScenarioFormSubmission[];
};

function readIsoTime(value: unknown): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : "";
}

function normalizeFormAnswer(value: unknown): ScenarioFormAnswer | null {
  if (!isRecord(value)) return null;
  const key = readResponseKey(value.key);
  const answer = normalizeAnswer(
    typeof value.value === "string" ? value.value : "",
  );
  if (!key || !answer) return null;
  return {
    key,
    label: readLabel(value.label) || humanizeScenarioAnswerKey(key),
    fieldType: readFieldType(value.fieldType) ?? "unknown",
    value: answer,
  };
}

export function normalizeScenarioFormSubmission(
  value: unknown,
): ScenarioFormSubmission | null {
  if (!isRecord(value)) return null;
  const sourceActionNodeId = readId(value.sourceActionNodeId);
  if (!sourceActionNodeId) return null;
  const fields: ScenarioFormAnswer[] = [];
  const seen = new Set<string>();
  let remaining = MAX_SCENARIO_FORM_SUBMISSION_CHARACTERS;
  for (const item of Array.isArray(value.fields) ? value.fields : []) {
    if (
      fields.length >= MAX_SCENARIO_FORM_SUBMISSION_FIELDS ||
      remaining <= 0
    ) {
      break;
    }
    const answer = normalizeFormAnswer(item);
    if (!answer || seen.has(answer.key)) continue;
    seen.add(answer.key);
    const text = sliceScenarioAnswerText(answer.value, remaining);
    if (!text) break;
    remaining -= text.length;
    fields.push({ ...answer, value: text });
  }
  return {
    sourceActionNodeId,
    flowId: readId(value.flowId) || null,
    inboundMessageId: readId(value.inboundMessageId),
    submittedAt: readIsoTime(value.submittedAt),
    fields,
  };
}

/**
 * The submission a Flow reply records: each answer the reply holds, in the
 * form's field order, formatted with the field as the form was sent. Keys
 * the form does not describe are kept with readable labels, so a form made
 * only in Meta still records its answers. Null when the reply has no
 * readable answers object; a reply with every answer blank still records
 * that the form was submitted.
 */
export function buildScenarioFormSubmission(params: {
  sourceActionNodeId: string;
  flowId?: string | null;
  inboundMessageId: string;
  submittedAt: Date;
  responseJson: string | null | undefined;
  fields?: readonly ScenarioFormFieldSchema[] | null;
}): ScenarioFormSubmission | null {
  const record = readScenarioFlowResponseRecord(params.responseJson);
  if (!record) return null;
  const schema = new Map<string, ScenarioFormFieldSchema>();
  for (const field of params.fields ?? []) {
    const key = readResponseKey(field?.id);
    if (key && !schema.has(key)) schema.set(key, field);
  }
  const keys = [
    ...schema.keys(),
    ...Object.keys(record).filter(
      (key) => !schema.has(key) && !GENERIC_FLOW_RESPONSE_KEYS.has(key),
    ),
  ];
  const fields: ScenarioFormAnswer[] = [];
  for (const key of keys) {
    if (!readResponseKey(key) || !Object.hasOwn(record, key)) continue;
    const field = schema.get(key);
    const value = formatScenarioFormAnswerValue(record[key], field);
    if (!value) continue;
    fields.push({
      key,
      label: readLabel(field?.label) || humanizeScenarioAnswerKey(key),
      fieldType: readFieldType(field?.fieldType) ?? "unknown",
      value,
    });
  }
  return normalizeScenarioFormSubmission({
    sourceActionNodeId: params.sourceActionNodeId,
    flowId: params.flowId ?? null,
    inboundMessageId: params.inboundMessageId,
    submittedAt: Number.isNaN(params.submittedAt.getTime())
      ? ""
      : params.submittedAt.toISOString(),
    fields,
  });
}

function limitSubmissions(
  submissions: ScenarioFormSubmission[],
): ScenarioFormSubmission[] {
  const latest = submissions.filter(
    (submission, index) =>
      !submissions
        .slice(index + 1)
        .some(
          (later) => later.sourceActionNodeId === submission.sourceActionNodeId,
        ),
  );
  return latest.slice(-MAX_SCENARIO_FORM_SUBMISSIONS);
}

export function normalizeScenarioFormAnswers(
  value: unknown,
): ScenarioFormAnswers | null {
  if (!isRecord(value) || !Array.isArray(value.submissions)) return null;
  const scenarioId = readId(value.scenarioId, MAX_SCENARIO_ID_CHARACTERS);
  if (!scenarioId) return null;
  const submissions = limitSubmissions(
    value.submissions.flatMap((item) => {
      const submission = normalizeScenarioFormSubmission(item);
      return submission ? [submission] : [];
    }),
  );
  return submissions.length > 0 ? { scenarioId, submissions } : null;
}

/**
 * Record a submission in scenario state. A newer submission from the same
 * node replaces the earlier one as a whole; one from another scenario starts
 * that scenario's list. Bounded, and never throws: past the limit the oldest
 * submission is dropped, and an unusable submission leaves state as it was.
 */
export function recordScenarioFormSubmission(
  state: unknown,
  params: { scenarioId: string; submission: ScenarioFormSubmission },
): Record<string, unknown> {
  const base = isRecord(state) ? { ...state } : {};
  const scenarioId = readId(params.scenarioId, MAX_SCENARIO_ID_CHARACTERS);
  const submission = normalizeScenarioFormSubmission(params.submission);
  if (!scenarioId || !submission) return base;
  const existing = normalizeScenarioFormAnswers(base.formAnswers);
  return {
    ...base,
    formAnswers: {
      scenarioId,
      submissions: limitSubmissions([
        ...(existing?.scenarioId === scenarioId ? existing.submissions : []),
        submission,
      ]),
    },
  };
}

/** A scenario's submissions, oldest first. Another scenario's are never read. */
export function readScenarioFormSubmissions(
  state: unknown,
  scenarioId: string | null | undefined,
): ScenarioFormSubmission[] {
  if (!isRecord(state) || !scenarioId) return [];
  const answers = normalizeScenarioFormAnswers(state.formAnswers);
  return answers?.scenarioId === scenarioId ? answers.submissions : [];
}

/** What the runtime knows of one form: its keys and labels. */
export type ScenarioFormAnswerFieldMapEntry = {
  formKey: string;
  formLabel: string;
  /** By the key the reply uses: the field's token key and label. */
  fields: Readonly<Record<string, { key: string; label: string }>>;
};

/** Forms by sending node id. Stored answers name the node, so renaming a key orphans nothing. */
export type ScenarioFormAnswerFieldMap = Readonly<
  Record<string, ScenarioFormAnswerFieldMapEntry>
>;

export function buildScenarioFormAnswerFieldMap(
  nodes: ReadonlyArray<{ id: string; data?: unknown }>,
): ScenarioFormAnswerFieldMap {
  const formKeys = resolveScenarioFormKeys(nodes);
  return Object.fromEntries(
    nodes.flatMap((node) => {
      const formKey = formKeys.get(node.id);
      const form = readScenarioActionForm(node.data);
      if (!formKey || !form) return [];
      const entry: ScenarioFormAnswerFieldMapEntry = {
        formKey,
        formLabel: readScenarioFormLabel(form.flowConfig),
        fields: Object.fromEntries(
          listScenarioActionFormFields(form).map((field) => [
            field.responseKey,
            { key: field.key, label: field.label },
          ]),
        ),
      };
      return [[node.id, entry] as const];
    }),
  );
}

/**
 * `form.<formKey>.<fieldKey>` values. Every submitted form the map knows has
 * a group, even with every answer blank, so a blank field reads as empty and
 * only a form never submitted reads as missing. Answers to fields the form
 * no longer lists are left out.
 */
export function readScenarioFormAnswerTemplateValues(
  submissions: readonly ScenarioFormSubmission[],
  fieldMap: ScenarioFormAnswerFieldMap | null | undefined,
): Record<string, Record<string, string>> {
  const values: Record<string, Record<string, string>> = {};
  if (!fieldMap) return values;
  for (const submission of submissions) {
    const form = Object.hasOwn(fieldMap, submission.sourceActionNodeId)
      ? fieldMap[submission.sourceActionNodeId]
      : undefined;
    if (!form || !isScenarioFormAnswerKey(form.formKey)) continue;
    const answers: Record<string, string> = {};
    for (const answer of submission.fields) {
      const field = Object.hasOwn(form.fields, answer.key)
        ? form.fields[answer.key]
        : undefined;
      if (field && isScenarioFormAnswerKey(field.key)) {
        answers[field.key] = answer.value;
      }
    }
    values[form.formKey] = answers;
  }
  return values;
}

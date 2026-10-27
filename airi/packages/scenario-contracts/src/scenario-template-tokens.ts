import {
  humanizeScenarioAnswerKey,
  parseScenarioFormAnswerToken,
  SCENARIO_FORM_ANSWER_NAMESPACE,
  ScenarioFormAnswerMissingError,
  type ScenarioFormAnswerFieldMap,
} from "./scenario-form-answers";
import {
  isScenarioPromptInputKey,
  parseScenarioPromptInputToken,
  SCENARIO_PROMPT_INPUT_NAMESPACE,
  ScenarioPromptInputMissingError,
} from "./scenario-prompt-inputs";

/*
 * Scenario template variables: one grammar and one context description for
 * the reply renderer, activation validation, the editor and its preview.
 */

const DOUBLE_BRACE_TOKEN_SOURCE = String.raw`\{\{\s*([a-zA-Z0-9_][a-zA-Z0-9_.-]*)\s*\}\}`;
const SINGLE_BRACE_TOKEN_SOURCE = String.raw`\{([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_.-]+)+)\}`;

/** `{{path}}` only: the syntax the editor inserts and shows as a variable chip. */
export const SCENARIO_TEMPLATE_VARIABLE_PATTERN = new RegExp(
  DOUBLE_BRACE_TOKEN_SOURCE,
  "g",
);

/**
 * Scenario template tokens: `{{path}}` or `{dotted.path}`. The reply renderer
 * and activation validation share this grammar so they agree on references.
 */
export const SCENARIO_TEMPLATE_TOKEN_PATTERN = new RegExp(
  `${DOUBLE_BRACE_TOKEN_SOURCE}|${SINGLE_BRACE_TOKEN_SOURCE}`,
  "g",
);

// Not global, so `test` keeps no position between calls.
const SCENARIO_TEMPLATE_TOKEN_PRESENCE = new RegExp(
  SCENARIO_TEMPLATE_TOKEN_PATTERN.source,
);

export function hasScenarioTemplateTokens(text: string): boolean {
  return SCENARIO_TEMPLATE_TOKEN_PRESENCE.test(text);
}

/** Every token in the order the renderer reads them, repeats included. */
export function listScenarioTemplateTokens(template: string): string[] {
  return Array.from(
    template.matchAll(SCENARIO_TEMPLATE_TOKEN_PATTERN),
    (match) => match[1] ?? match[2] ?? "",
  );
}

/** Path segments of a token. Empty segments are skipped, as they always were. */
export function parseScenarioTemplatePath(token: string): string[] {
  return token.split(".").filter(Boolean);
}

export type ScenarioTemplateRenderContext = Readonly<Record<string, unknown>>;

/**
 * Case-sensitive, and only through own properties, so inherited names such as
 * `constructor` never resolve.
 */
export function resolveScenarioTemplatePath(
  context: ScenarioTemplateRenderContext,
  token: string,
): unknown {
  const keys = parseScenarioTemplatePath(token);
  if (keys.length === 0) return undefined;
  let cursor: unknown = context;
  for (const key of keys) {
    if (!cursor || typeof cursor !== "object" || !Object.hasOwn(cursor, key)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

const HUMANIZED_KEY = "humanized";

/** Primitives render as text; a group with `humanized` text renders that text. */
export function scenarioTemplateValueToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (typeof value === "object" && Object.hasOwn(value, HUMANIZED_KEY)) {
    const humanized = (value as Record<string, unknown>)[HUMANIZED_KEY];
    if (typeof humanized === "string") return humanized;
  }
  return "";
}

/**
 * What a token without a value renders. Merchant-authored text fails closed:
 * a valid `input.<key>` with no answer throws ScenarioPromptInputMissingError.
 * A generative prompt (`require_answers`) also fails closed on a form the
 * customer never submitted, with ScenarioFormAnswerMissingError; a blank
 * field of a submitted form renders empty. Other text never fails on a form
 * answer, so a missing one cannot stop a turn. Text a model generated, and
 * the editor preview, render every missing value empty. Any other path
 * without a value renders empty under every policy.
 */
export type ScenarioTemplateMissingValuePolicy =
  | "require_prompt_inputs"
  | "require_answers"
  | "empty";

function isFormSubmitted(
  context: ScenarioTemplateRenderContext,
  formKey: string,
): boolean {
  const form = resolveScenarioTemplatePath(
    context,
    `${SCENARIO_FORM_ANSWER_NAMESPACE}.${formKey}`,
  );
  return Boolean(form) && typeof form === "object" && !Array.isArray(form);
}

export function renderScenarioTemplate(
  template: string,
  context: ScenarioTemplateRenderContext,
  missing: ScenarioTemplateMissingValuePolicy,
): string {
  // One pass: values inserted by a replacement never become template code.
  return template.replace(
    SCENARIO_TEMPLATE_TOKEN_PATTERN,
    (
      _match: string,
      doubleToken: string | undefined,
      singleToken: string | undefined,
    ) => {
      const token = doubleToken ?? singleToken ?? "";
      const value = resolveScenarioTemplatePath(context, token);
      if (
        missing !== "empty" &&
        parseScenarioPromptInputToken(token) !== null &&
        (typeof value !== "string" || !value.trim())
      ) {
        throw new ScenarioPromptInputMissingError(token);
      }
      if (missing === "require_answers") {
        const answer = parseScenarioFormAnswerToken(token);
        if (answer && !isFormSubmitted(context, answer.formKey)) {
          throw new ScenarioFormAnswerMissingError(token);
        }
      }
      return scenarioTemplateValueToString(value);
    },
  );
}

/** Answer keys a template requires; invalid keys render empty instead. */
export function listScenarioPromptInputReferences(template: string): string[] {
  const keys = new Set<string>();
  for (const token of listScenarioTemplateTokens(template)) {
    const key = parseScenarioPromptInputToken(token);
    if (key) keys.add(key);
  }
  return [...keys];
}

/** An answer token: a collected detail or a form answer. */
export type ScenarioAnswerReference =
  | { kind: "input"; token: string; key: string }
  | { kind: "form"; token: string; formKey: string; fieldKey: string };

function readScenarioAnswerReference(
  token: string,
): ScenarioAnswerReference | null {
  const key = parseScenarioPromptInputToken(token);
  if (key) return { kind: "input", token, key };
  const answer = parseScenarioFormAnswerToken(token);
  return answer ? { kind: "form", token, ...answer } : null;
}

/** Answer tokens a template names, each once, in the order they appear. */
export function listScenarioAnswerReferences(
  template: string,
): ScenarioAnswerReference[] {
  const references = new Map<string, ScenarioAnswerReference>();
  for (const token of listScenarioTemplateTokens(template)) {
    if (references.has(token)) continue;
    const reference = readScenarioAnswerReference(token);
    if (reference) references.set(token, reference);
  }
  return [...references.values()];
}

/** "Order form › Size": how an AI step names a form answer. */
export function scenarioFormAnswerReferenceLabel(
  formLabel: string,
  fieldLabel: string,
): string {
  return `${formLabel.trim()} › ${fieldLabel.trim()}`;
}

/**
 * The name an AI step gives an answer: "Order form › Size" for a form
 * answer, from the scenario's current form labels or else its keys made
 * readable, and "Name" for a collected detail.
 */
export function labelScenarioAnswerReference(
  reference: ScenarioAnswerReference,
  forms?: ScenarioFormAnswerFieldMap | null,
): string {
  if (reference.kind === "input") {
    return humanizeScenarioAnswerKey(reference.key);
  }
  const form = Object.values(forms ?? {}).find(
    (entry) => entry.formKey === reference.formKey,
  );
  const field = Object.values(form?.fields ?? {}).find(
    (entry) => entry.key === reference.fieldKey,
  );
  return scenarioFormAnswerReferenceLabel(
    form?.formLabel || humanizeScenarioAnswerKey(reference.formKey),
    field?.label || humanizeScenarioAnswerKey(reference.fieldKey),
  );
}

/**
 * The recorded value an answer token names, or null when there is none: an
 * unsaved detail, a form never submitted, or a field its submission left
 * blank. Own properties only.
 */
export function readScenarioAnswerReferenceValue(
  reference: ScenarioAnswerReference,
  answers: {
    promptInputs: Readonly<Record<string, string>>;
    formAnswers: Readonly<Record<string, Readonly<Record<string, string>>>>;
  },
): string | null {
  if (reference.kind === "input") {
    return Object.hasOwn(answers.promptInputs, reference.key)
      ? (answers.promptInputs[reference.key] ?? null)
      : null;
  }
  const fields = Object.hasOwn(answers.formAnswers, reference.formKey)
    ? answers.formAnswers[reference.formKey]
    : undefined;
  return fields && Object.hasOwn(fields, reference.fieldKey)
    ? (fields[reference.fieldKey] ?? null)
    : null;
}

/** The bracketed reference an instruction shows, on one line: "[Order form › Size]". */
export function formatScenarioAnswerReference(label: string): string {
  return `[${label.replace(/[[\]\s]+/g, " ").trim()}]`;
}

/**
 * An "AI writes" instruction as the model reads it. Each answer token
 * becomes its bracketed reference, such as "[Order form › Size]", and the
 * values travel in a separate section labelled as customer data, so the
 * customer's words never enter the instruction. Every other token stays
 * literal, as before. One pass, so a label never becomes a token.
 */
export function renderScenarioAnswerReferences(
  template: string,
  label: (reference: ScenarioAnswerReference) => string,
): string {
  return template.replace(
    SCENARIO_TEMPLATE_TOKEN_PATTERN,
    (
      match: string,
      doubleToken: string | undefined,
      singleToken: string | undefined,
    ) => {
      const reference = readScenarioAnswerReference(
        doubleToken ?? singleToken ?? "",
      );
      return reference
        ? formatScenarioAnswerReference(label(reference))
        : match;
    },
  );
}

/*
 * The context the reply renderer builds. Every path here renders, and no
 * other path does: the editor validates tokens against this description and
 * the server and preview contexts are typed from it.
 */

const TEXT = "text";
const NUMBER = "number";
/** "yes", or empty text. */
const FLAG = "flag";
/** Renders "true" or "false". */
const BOOLEAN = "boolean";
/** Collected answers keyed by prompt-input key: `input.<key>`. */
const PROMPT_INPUTS = "prompt_inputs";
/** Submitted form answers by form, then field: `form.<formKey>.<fieldKey>`. */
const FORM_ANSWERS = "form_answers";

type ScenarioTemplateLeafKind =
  | typeof TEXT
  | typeof NUMBER
  | typeof FLAG
  | typeof BOOLEAN;
type ScenarioTemplateShapeNode =
  | ScenarioTemplateLeafKind
  | typeof PROMPT_INPUTS
  | typeof FORM_ANSWERS
  | ScenarioTemplateShape;
type ScenarioTemplateShape = {
  readonly [key: string]: ScenarioTemplateShapeNode;
};

/** Mirrors the WhatsApp referral fields; web tests keep the two aligned. */
const SCENARIO_TEMPLATE_REFERRAL_SHAPE = {
  sourceType: TEXT,
  sourceId: TEXT,
  sourceUrl: TEXT,
  sourcePlatform: TEXT,
  campaignId: TEXT,
  campaignName: TEXT,
  adSetId: TEXT,
  adSetName: TEXT,
  headline: TEXT,
  body: TEXT,
  mediaType: TEXT,
  imageUrl: TEXT,
  videoUrl: TEXT,
  thumbnailUrl: TEXT,
  ctwaClid: TEXT,
  ref: TEXT,
  welcomeMessageText: TEXT,
  hasReferral: BOOLEAN,
} as const;

/** Top-level aliases of the referral fields, as the WhatsApp alias map names them. */
export const SCENARIO_TEMPLATE_REFERRAL_ALIAS_KEYS = [
  "whatsapp_referral_source_type",
  "whatsapp_referral_source_id",
  "whatsapp_referral_source_url",
  "whatsapp_referral_source_platform",
  "whatsapp_referral_campaign_id",
  "whatsapp_referral_campaign_name",
  "whatsapp_referral_ad_set_id",
  "whatsapp_referral_ad_set_name",
  "whatsapp_referral_headline",
  "whatsapp_referral_body",
  "whatsapp_referral_media_type",
  "whatsapp_referral_image_url",
  "whatsapp_referral_video_url",
  "whatsapp_referral_thumbnail_url",
  "whatsapp_referral_ctwa_clid",
  "whatsapp_referral_ref",
  "whatsapp_referral_welcome_message_text",
  "meta_ad_source_type",
  "meta_ad_source_id",
  "meta_ad_source_url",
  "meta_ad_source_platform",
  "meta_ad_campaign_id",
  "meta_ad_campaign_name",
  "meta_ad_ad_set_id",
  "meta_ad_ad_set_name",
  "meta_ad_headline",
  "meta_ad_body",
  "ctwa_clid",
  "ctwa_ref",
] as const;

export type ScenarioTemplateReferralAlias =
  (typeof SCENARIO_TEMPLATE_REFERRAL_ALIAS_KEYS)[number];

function textLeaves<K extends string>(
  keys: readonly K[],
): { readonly [P in K]: typeof TEXT } {
  return Object.fromEntries(keys.map((key) => [key, TEXT])) as {
    readonly [P in K]: typeof TEXT;
  };
}

export const SCENARIO_TEMPLATE_CONTEXT_SHAPE = {
  reply: TEXT,
  channel: TEXT,
  link: TEXT,
  link1: TEXT,
  link2: TEXT,
  link3: TEXT,
  link4: TEXT,
  link5: TEXT,
  image: TEXT,
  image1: TEXT,
  image2: TEXT,
  image3: TEXT,
  image4: TEXT,
  image5: TEXT,
  links: { first: TEXT, count: NUMBER },
  images: { first: TEXT, count: NUMBER },
  first_name: TEXT,
  last_name: TEXT,
  username: TEXT,
  customer_name: TEXT,
  customer: {
    name: TEXT,
    firstName: TEXT,
    lastName: TEXT,
    username: TEXT,
    id: TEXT,
  },
  whatsappclient: {
    name: TEXT,
    wa_id: TEXT,
    user_id: TEXT,
    parent_user_id: TEXT,
  },
  chat: {
    id: TEXT,
    title: TEXT,
    first_name: TEXT,
    last_name: TEXT,
    username: TEXT,
  },
  conversation: {
    id: TEXT,
    channel: TEXT,
    preferred_language: TEXT,
    internal_labels: TEXT,
  },
  trigger: {
    message: { id: TEXT, text: TEXT },
    whatsappReferral: SCENARIO_TEMPLATE_REFERRAL_SHAPE,
  },
  whatsappReferral: SCENARIO_TEMPLATE_REFERRAL_SHAPE,
  ...textLeaves(SCENARIO_TEMPLATE_REFERRAL_ALIAS_KEYS),
  calendar: {
    connected: FLAG,
    next_free_slot: TEXT,
    next_free_slot_end: TEXT,
    time_zone: TEXT,
    slot_count: NUMBER,
  },
  // A bare {{countdown}} renders its humanized text.
  countdown: {
    days: NUMBER,
    hours: NUMBER,
    minutes: NUMBER,
    humanized: TEXT,
    expired: FLAG,
    iso: TEXT,
  },
  // What the customer tapped on an earlier service message of the scenario.
  picked: {
    label: TEXT,
    text: TEXT,
  },
  // The office nearest to the location the customer shared in the scenario.
  office: {
    name: TEXT,
    address: TEXT,
    city: TEXT,
    phone: TEXT,
    distance_km: TEXT,
    maps_url: TEXT,
  },
  [SCENARIO_PROMPT_INPUT_NAMESPACE]: PROMPT_INPUTS,
  // Answers the customer submitted in the scenario's forms.
  [SCENARIO_FORM_ANSWER_NAMESPACE]: FORM_ANSWERS,
} as const satisfies ScenarioTemplateShape;

/** Link and image paths are numbered link1 to link5 and image1 to image5. */
export const SCENARIO_TEMPLATE_NUMBERED_SLOTS = 5;

export type ScenarioTemplateValue = string | number | boolean;

type ScenarioTemplateContextOf<S> = {
  readonly [K in keyof S]: S[K] extends typeof PROMPT_INPUTS
    ? Readonly<Record<string, string>>
    : S[K] extends typeof FORM_ANSWERS
      ? Readonly<Record<string, Readonly<Record<string, string>>>>
      : S[K] extends ScenarioTemplateLeafKind
        ? ScenarioTemplateValue
        : ScenarioTemplateContextOf<S[K]>;
};

/** A complete template context: every described path and nothing else. */
export type ScenarioTemplateContext = ScenarioTemplateContextOf<
  typeof SCENARIO_TEMPLATE_CONTEXT_SHAPE
>;

type ScenarioTemplatePathsOf<S, Prefix extends string> = {
  [K in keyof S & string]: S[K] extends typeof PROMPT_INPUTS
    ? `${Prefix}${K}.${string}`
    : S[K] extends typeof FORM_ANSWERS
      ? `${Prefix}${K}.${string}.${string}`
      : S[K] extends ScenarioTemplateLeafKind
        ? `${Prefix}${K}`
        :
            | (S[K] extends { readonly humanized: ScenarioTemplateLeafKind }
                ? `${Prefix}${K}`
                : never)
            | ScenarioTemplatePathsOf<S[K], `${Prefix}${K}.`>;
}[keyof S & string];

/**
 * A token the runtime renders, such as `customer.firstName`, `input.name` or
 * `form.order.size`.
 */
export type ScenarioTemplateContextPath = ScenarioTemplatePathsOf<
  typeof SCENARIO_TEMPLATE_CONTEXT_SHAPE,
  ""
>;

/** Whether the runtime renders this token. Case-sensitive, like the renderer. */
export function isSupportedScenarioTemplateToken(token: string): boolean {
  const segments = parseScenarioTemplatePath(token);
  if (segments.length === 0) return false;
  let node: ScenarioTemplateShapeNode = SCENARIO_TEMPLATE_CONTEXT_SHAPE;
  for (const [index, segment] of segments.entries()) {
    if (node === PROMPT_INPUTS) {
      return index === segments.length - 1 && isScenarioPromptInputKey(segment);
    }
    // Exactly `form.<formKey>.<fieldKey>`, so the renderer's missing-value
    // policy reads every form token it renders.
    if (node === FORM_ANSWERS) {
      return parseScenarioFormAnswerToken(token) !== null;
    }
    if (typeof node !== "object" || !Object.hasOwn(node, segment)) {
      return false;
    }
    node = (node as ScenarioTemplateShape)[segment]!;
  }
  if (node === PROMPT_INPUTS || node === FORM_ANSWERS) return false;
  return typeof node === "string" || Object.hasOwn(node, HUMANIZED_KEY);
}

/**
 * Every fixed path the context provides; `input.<key>` and
 * `form.<formKey>.<fieldKey>` paths are open-ended.
 */
export function listScenarioTemplateContextPaths(): ScenarioTemplateContextPath[] {
  return listScenarioTemplateShapePaths(SCENARIO_TEMPLATE_CONTEXT_SHAPE, "");
}

function listScenarioTemplateShapePaths(
  shape: ScenarioTemplateShape,
  groupPath: string,
): ScenarioTemplateContextPath[] {
  const paths: string[] = [];
  if (groupPath && Object.hasOwn(shape, HUMANIZED_KEY)) paths.push(groupPath);
  for (const [key, node] of Object.entries(shape)) {
    const path = groupPath ? `${groupPath}.${key}` : key;
    if (node === PROMPT_INPUTS || node === FORM_ANSWERS) continue;
    if (typeof node === "string") paths.push(path);
    else paths.push(...listScenarioTemplateShapePaths(node, path));
  }
  return paths as ScenarioTemplateContextPath[];
}

/** Distinct tokens the runtime cannot render, in the order they appear. */
export function listUnsupportedScenarioTemplateTokens(
  template: string,
): string[] {
  const unsupported = new Set<string>();
  for (const token of listScenarioTemplateTokens(template)) {
    if (!isSupportedScenarioTemplateToken(token)) unsupported.add(token);
  }
  return [...unsupported];
}

/** Numbered link or image paths, filled in order; unused slots render empty. */
export function buildScenarioTemplateSlots<Prefix extends "link" | "image">(
  prefix: Prefix,
  values: readonly string[],
): Record<`${Prefix}${1 | 2 | 3 | 4 | 5}`, string> {
  const slots: Record<string, string> = {};
  for (let slot = 1; slot <= SCENARIO_TEMPLATE_NUMBERED_SLOTS; slot += 1) {
    slots[`${prefix}${slot}`] = values[slot - 1] ?? "";
  }
  return slots as Record<`${Prefix}${1 | 2 | 3 | 4 | 5}`, string>;
}

/** The alias paths, read from a runtime alias map; a missing alias renders empty. */
export function pickScenarioTemplateReferralAliases(
  aliases: Readonly<Record<string, string>>,
): { readonly [K in ScenarioTemplateReferralAlias]: string } {
  return Object.fromEntries(
    SCENARIO_TEMPLATE_REFERRAL_ALIAS_KEYS.map((key) => [
      key,
      Object.hasOwn(aliases, key) ? (aliases[key] ?? "") : "",
    ]),
  ) as { readonly [K in ScenarioTemplateReferralAlias]: string };
}

/**
 * A complete context in which every path renders `sample(path)`, for a preview
 * that has no real value. Collected and form answers start empty; a group
 * that renders as its humanized text shows the group's own sample.
 */
export function buildScenarioTemplateSampleContext(
  sample: (path: string) => string,
): ScenarioTemplateContext {
  return sampleScenarioTemplateShape(
    SCENARIO_TEMPLATE_CONTEXT_SHAPE,
    "",
    sample,
  ) as ScenarioTemplateContext;
}

function sampleScenarioTemplateShape(
  shape: ScenarioTemplateShape,
  groupPath: string,
  sample: (path: string) => string,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(shape)) {
    const path = groupPath ? `${groupPath}.${key}` : key;
    values[key] =
      node === PROMPT_INPUTS || node === FORM_ANSWERS
        ? {}
        : typeof node === "string"
          ? sample(path)
          : sampleScenarioTemplateShape(node, path, sample);
  }
  if (groupPath && Object.hasOwn(shape, HUMANIZED_KEY)) {
    values[HUMANIZED_KEY] = sample(groupPath);
  }
  return values;
}

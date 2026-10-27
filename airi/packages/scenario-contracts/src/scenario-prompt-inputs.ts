import {
  listCustomerMessageTextParts,
  type CustomerMessageTextParts,
  type CustomerMessageTextSource,
} from "./customer-message-text";
import type { ScenarioWhatsAppServiceMessage } from "./whatsapp-service-message";
import {
  listScenarioWhatsAppServicePayloadOptions,
  type ScenarioWhatsAppServiceOption,
} from "./whatsapp-service-options";
import { isRecord } from "./value-guards";

export const MAX_SCENARIO_PROMPT_INPUTS = 6;
/** Hard per-scenario-state capacity. Overflow is an error, never an eviction. */
export const MAX_STORED_SCENARIO_PROMPT_INPUT_VALUES = 24;

export class ScenarioPromptInputCapacityError extends Error {
  readonly code = "SCENARIO_PROMPT_INPUT_CAPACITY_EXCEEDED";

  constructor() {
    super(
      `SCENARIO_PROMPT_INPUT_CAPACITY_EXCEEDED: at most ${MAX_STORED_SCENARIO_PROMPT_INPUT_VALUES} distinct collected answers are supported.`,
    );
    this.name = "ScenarioPromptInputCapacityError";
  }
}

/** Code-based, so a second copy of this module still recognizes the error. */
export function isScenarioPromptInputCapacityError(
  error: unknown,
): error is ScenarioPromptInputCapacityError {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code ===
      "SCENARIO_PROMPT_INPUT_CAPACITY_EXCEEDED"
  );
}
/** A valid `input.<key>` reference had no collected answer. */
export class ScenarioPromptInputMissingError extends Error {
  readonly code = "SCENARIO_PROMPT_INPUT_MISSING";

  constructor(readonly token: string) {
    super(`SCENARIO_PROMPT_INPUT_MISSING: ${token}`);
    this.name = "ScenarioPromptInputMissingError";
  }
}

/** Code-based, so a second copy of this module still recognizes the error. */
export function isScenarioPromptInputMissingError(
  error: unknown,
): error is ScenarioPromptInputMissingError {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === "SCENARIO_PROMPT_INPUT_MISSING"
  );
}
export const MAX_SCENARIO_PROMPT_INPUT_LABEL_CHARACTERS = 40;
export const MAX_SCENARIO_PROMPT_INPUT_PROMPT_CHARACTERS = 1024;
export const MAX_SCENARIO_PROMPT_INPUT_ANSWER_CHARACTERS = 2000;
export const MAX_SCENARIO_PROMPT_INPUT_SOURCE_CHARACTERS = 4000;
export const SCENARIO_PROMPT_INPUT_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** Separate branch when the customer's reply did not include every detail. */
export const PROMPT_INPUTS_UNMET_HANDLE = "right-source-prompt-inputs::unmet";

/** How a detail's answer must look. An answer that does not fit is missing. */
export const SCENARIO_PROMPT_INPUT_FORMATS = [
  "text",
  "name",
  "number",
  "choice",
] as const;
export type ScenarioPromptInputFormat =
  (typeof SCENARIO_PROMPT_INPUT_FORMATS)[number];
export const MAX_SCENARIO_PROMPT_INPUT_CHOICES = 12;
export const MAX_SCENARIO_PROMPT_INPUT_CHOICE_CHARACTERS = 60;
/** The longest answer each format accepts unless the detail sets its own. */
export const DEFAULT_SCENARIO_PROMPT_INPUT_MAX_LENGTH: Record<
  ScenarioPromptInputFormat,
  number
> = {
  text: MAX_SCENARIO_PROMPT_INPUT_ANSWER_CHARACTERS,
  name: 40,
  number: 20,
  choice: MAX_SCENARIO_PROMPT_INPUT_CHOICE_CHARACTERS,
};

export type ScenarioPromptInputField = {
  key: string;
  label: string;
  prompt: string;
  /** Omitted means free text. */
  format?: ScenarioPromptInputFormat;
  /** The longest accepted answer in characters; defaults per format. */
  maxLength?: number;
  /** The answers a "choice" detail accepts. */
  choices?: string[];
};

/** How long an ask keeps waiting after the customer's latest message. */
export const SCENARIO_PROMPT_INPUT_WAIT_HOURS = [1, 24, 168] as const;
export type ScenarioPromptInputWaitHours =
  (typeof SCENARIO_PROMPT_INPUT_WAIT_HOURS)[number];

/** How a message that asks for details treats the replies it gets. */
export type ScenarioPromptInputBehavior = {
  /** Without the customer's words for this long, the ask stops waiting. */
  waitHours?: ScenarioPromptInputWaitHours;
  /** A buttons, list or carousel ask reads an option named in words as its tap. */
  typedChoice?: boolean;
  /**
   * Words sent before the tap get one nudge to tap, unless the assistant
   * answers them. Every nudge is a paid message.
   */
  nudgeOnce?: boolean;
};

const DEFAULT_SCENARIO_PROMPT_INPUT_BEHAVIOR: Required<ScenarioPromptInputBehavior> =
  { waitHours: 24, typedChoice: true, nudgeOnce: true };

export type ScenarioPromptInputDiagnosticCode =
  | "prompt_input_key_invalid"
  | "prompt_input_prompt_required"
  | "prompt_input_prompt_too_long"
  | "prompt_input_label_too_long"
  | "prompt_input_key_duplicate"
  | "prompt_input_count_invalid"
  | "prompt_inputs_kind_unsupported"
  | "prompt_inputs_require_fixed_body"
  | "prompt_input_max_length_invalid"
  | "prompt_input_choices_invalid";

export type ScenarioPromptInputDiagnostic = {
  code: ScenarioPromptInputDiagnosticCode;
  path: string;
};

export type CollectedPromptInputs = {
  scenarioId: string;
  sourceActionNodeId: string;
  awaitingReply: boolean;
  resumeActionNodeId: string | null;
  sourcePathNodeIds: string[];
  values: Record<string, string>;
  /** A buttons, list or carousel ask, which continues on the tapped branch. */
  followsChoice: boolean;
  /** The option tapped on that ask; its branch is `resumeActionNodeId`. */
  choiceOptionId: string | null;
  /** When the ask stops waiting: its wait period after the latest reply. */
  expiresAt: string | null;
  /** The one nudge to tap was sent for this ask. */
  nudged: boolean;
};

/** What a reply said: each detail's answer, and the option it named. */
export type ScenarioPromptInputExtraction = {
  values: Record<string, string | null>;
  /** Read only while options are offered; null when the reply named none. */
  choiceOptionId: string | null;
};

/** Words sent before the tap: they answered a detail, or nothing the ask needs. */
export type ScenarioPromptInputUntapped = "answered" | "unrelated";

export type ServiceMessagePromptInputDispatch =
  | { type: "none" }
  | { type: "wait"; collection: CollectedPromptInputs }
  | {
      type: "hold";
      collection: CollectedPromptInputs;
      untapped?: ScenarioPromptInputUntapped;
    }
  | {
      type: "met";
      collection: CollectedPromptInputs;
      resumeActionNodeId: string;
      sourcePathNodeIds: string[];
    }
  | { type: "stored"; collection: CollectedPromptInputs }
  | { type: "unmet"; collection: CollectedPromptInputs };

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Template namespace of collected answers: `{{input.<key>}}`. */
export const SCENARIO_PROMPT_INPUT_NAMESPACE = "input";
const SCENARIO_PROMPT_INPUT_TOKEN_PREFIX = `${SCENARIO_PROMPT_INPUT_NAMESPACE}.`;

export function scenarioPromptInputToken(key: string): string {
  return `${SCENARIO_PROMPT_INPUT_TOKEN_PREFIX}${key.trim()}`;
}

export function isScenarioPromptInputKey(value: string): boolean {
  return SCENARIO_PROMPT_INPUT_KEY_PATTERN.test(value);
}

/** The answer key an `input.<key>` token names, or null for any other token. */
export function parseScenarioPromptInputToken(token: string): string | null {
  if (!token.startsWith(SCENARIO_PROMPT_INPUT_TOKEN_PREFIX)) return null;
  const key = token.slice(SCENARIO_PROMPT_INPUT_TOKEN_PREFIX.length);
  return isScenarioPromptInputKey(key) ? key : null;
}

const PROMPT_INPUT_CHOICE_MESSAGE_KINDS = new Set([
  "reply_buttons",
  "list",
  "media_carousel",
]);

/**
 * How a message asks for details. A text message reads the reply; a buttons,
 * list or carousel message reads the reply that follows the customer's tap
 * and then continues on the tapped branch.
 */
export type ScenarioPromptInputAsk = "text" | "choice";

/** The ask a message kind makes, before its options are checked. */
export function readScenarioPromptInputAskKind(
  messageKind: unknown,
): ScenarioPromptInputAsk | null {
  if (messageKind === "text") return "text";
  return typeof messageKind === "string" &&
    PROMPT_INPUT_CHOICE_MESSAGE_KINDS.has(messageKind)
    ? "choice"
    : null;
}

/** The ask a message makes: a choice message needs an option to tap. */
export function readScenarioPromptInputAsk(
  message: unknown,
): ScenarioPromptInputAsk | null {
  if (!isRecord(message)) return null;
  const ask = readScenarioPromptInputAskKind(message.kind);
  return ask === "choice" &&
    listScenarioWhatsAppServicePayloadOptions(message).length === 0
    ? null
    : ask;
}

function readFixedBodyText(message: unknown): string {
  if (!isRecord(message) || !isRecord(message.body)) return "";
  return message.body.mode === "fixed"
    ? asString(message.body.text).trim()
    : "";
}

/** A detail's answer rules as stored; validation reports values out of range. */
function readFieldRules(
  item: Record<string, unknown>,
): Pick<ScenarioPromptInputField, "format" | "maxLength" | "choices"> {
  const format =
    SCENARIO_PROMPT_INPUT_FORMATS.find((known) => known === item.format) ??
    "text";
  // Numbers and choices keep their fixed length, as the editor offers none.
  const maxLength =
    (format === "text" || format === "name") &&
    typeof item.maxLength === "number" &&
    Number.isFinite(item.maxLength)
      ? item.maxLength
      : undefined;
  // One overflow entry, so validation still sees too many choices.
  const choices =
    format === "choice" && Array.isArray(item.choices)
      ? item.choices
          .filter((choice): choice is string => typeof choice === "string")
          .slice(0, MAX_SCENARIO_PROMPT_INPUT_CHOICES + 1)
      : undefined;
  return {
    ...(format !== "text" ? { format } : {}),
    ...(maxLength !== undefined ? { maxLength } : {}),
    ...(choices ? { choices } : {}),
  };
}

/** Keep in-progress rows so the editor can show a field that is not runnable yet. */
export function readScenarioPromptInputDraft(
  value: unknown,
): ScenarioPromptInputField[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const fields: ScenarioPromptInputField[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    fields.push({
      key: asString(item.key),
      label: asString(item.label),
      prompt: asString(item.prompt),
      ...readFieldRules(item),
    });
    // Retain one overflow row so normalization cannot hide an invalid count.
    // Bound the draft without turning an over-limit ask into a runnable one.
    if (fields.length > MAX_SCENARIO_PROMPT_INPUTS) break;
  }
  return fields.length > 0 ? fields : undefined;
}

export function validateScenarioPromptInputs(params: {
  fields: ScenarioPromptInputField[] | undefined;
  /** The service message's `message` payload. */
  message: unknown;
}): ScenarioPromptInputDiagnostic[] {
  const fields = params.fields;
  if (!fields || fields.length === 0) return [];
  const diagnostics: ScenarioPromptInputDiagnostic[] = [];
  if (!readScenarioPromptInputAsk(params.message)) {
    diagnostics.push({
      code: "prompt_inputs_kind_unsupported",
      path: "promptInputs",
    });
  } else if (!readFixedBodyText(params.message)) {
    diagnostics.push({
      code: "prompt_inputs_require_fixed_body",
      path: "promptInputs",
    });
  }
  if (fields.length > MAX_SCENARIO_PROMPT_INPUTS) {
    diagnostics.push({
      code: "prompt_input_count_invalid",
      path: "promptInputs",
    });
  }
  const seen = new Set<string>();
  fields.forEach((field, index) => {
    const key = field.key.trim();
    const prompt = field.prompt.trim();
    const label = field.label.trim();
    if (!isScenarioPromptInputKey(key)) {
      diagnostics.push({
        code: "prompt_input_key_invalid",
        path: `promptInputs.${index}.key`,
      });
    } else if (seen.has(key)) {
      diagnostics.push({
        code: "prompt_input_key_duplicate",
        path: `promptInputs.${index}.key`,
      });
    }
    if (key) seen.add(key);
    if (!prompt) {
      diagnostics.push({
        code: "prompt_input_prompt_required",
        path: `promptInputs.${index}.prompt`,
      });
    } else if (prompt.length > MAX_SCENARIO_PROMPT_INPUT_PROMPT_CHARACTERS) {
      diagnostics.push({
        code: "prompt_input_prompt_too_long",
        path: `promptInputs.${index}.prompt`,
      });
    }
    if (label.length > MAX_SCENARIO_PROMPT_INPUT_LABEL_CHARACTERS) {
      diagnostics.push({
        code: "prompt_input_label_too_long",
        path: `promptInputs.${index}.label`,
      });
    }
    if (
      field.maxLength !== undefined &&
      (!Number.isInteger(field.maxLength) ||
        field.maxLength < 1 ||
        field.maxLength > MAX_SCENARIO_PROMPT_INPUT_ANSWER_CHARACTERS)
    ) {
      diagnostics.push({
        code: "prompt_input_max_length_invalid",
        path: `promptInputs.${index}.maxLength`,
      });
    }
    if (field.format === "choice" && !hasValidChoices(field.choices)) {
      diagnostics.push({
        code: "prompt_input_choices_invalid",
        path: `promptInputs.${index}.choices`,
      });
    }
  });
  return diagnostics;
}

/** Two to twelve distinct answers of 1 to 60 characters. */
function hasValidChoices(choices: readonly string[] | undefined): boolean {
  if (!choices) return false;
  const trimmed = choices.map((choice) => choice.trim());
  const distinct = new Set(trimmed.map((choice) => choice.toLocaleLowerCase()));
  return (
    trimmed.length >= 2 &&
    trimmed.length <= MAX_SCENARIO_PROMPT_INPUT_CHOICES &&
    distinct.size === trimmed.length &&
    trimmed.every(
      (choice) =>
        choice.length > 0 &&
        choice.length <= MAX_SCENARIO_PROMPT_INPUT_CHOICE_CHARACTERS,
    )
  );
}

export function listRunnableScenarioPromptInputs(
  config: Pick<ScenarioWhatsAppServiceMessage, "message" | "promptInputs">,
): ScenarioPromptInputField[] | null {
  const fields = config.promptInputs;
  if (!fields || fields.length === 0) return null;
  if (
    validateScenarioPromptInputs({ fields, message: config.message }).length > 0
  ) {
    return null;
  }
  return fields.map((field) => ({
    key: field.key.trim(),
    label: field.label.trim() || field.key.trim(),
    prompt: field.prompt.trim(),
    ...(field.format ? { format: field.format } : {}),
    ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
    ...(field.format === "choice" && field.choices
      ? { choices: field.choices.map((choice) => choice.trim()) }
      : {}),
  }));
}

/** Stored reply rules without unknown keys or values out of range. */
export function normalizeScenarioPromptInputBehavior(
  value: unknown,
): ScenarioPromptInputBehavior | undefined {
  if (!isRecord(value)) return undefined;
  const behavior: ScenarioPromptInputBehavior = {};
  const waitHours = SCENARIO_PROMPT_INPUT_WAIT_HOURS.find(
    (hours) => hours === value.waitHours,
  );
  if (waitHours) behavior.waitHours = waitHours;
  if (typeof value.typedChoice === "boolean") {
    behavior.typedChoice = value.typedChoice;
  }
  if (typeof value.nudgeOnce === "boolean") {
    behavior.nudgeOnce = value.nudgeOnce;
  }
  return Object.keys(behavior).length > 0 ? behavior : undefined;
}

/** The ask's reply rules, with the default for each rule it does not set. */
export function readScenarioPromptInputBehavior(
  config: Pick<ScenarioWhatsAppServiceMessage, "promptInputBehavior">,
): Required<ScenarioPromptInputBehavior> {
  return {
    ...DEFAULT_SCENARIO_PROMPT_INPUT_BEHAVIOR,
    ...normalizeScenarioPromptInputBehavior(config.promptInputBehavior),
  };
}

/** The longest answer a detail accepts. */
export function resolveScenarioPromptInputMaxLength(
  field: Pick<ScenarioPromptInputField, "format" | "maxLength">,
): number {
  return (
    field.maxLength ??
    DEFAULT_SCENARIO_PROMPT_INPUT_MAX_LENGTH[field.format ?? "text"]
  );
}

// Letters and marks, with inner spaces, dots, hyphens and apostrophes.
const NAME_ANSWER_PATTERN =
  /^[\p{L}\p{M}](?:[\p{L}\p{M} .'\u2019-]*[\p{L}\p{M}.])?$/u;
const NUMBER_ANSWER_PATTERN = /^[+-]?\d+(?:[.,]\d+)?$/;

/**
 * A detail's answer as it is stored, or null when it breaks the detail's
 * rules: the detail then counts as missing.
 */
export function readScenarioPromptInputAnswer(
  field: Pick<ScenarioPromptInputField, "format" | "maxLength" | "choices">,
  raw: string,
): string | null {
  const answer = normalizeAnswer(raw);
  if (!answer || answer.length > resolveScenarioPromptInputMaxLength(field)) {
    return null;
  }
  switch (field.format) {
    case "name":
      return NAME_ANSWER_PATTERN.test(answer) ? answer : null;
    case "number": {
      const compact = answer.replace(/\s+/g, "");
      return NUMBER_ANSWER_PATTERN.test(compact) ? compact : null;
    }
    case "choice": {
      const wanted = answer.toLocaleLowerCase();
      return (
        field.choices?.find(
          (choice) => choice.toLocaleLowerCase() === wanted,
        ) ?? null
      );
    }
    default:
      return answer;
  }
}

const FLOW_TEXT_PROMPT_FIELD_TYPES = new Set(["TextInput", "TextArea"]);

/**
 * The Flow a node sends, with the owner rule of the web interactive-Flow
 * resolver: a service message owns its node's Flow; otherwise a template
 * action may attach one. Both submit answers keyed by field id. A message
 * key left undefined, as the builder's type change leaves it, is no service
 * message; a saved null still is.
 */
export function readScenarioActionFlowConfig(data: unknown): unknown {
  if (!isRecord(data)) return null;
  if (data.actionWhatsAppServiceMessage !== undefined) {
    const serviceMessage = data.actionWhatsAppServiceMessage;
    if (!isRecord(serviceMessage) || !isRecord(serviceMessage.message)) {
      return null;
    }
    if (serviceMessage.message.kind !== "flow") return null;
    return serviceMessage.message.flowConfig ?? null;
  }
  return data.actionType === "whatsapp_template"
    ? (data.actionFlowConfig ?? null)
    : null;
}

/** Flow text fields need no model extraction. Answer storage is normalized and bounded. */
export function listScenarioFlowTextPromptInputs(
  nodeData: unknown,
): ScenarioPromptInputField[] {
  const flowConfig = readScenarioActionFlowConfig(nodeData);
  if (!isRecord(flowConfig) || !Array.isArray(flowConfig.screens)) return [];
  const fields: ScenarioPromptInputField[] = [];
  const seen = new Set<string>();
  for (const screen of flowConfig.screens) {
    if (!isRecord(screen) || !Array.isArray(screen.fields)) continue;
    for (const field of screen.fields) {
      if (
        !isRecord(field) ||
        !FLOW_TEXT_PROMPT_FIELD_TYPES.has(asString(field.fieldType))
      ) {
        continue;
      }
      const key = asString(field.id).trim();
      if (
        key === "flow_token" ||
        !isScenarioPromptInputKey(key) ||
        seen.has(key)
      ) {
        continue;
      }
      seen.add(key);
      const label = asString(field.label).trim() || key;
      fields.push({ key, label, prompt: label });
    }
  }
  return fields;
}

/** A Flow reply's answers: top-level keys, with nested `values` on top. */
export function readScenarioFlowResponseRecord(
  responseJson: string | null | undefined,
): Record<string, unknown> | null {
  const raw = (responseJson ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const values = isRecord(parsed.values) ? parsed.values : {};
    return { ...parsed, ...values };
  } catch {
    return null;
  }
}

export function readFlowTextPromptInputAnswers(params: {
  fields: readonly ScenarioPromptInputField[];
  responseJson?: string | null;
}): Record<string, string> {
  const record = readScenarioFlowResponseRecord(params.responseJson);
  if (!record) return {};
  const values: Record<string, string> = {};
  for (const field of params.fields) {
    if (!isScenarioPromptInputKey(field.key) || !Object.hasOwn(record, field.key)) {
      continue;
    }
    const raw = record[field.key];
    if (typeof raw !== "string") continue;
    const answer = normalizeAnswer(raw);
    if (!answer) continue;
    values[field.key] = answer;
  }
  return values;
}

export function buildFlowPromptInputInboundText(params: {
  fields: readonly ScenarioPromptInputField[];
  values: Record<string, string>;
}): string {
  return params.fields
    .flatMap((field) => {
      if (!Object.hasOwn(params.values, field.key)) return [];
      const answer = params.values[field.key];
      if (typeof answer !== "string" || !answer.trim()) return [];
      return [`${field.label}: ${answer}`];
    })
    .join("\n");
}

export type FlowTextPromptInputCapture = {
  sourceActionNodeId: string;
  values: Record<string, string>;
};

/** Nearest earlier Flow on the path that submitted text answers. */
export function captureFlowTextPromptInputs(params: {
  pathNodes: ReadonlyArray<{ id: string; data?: unknown }>;
  selectedActionNodeId: string;
  responseJson?: string | null;
}): FlowTextPromptInputCapture | null {
  const selectedActionNodeId = params.selectedActionNodeId.trim();
  for (let index = params.pathNodes.length - 1; index >= 0; index -= 1) {
    const node = params.pathNodes[index];
    if (!node || node.id === selectedActionNodeId) continue;
    const fields = listScenarioFlowTextPromptInputs(node.data);
    if (fields.length === 0) continue;
    const values = readFlowTextPromptInputAnswers({
      fields,
      responseJson: params.responseJson,
    });
    if (Object.keys(values).length === 0) return null;
    return { sourceActionNodeId: node.id, values };
  }
  return null;
}

export function mergePromptInputAnswersIntoScenarioState(params: {
  state: unknown;
  scenarioId: string;
  sourceActionNodeId: string;
  sourcePathNodeIds: string[];
  values: Record<string, string>;
}): Record<string, unknown> | null {
  const incoming = readFlowTextPromptInputAnswers({
    fields: Object.keys(params.values).map((key) => ({
      key,
      label: key,
      prompt: key,
    })),
    responseJson: JSON.stringify(params.values),
  });
  if (Object.keys(incoming).length === 0) return null;
  const existing = readCollectedPromptInputs(params.state);
  const sameScenario =
    existing && existing.scenarioId === params.scenarioId ? existing : null;
  // An ask waiting on another node keeps waiting there.
  const kept =
    sameScenario?.awaitingReply &&
    sameScenario.sourceActionNodeId !== params.sourceActionNodeId
      ? sameScenario
      : {
          sourceActionNodeId: params.sourceActionNodeId,
          awaitingReply: false,
          resumeActionNodeId: null,
          sourcePathNodeIds: params.sourcePathNodeIds,
          followsChoice: false,
          choiceOptionId: null,
          expiresAt: null,
          nudged: false,
        };
  const collection = normalizeCollectedPromptInputs({
    ...kept,
    scenarioId: params.scenarioId,
    values: { ...(sameScenario?.values ?? {}), ...incoming },
  });
  if (!collection) return null;
  return mergeCollectedPromptInputsIntoScenarioState(
    isRecord(params.state) ? params.state : {},
    { collection },
  );
}

export function listInsertableScenarioPromptInputs(
  nodes: ReadonlyArray<{
    data?: { actionWhatsAppServiceMessage?: unknown };
  }>,
): ScenarioPromptInputField[] {
  const fields: ScenarioPromptInputField[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const config = node.data?.actionWhatsAppServiceMessage;
    if (!isRecord(config) || !isRecord(config.message)) continue;
    if (!readScenarioPromptInputAskKind(config.message.kind)) continue;
    const draft = readScenarioPromptInputDraft(config.promptInputs);
    if (!draft) continue;
    for (const field of draft) {
      const key = field.key.trim();
      if (!isScenarioPromptInputKey(key) || seen.has(key)) continue;
      seen.add(key);
      fields.push({
        key,
        label: field.label.trim() || key,
        prompt: field.prompt.trim(),
      });
    }
  }
  return fields;
}

function normalizeAnswer(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, MAX_SCENARIO_PROMPT_INPUT_ANSWER_CHARACTERS);
}

function readAwaitingReply(value: Record<string, unknown>): boolean {
  if (typeof value.awaitingReply === "boolean") return value.awaitingReply;
  const pending = value.pendingFieldKey;
  return (
    typeof pending === "string" && isScenarioPromptInputKey(pending.trim())
  );
}

const PROMPT_INPUT_SOURCE_LABELS: Record<CustomerMessageTextSource, string> = {
  text: "Text",
  audio_analysis: "Audio",
  video_analysis: "Video",
};

/** Every part the customer said, with line breaks normalized and each part bounded. */
function readScenarioPromptInputSource(parts: CustomerMessageTextParts) {
  return listCustomerMessageTextParts(parts).map((part) => ({
    label: PROMPT_INPUT_SOURCE_LABELS[part.source],
    value: part.text
      .replace(/\r\n?/g, "\n")
      .slice(0, MAX_SCENARIO_PROMPT_INPUT_SOURCE_CHARACTERS),
  }));
}

/** Text plus stored audio and video analysis, skipping media placeholders. */
export function buildScenarioPromptInputSourceText(
  parts: CustomerMessageTextParts,
): string {
  return readScenarioPromptInputSource(parts)
    .map((section) => `${section.label}:\n${section.value}`)
    .join("\n\n");
}

/**
 * The same words without extraction labels. An action resumed by a reply
 * that completed its collector receives the answer the collector accepted.
 */
export function buildScenarioPromptInputAnswerText(
  parts: CustomerMessageTextParts,
): string {
  return readScenarioPromptInputSource(parts)
    .map((section) => section.value)
    .join("\n\n");
}

/** The ask an action makes once it names a detail, drafts included. */
export function readScenarioActionPromptInputAsk(data: {
  kind?: string;
  actionWhatsAppServiceMessage?: unknown;
}): ScenarioPromptInputAsk | null {
  if (data.kind !== "action") return null;
  const config = data.actionWhatsAppServiceMessage;
  if (!isRecord(config) || !isRecord(config.message)) return null;
  const ask = readScenarioPromptInputAskKind(config.message.kind);
  const draft = ask ? readScenarioPromptInputDraft(config.promptInputs) : null;
  return draft?.some((field) => isScenarioPromptInputKey(field.key.trim()))
    ? ask
    : null;
}

export function scenarioActionCollectsPromptInputs(data: {
  kind?: string;
  actionWhatsAppServiceMessage?: unknown;
}): boolean {
  return readScenarioActionPromptInputAsk(data) !== null;
}

export function isServiceMessagePromptInputAwaiting(params: {
  collection: CollectedPromptInputs | null;
  scenarioId: string;
  sourceActionNodeId: string;
}): boolean {
  return Boolean(
    params.collection &&
      params.collection.scenarioId === params.scenarioId &&
      params.collection.sourceActionNodeId === params.sourceActionNodeId &&
      params.collection.awaitingReply,
  );
}

export function applyScenarioPromptInputExtraction(params: {
  fields: ScenarioPromptInputField[];
  priorValues: Record<string, string>;
  extracted: Record<string, string | null> | null;
}): {
  values: Record<string, string>;
  met: boolean;
  /** The reply gave at least one detail an answer that fits its rules. */
  supplied: boolean;
} {
  const values = { ...params.priorValues };
  let supplied = false;
  if (params.extracted) {
    for (const field of params.fields) {
      if (!isScenarioPromptInputKey(field.key) || !Object.hasOwn(params.extracted, field.key)) {
        continue;
      }
      const raw = params.extracted[field.key];
      if (typeof raw !== "string") continue;
      const answer = readScenarioPromptInputAnswer(field, raw);
      if (!answer) continue;
      values[field.key] = answer;
      supplied = true;
    }
  }
  const storedValues = readValues(values);
  return {
    supplied,
    values: storedValues,
    met: params.fields.every((field) => {
      const answer = storedValues[field.key];
      return (
        Object.hasOwn(storedValues, field.key) &&
        typeof answer === "string" &&
        answer.length > 0
      );
    }),
  };
}

function readValues(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const values: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isScenarioPromptInputKey(key) || typeof raw !== "string") continue;
    const answer = normalizeAnswer(raw);
    if (!answer) continue;
    values[key] = answer;
    if (Object.keys(values).length > MAX_STORED_SCENARIO_PROMPT_INPUT_VALUES) {
      // Fail before a caller persists state or dispatches the next action.
      // The original state and inbound message remain available for recovery.
      throw new ScenarioPromptInputCapacityError();
    }
  }
  return values;
}

export function normalizeCollectedPromptInputs(
  value: unknown,
): CollectedPromptInputs | null {
  if (!isRecord(value)) return null;
  const scenarioId = asString(value.scenarioId).trim();
  const sourceActionNodeId = asString(value.sourceActionNodeId).trim();
  if (!scenarioId || !sourceActionNodeId) return null;
  if (scenarioId.length > 128 || sourceActionNodeId.length > 128) return null;
  const awaitingReply = readAwaitingReply(value);
  const resumeRaw = value.resumeActionNodeId;
  const resumeActionNodeId =
    resumeRaw === null || resumeRaw === undefined
      ? null
      : asString(resumeRaw).trim() || null;
  if (resumeActionNodeId && resumeActionNodeId.length > 128) return null;
  const sourcePathNodeIds = Array.isArray(value.sourcePathNodeIds)
    ? value.sourcePathNodeIds
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 64)
    : [];
  const choiceOptionId = asString(value.choiceOptionId).trim();
  // Asks stored without one keep waiting until their next reply sets one.
  const expiresAt =
    value.expiresAt instanceof Date
      ? value.expiresAt
      : new Date(asString(value.expiresAt));
  return {
    scenarioId,
    sourceActionNodeId,
    awaitingReply,
    resumeActionNodeId,
    sourcePathNodeIds,
    values: readValues(value.values),
    followsChoice: value.followsChoice === true,
    choiceOptionId:
      choiceOptionId && choiceOptionId.length <= 256 ? choiceOptionId : null,
    expiresAt: Number.isFinite(expiresAt.getTime())
      ? expiresAt.toISOString()
      : null,
    nudged: value.nudged === true,
  };
}

function isPromptInputAskExpired(
  collection: CollectedPromptInputs,
  now: Date,
): boolean {
  return Boolean(
    collection.expiresAt && Date.parse(collection.expiresAt) <= now.getTime(),
  );
}

const HOUR_MS = 60 * 60 * 1000;

function readPromptInputAskExpiresAt(
  config: Pick<ScenarioWhatsAppServiceMessage, "promptInputBehavior">,
  now: Date,
): string {
  const { waitHours } = readScenarioPromptInputBehavior(config);
  return new Date(now.getTime() + waitHours * HOUR_MS).toISOString();
}

export function readCollectedPromptInputs(
  state: unknown,
): CollectedPromptInputs | null {
  if (!isRecord(state)) return null;
  return normalizeCollectedPromptInputs(state.collectedPromptInputs);
}

/**
 * Answers are offered only to the scenario that collected them. A turn without
 * a running scenario, or state left by another scenario, yields no answers.
 */
export function readCollectedPromptInputValues(
  state: unknown,
  scenarioId: string | null | undefined,
): Record<string, string> {
  const collection = readCollectedPromptInputs(state);
  if (!scenarioId || collection?.scenarioId !== scenarioId) return {};
  return collection.values;
}

export function mergeCollectedPromptInputsIntoScenarioState(
  state: unknown,
  patch: {
    collection: CollectedPromptInputs;
    currentActionNodeId?: string | null;
    currentPathNodeIds?: string[];
  },
): Record<string, unknown> {
  const base = isRecord(state) ? { ...state } : {};
  return {
    ...base,
    collectedPromptInputs: patch.collection,
    ...(patch.currentActionNodeId !== undefined
      ? { currentActionNodeId: patch.currentActionNodeId }
      : {}),
    ...(patch.currentPathNodeIds
      ? { currentPathNodeIds: patch.currentPathNodeIds }
      : {}),
  };
}

/**
 * The options a customer may name in words while a buttons, list or carousel
 * ask still waits for its tap. Empty when the ask does not read typed choices.
 */
export function listScenarioPromptInputTypedChoices(params: {
  config: ScenarioWhatsAppServiceMessage | null | undefined;
  collection: CollectedPromptInputs | null;
  scenarioId: string;
  sourceActionNodeId: string;
}): ScenarioWhatsAppServiceOption[] {
  const config = params.config;
  if (
    !config ||
    readScenarioPromptInputAskKind(config.message.kind) !== "choice" ||
    !readScenarioPromptInputBehavior(config).typedChoice ||
    params.collection?.choiceOptionId ||
    !isServiceMessagePromptInputAwaiting(params)
  ) {
    return [];
  }
  return listScenarioWhatsAppServicePayloadOptions(config.message);
}

export function serviceMessagePromptInputNeedsExtraction(params: {
  config: ScenarioWhatsAppServiceMessage | null | undefined;
  collection: CollectedPromptInputs | null;
  scenarioId: string;
  sourceActionNodeId: string;
  consumeInbound: boolean;
}): boolean {
  if (!params.consumeInbound || !params.config) return false;
  if (!listRunnableScenarioPromptInputs(params.config)) return false;
  return isServiceMessagePromptInputAwaiting(params);
}

export function resolveServiceMessagePromptInputDispatch(params: {
  config: ScenarioWhatsAppServiceMessage | null | undefined;
  collection: CollectedPromptInputs | null;
  scenarioId: string;
  sourceActionNodeId: string;
  resumeActionNodeId: string | null;
  sourcePathNodeIds: string[];
  consumeInbound: boolean;
  extractedValues?: Record<string, string | null> | null;
  /** The option the reply named in words, when the ask reads typed choices. */
  typedChoiceOptionId?: string | null;
  now?: Date;
}): ServiceMessagePromptInputDispatch {
  const config = params.config;
  if (!config) return { type: "none" };
  const fields = listRunnableScenarioPromptInputs(config);
  if (!fields) return { type: "none" };

  const sameScenario =
    params.collection && params.collection.scenarioId === params.scenarioId
      ? params.collection
      : null;
  const waitingHere = isServiceMessagePromptInputAwaiting({
    collection: sameScenario,
    scenarioId: params.scenarioId,
    sourceActionNodeId: params.sourceActionNodeId,
  });
  const liveResume =
    params.resumeActionNodeId &&
    params.resumeActionNodeId !== params.sourceActionNodeId
      ? params.resumeActionNodeId
      : null;
  const resumeActionNodeId =
    liveResume ||
    (waitingHere ? sameScenario?.resumeActionNodeId || null : null);
  const sourcePathNodeIds =
    params.sourcePathNodeIds.length > 0
      ? params.sourcePathNodeIds
      : sameScenario?.sourcePathNodeIds || [];
  const priorValues = { ...(sameScenario?.values ?? {}) };
  const followsChoice = readScenarioPromptInputAsk(config.message) === "choice";
  // A new ask forgets an earlier tap; a reply to this ask keeps it.
  const tappedOptionId =
    followsChoice && waitingHere
      ? (sameScenario?.choiceOptionId ?? null)
      : null;
  // Sending the ask and every reply to it restart its wait period.
  const expiresAt = readPromptInputAskExpiresAt(
    config,
    params.now ?? new Date(),
  );

  const wait = (): ServiceMessagePromptInputDispatch => ({
    type: "wait",
    collection: {
      scenarioId: params.scenarioId,
      sourceActionNodeId: params.sourceActionNodeId,
      resumeActionNodeId: liveResume || resumeActionNodeId,
      sourcePathNodeIds,
      awaitingReply: true,
      values: priorValues,
      followsChoice,
      choiceOptionId: null,
      expiresAt,
      nudged: false,
    },
  });

  if (!waitingHere || !sameScenario) return wait();
  // null/undefined means extraction was unavailable, not that the customer
  // omitted a detail. Only a successful result may take the unmet edge.
  if (!params.consumeInbound || params.extractedValues == null) {
    return {
      type: "hold",
      collection: {
        scenarioId: params.scenarioId,
        sourceActionNodeId: params.sourceActionNodeId,
        resumeActionNodeId,
        sourcePathNodeIds,
        awaitingReply: true,
        values: priorValues,
        followsChoice,
        choiceOptionId: tappedOptionId,
        // A turn that reads no reply leaves the wait period as it was.
        expiresAt: params.consumeInbound
          ? expiresAt
          : (sameScenario.expiresAt ?? expiresAt),
        nudged: sameScenario.nudged,
      },
    };
  }

  const applied = applyScenarioPromptInputExtraction({
    fields,
    priorValues,
    extracted: params.extractedValues ?? null,
  });
  // An option named in words counts as the tap while the ask waits for one.
  const typedOptionId =
    listScenarioPromptInputTypedChoices(params).find(
      (option) => option.id === params.typedChoiceOptionId,
    )?.id ?? null;
  const choiceOptionId = tappedOptionId ?? typedOptionId;
  const collection: CollectedPromptInputs = {
    scenarioId: params.scenarioId,
    sourceActionNodeId: params.sourceActionNodeId,
    resumeActionNodeId,
    sourcePathNodeIds,
    awaitingReply: false,
    values: applied.values,
    followsChoice,
    choiceOptionId,
    expiresAt,
    nudged: sameScenario.nudged,
  };
  // Before the tap there is no branch to continue on, and a partial answer
  // is not yet unmet: keep what was read and wait for the tap.
  if (followsChoice && !choiceOptionId) {
    return {
      type: "hold",
      collection: { ...collection, awaitingReply: true },
      untapped: applied.supplied ? "answered" : "unrelated",
    };
  }
  // After a tap named in words, the details still to come follow it.
  if (typedOptionId && !applied.met) {
    return { type: "hold", collection: { ...collection, awaitingReply: true } };
  }
  if (!applied.met) return { type: "unmet", collection };
  // A choice ask continues by replaying its tap from the message.
  const resumeTo = followsChoice
    ? (resumeActionNodeId ?? params.sourceActionNodeId)
    : resumeActionNodeId;
  if (resumeTo === null) return { type: "stored", collection };
  return {
    type: "met",
    collection,
    resumeActionNodeId: resumeTo,
    sourcePathNodeIds,
  };
}

export type ServiceMessagePromptInputChoice =
  | { type: "none" }
  | { type: "continue"; collection: CollectedPromptInputs }
  | { type: "hold"; collection: CollectedPromptInputs };

/**
 * A tap on a buttons, list or carousel message that asks for details. The
 * tapped branch is where the ask resumes: with every detail already read,
 * routing continues now; otherwise the ask waits for the customer's words.
 * A tap on a message that asks nothing is ordinary routing.
 */
export function resolveServiceMessagePromptInputChoice(params: {
  config: ScenarioWhatsAppServiceMessage | null | undefined;
  collection: CollectedPromptInputs | null;
  scenarioId: string;
  sourceActionNodeId: string;
  optionId: string;
  resumeActionNodeId: string | null;
  sourcePathNodeIds: string[];
  now?: Date;
}): ServiceMessagePromptInputChoice {
  const config = params.config;
  const fields = config ? listRunnableScenarioPromptInputs(config) : null;
  const optionId = params.optionId.trim();
  if (
    !config ||
    !fields ||
    readScenarioPromptInputAsk(config.message) !== "choice" ||
    !optionId ||
    !params.resumeActionNodeId
  ) {
    return { type: "none" };
  }
  const sameAsk =
    params.collection?.scenarioId === params.scenarioId &&
    params.collection.sourceActionNodeId === params.sourceActionNodeId
      ? params.collection
      : null;
  const values = { ...(sameAsk?.values ?? {}) };
  const met = applyScenarioPromptInputExtraction({
    fields,
    priorValues: values,
    extracted: null,
  }).met;
  const collection: CollectedPromptInputs = {
    scenarioId: params.scenarioId,
    sourceActionNodeId: params.sourceActionNodeId,
    resumeActionNodeId: params.resumeActionNodeId,
    sourcePathNodeIds: params.sourcePathNodeIds,
    awaitingReply: !met,
    values,
    followsChoice: true,
    choiceOptionId: optionId,
    expiresAt: readPromptInputAskExpiresAt(config, params.now ?? new Date()),
    nudged: sameAsk?.nudged ?? false,
  };
  return met ? { type: "continue", collection } : { type: "hold", collection };
}

/** The ask the locked conversation is anchored on, expired or not. */
function readAnchoredPromptInputAsk(
  state: unknown,
): CollectedPromptInputs | null {
  if (!isRecord(state)) return null;
  const collection = readCollectedPromptInputs(state);
  return collection?.awaitingReply &&
    asString(state.lockedScenarioId).trim() === collection.scenarioId &&
    asString(state.currentActionNodeId).trim() === collection.sourceActionNodeId
    ? collection
    : null;
}

/**
 * The ask the conversation is anchored on while it waits for the customer's
 * words: a text ask, or a buttons, list or carousel ask that also takes a tap.
 * An ask past its wait period takes no more words.
 */
export function readAwaitingScenarioPromptInputAsk(
  state: unknown,
  now: Date = new Date(),
): Pick<
  CollectedPromptInputs,
  "scenarioId" | "sourceActionNodeId" | "followsChoice"
> | null {
  const collection = readAnchoredPromptInputAsk(state);
  if (!collection || isPromptInputAskExpired(collection, now)) return null;
  return {
    scenarioId: collection.scenarioId,
    sourceActionNodeId: collection.sourceActionNodeId,
    followsChoice: collection.followsChoice,
  };
}

/**
 * The ask the conversation is still anchored on after its wait period
 * passed. The customer's next message releases it.
 */
export function readExpiredScenarioPromptInputAsk(
  state: unknown,
  now: Date = new Date(),
): Pick<CollectedPromptInputs, "scenarioId" | "sourceActionNodeId"> | null {
  const collection = readAnchoredPromptInputAsk(state);
  return collection && isPromptInputAskExpired(collection, now)
    ? {
        scenarioId: collection.scenarioId,
        sourceActionNodeId: collection.sourceActionNodeId,
      }
    : null;
}

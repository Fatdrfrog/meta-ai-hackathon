import {
  resolveReplyModeFromNodeData,
  resolveScenarioActionTypeFromNodeData,
} from "@icecore/airi-runtime/scenario-action-semantics";
import {
  buildScenarioFormAnswerSourcesByNodeId,
  claimScenarioFormKey,
  getScenarioWhatsAppServiceBodySource,
  isScenarioFormAnswerKey,
  listScenarioAnswerReferences,
  listScenarioActionFormFields,
  listScenarioFormNames,
  normalizeGenerativeAIActionDraft,
  readScenarioActionForm,
  readScenarioStoredFormKey,
  resolveScenarioFormKeys,
  type ScenarioActionForm,
  type ScenarioFormAnswerSource,
  type ScenarioFormAnswerSourceField,
  type ScenarioNodeData,
  type WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";
import { normalizeReplyCtaTypeForActionNode } from "@/lib/scenarios/normalization";
import {
  buildScenarioWhatsAppInteractiveFlowConfigPatch,
  resolveScenarioWhatsAppInteractiveFlowConfig,
  resolveScenarioWhatsAppServiceMessage,
} from "@/lib/scenarios/whatsapp-service-message";
import { hasTemplateFlowButton } from "@/lib/whatsapp/flows/template-flow-health";
import { isRecord } from "@icecore/shared/lib/value-utils";

/*
 * Form answers in AI prompts, checked the same way by the builder and by
 * activation: which `{{form.<formKey>.<fieldKey>}}` tokens a step's forms
 * provide, and the `answersKey` each form keeps.
 */

type ScenarioFormNode = Readonly<{ id: string; data?: unknown }>;
type ScenarioFormGraph = Parameters<
  typeof buildScenarioFormAnswerSourcesByNodeId
>[0];

/** A `{{form.<formKey>.<fieldKey>}}` token in a prompt. */
export type ScenarioFormAnswerTokenReference = Readonly<{
  token: string;
  formKey: string;
  fieldKey: string;
}>;

/** The form answer tokens a text names, each once, in order. */
export function listScenarioFormAnswerTokenReferences(
  text: string
): ScenarioFormAnswerTokenReference[] {
  return listScenarioAnswerReferences(text).flatMap(reference =>
    reference.kind === "form" ? [reference] : []
  );
}

/**
 * The earlier form and field a token names, or null when no form before the
 * step lists it. A form made in Meta lists no fields, so its answers are
 * never found.
 */
export function findScenarioFormAnswerField<
  TSource extends ScenarioFormAnswerSource,
>(
  sources: readonly TSource[] | undefined,
  reference: Pick<ScenarioFormAnswerTokenReference, "formKey" | "fieldKey">
): { source: TSource; field: ScenarioFormAnswerSourceField } | null {
  for (const source of sources ?? []) {
    if (source.formKey !== reference.formKey) continue;
    const field = source.fields.find(item => item.key === reference.fieldKey);
    if (field) return { source, field };
  }
  return null;
}

/** The earlier form made in Meta whose key a token names, if any. */
export function findScenarioFormAnswerMetaForm<
  TSource extends ScenarioFormAnswerSource,
>(
  sources: readonly TSource[] | undefined,
  reference: Pick<ScenarioFormAnswerTokenReference, "formKey">
): TSource | null {
  return (
    sources?.find(
      source =>
        source.schema === "unknown" && source.formKey === reference.formKey
    ) ?? null
  );
}

/**
 * Form answer tokens in `text` that no form before the step provides. A
 * form made in Meta provides none yet: its answers stay empty until its
 * fields can be listed.
 */
export function listUnavailableScenarioFormAnswerTokens(
  text: string,
  sources: readonly ScenarioFormAnswerSource[] | undefined
): string[] {
  return listScenarioFormAnswerTokenReferences(text)
    .filter(reference => !findScenarioFormAnswerField(sources, reference))
    .map(reference => reference.token);
}

/** The "AI writes" instructions a reply step sends to AI, or "". */
function readAiReplyInstruction(data: ScenarioNodeData): string {
  if (data.actionWhatsAppServiceMessage !== undefined) {
    const resolution = resolveScenarioWhatsAppServiceMessage(data);
    if (resolution.status !== "canonical") return "";
    const body = getScenarioWhatsAppServiceBodySource(resolution.value);
    return body?.mode === "ai" ? body.instruction : "";
  }
  return resolveReplyModeFromNodeData(data) === "ai"
    ? (data.actionReplyInstruction ?? "")
    : "";
}

/**
 * The text of a step that reads form answers: an image or video prompt, or
 * "AI writes" instructions. Fixed text and other steps give "".
 */
export function readScenarioFormAnswerPrompt(data: ScenarioNodeData): string {
  if (data.kind !== "action") return "";
  const actionType = resolveScenarioActionTypeFromNodeData(data);
  if (actionType === "generative_ai") {
    return (
      normalizeGenerativeAIActionDraft(data.actionGenerativeAIConfig)?.prompt ??
      ""
    );
  }
  return actionType === "reply" ? readAiReplyInstruction(data) : "";
}

/**
 * A template step whose saved buttons open no Flow: a form left over from
 * an earlier template, which the step never sends. Unknown buttons keep it.
 */
function isLeftOverTemplateForm(data: unknown): boolean {
  if (!isRecord(data) || data.actionType !== "whatsapp_template") return false;
  const components = data.actionWhatsAppTemplateComponents;
  return (
    Array.isArray(components) &&
    components.length > 0 &&
    !hasTemplateFlowButton(components)
  );
}

/**
 * The forms before each step whose answers its AI prompts can read. A
 * template's left-over form is not one: the template never sends it.
 */
export function buildSentScenarioFormAnswerSourcesByNodeId(
  graph: ScenarioFormGraph
): Map<string, ScenarioFormAnswerSource[]> {
  const sourcesByNodeId = buildScenarioFormAnswerSourcesByNodeId(graph);
  const leftOver = new Set(
    graph.nodes.filter(node => isLeftOverTemplateForm(node.data)).map(n => n.id)
  );
  if (leftOver.size === 0) return sourcesByNodeId;
  for (const [nodeId, sources] of sourcesByNodeId) {
    sourcesByNodeId.set(
      nodeId,
      sources.filter(source => !leftOver.has(source.nodeId))
    );
  }
  return sourcesByNodeId;
}

/**
 * The form answer tokens each AI prompt reads that no form before its step
 * provides, by step, for the steps that read any. Activation blocks on them,
 * and so does every save of an active scenario.
 */
export function listUnavailableScenarioFormAnswerTokensByNodeId(graph: {
  nodes: readonly Readonly<{ id: string; data: ScenarioNodeData }>[];
  edges: ScenarioFormGraph["edges"];
}): Map<string, string[]> {
  const tokensByNodeId = new Map<string, string[]>();
  const prompts = graph.nodes.flatMap(node => {
    const prompt = readScenarioFormAnswerPrompt(node.data);
    return listScenarioFormAnswerTokenReferences(prompt).length > 0
      ? [{ id: node.id, prompt }]
      : [];
  });
  if (prompts.length === 0) return tokensByNodeId;
  const sourcesByNodeId = buildSentScenarioFormAnswerSourcesByNodeId(graph);
  for (const { id, prompt } of prompts) {
    const tokens = listUnavailableScenarioFormAnswerTokens(
      prompt,
      sourcesByNodeId.get(id)
    );
    if (tokens.length > 0) tokensByNodeId.set(id, tokens);
  }
  return tokensByNodeId;
}

/** The form answer tokens AI prompts read, each once, by their form key. */
export function buildScenarioFormAnswerTokensByFormKey(
  nodes: readonly Readonly<{ data: ScenarioNodeData }>[]
): Map<string, string[]> {
  const tokensByFormKey = new Map<string, string[]>();
  for (const node of nodes) {
    const prompt = readScenarioFormAnswerPrompt(node.data);
    for (const { formKey, token } of listScenarioFormAnswerTokenReferences(
      prompt
    )) {
      const tokens = tokensByFormKey.get(formKey) ?? [];
      if (!tokens.includes(token)) tokens.push(token);
      tokensByFormKey.set(formKey, tokens);
    }
  }
  return tokensByFormKey;
}

function readLinkUrls(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((url): url is string => typeof url === "string" && !!url)
    : [];
}

/**
 * A step that sends a form built only in WhatsApp: a template's Flow button
 * with no form built here or read from its Flow, or an older reply's Flow
 * button.
 */
function sendsWhatsAppOnlyForm(data: unknown): boolean {
  if (!isRecord(data) || data.kind !== "action") return false;
  if (readScenarioActionForm(data)) return false;
  if (data.actionType === "whatsapp_template") {
    return hasTemplateFlowButton(data.actionWhatsAppTemplateComponents);
  }
  const nodeData = data as ScenarioNodeData;
  return (
    data.actionWhatsAppServiceMessage === undefined &&
    resolveScenarioActionTypeFromNodeData(nodeData) === "reply" &&
    normalizeReplyCtaTypeForActionNode({
      nodeData,
      actionLinkUrls: readLinkUrls(data.actionLinkUrls),
      actionReplyCtaFlowId: nodeData.actionReplyCtaFlowId,
    }) === "flow"
  );
}

// Read as a form made in Meta: no fields, so no answers to offer.
const WHATSAPP_ONLY_FORM_DATA = {
  kind: "action",
  actionType: "whatsapp_template",
  actionFlowConfig: { screens: [], providerReference: {} },
};

/**
 * Forms built only in WhatsApp before each step, whose fields can't be
 * listed here yet. They have no key, so no variable reads them; the builder
 * only says they are there.
 */
export function buildWhatsAppOnlyScenarioFormSourcesByNodeId(
  graph: ScenarioFormGraph
): Map<string, ScenarioFormAnswerSource[]> {
  const whatsAppOnly = new Set(
    graph.nodes.filter(node => sendsWhatsAppOnlyForm(node.data)).map(n => n.id)
  );
  if (whatsAppOnly.size === 0) return new Map();
  // Only these steps count as forms; every other step keeps its place.
  const nodes = graph.nodes.map(node => ({
    id: node.id,
    data: whatsAppOnly.has(node.id)
      ? WHATSAPP_ONLY_FORM_DATA
      : { kind: node.data?.kind },
  }));
  const sourcesByNodeId = buildScenarioFormAnswerSourcesByNodeId({
    nodes,
    edges: graph.edges,
  });
  for (const [nodeId, sources] of sourcesByNodeId) {
    sourcesByNodeId.set(
      nodeId,
      sources.map(source => ({ ...source, formKey: "", fields: [] }))
    );
  }
  return sourcesByNodeId;
}

/**
 * Steps whose form stores an `answersKey` an earlier form already stores.
 * Answers then go to the earlier form, and this one gets the key the
 * runtime gives it (`_2`) until that key is stored.
 */
export function listDuplicateScenarioFormAnswersKeyNodeIds(
  nodes: readonly ScenarioFormNode[]
): string[] {
  const keys = resolveScenarioFormKeys(nodes);
  return nodes.flatMap(node => {
    const stored = readScenarioStoredFormKey(
      readScenarioActionForm(node.data)?.flowConfig
    );
    return stored && keys.get(node.id) !== stored ? [node.id] : [];
  });
}

/** A form with questions, or a form linked from Meta: not an empty new one. */
function hasFormContent(form: ScenarioActionForm): boolean {
  return (
    listScenarioActionFormFields(form).length > 0 ||
    isRecord(form.flowConfig.providerReference)
  );
}

/**
 * An empty form with no key of its own, whose key no other form's key
 * follows: it has no answers to read yet, so its first save may name it.
 */
function namesItselfOnFirstSave(
  node: ScenarioFormNode,
  nodes: readonly ScenarioFormNode[],
  keys: ReadonlyMap<string, string>
): boolean {
  const form = readScenarioActionForm(node.data);
  if (!form || hasFormContent(form)) return false;
  if (readScenarioStoredFormKey(form.flowConfig)) return false;
  const without = resolveScenarioFormKeys(
    nodes.filter(other => other.id !== node.id)
  );
  return Array.from(without).every(([nodeId, key]) => keys.get(nodeId) === key);
}

/**
 * Each form's key, by sending step, as the runtime resolves it. An empty new
 * form is left out when naming it can move no other form's key, so the form
 * it becomes gets a key from its name.
 */
export function buildScenarioFormAnswersKeysByNodeId(
  nodes: readonly ScenarioFormNode[]
): Map<string, string> {
  const resolved = resolveScenarioFormKeys(nodes);
  const keys = new Map(resolved);
  for (const node of nodes) {
    if (namesItselfOnFirstSave(node, nodes, resolved)) keys.delete(node.id);
  }
  return keys;
}

/** Where a form's key must be unique: its step and every form's key. */
export type ScenarioFormAnswersKeyScope = Readonly<{
  nodeId: string;
  /** Each form's key, from `buildScenarioFormAnswersKeysByNodeId`. */
  formKeysByNodeId: ReadonlyMap<string, string>;
}>;

/**
 * The form with its `answersKey` stored. It keeps a key no other form has.
 * Otherwise a form the step already sends keeps the key its variables use,
 * so no other form's key moves, and a new form gets one from its name.
 * The same config comes back when nothing changes.
 */
export function stampScenarioFormAnswersKey(
  config: WhatsAppFlowConfig,
  scope: ScenarioFormAnswersKeyScope
): WhatsAppFlowConfig {
  const taken = new Set(
    Array.from(scope.formKeysByNodeId).flatMap(([nodeId, key]) =>
      nodeId === scope.nodeId ? [] : [key]
    )
  );
  const stored = config.answersKey?.trim() ?? "";
  if (isScenarioFormAnswerKey(stored) && !taken.has(stored)) {
    return stored === config.answersKey
      ? config
      : { ...config, answersKey: stored };
  }
  const own = scope.formKeysByNodeId.get(scope.nodeId);
  return {
    ...config,
    answersKey:
      own && !taken.has(own)
        ? own
        : claimScenarioFormKey(
            [...listScenarioFormNames(config), config.templateId ?? ""],
            taken
          ),
  };
}

/** Stores a form's key as it is now, so its variables keep reading it. */
export type ScenarioFormAnswersKeyStamp = Readonly<{
  nodeId: string;
  patch: Partial<ScenarioNodeData>;
}>;

/**
 * The patch that stores each form's current key, by that key, for forms
 * that store none yet. Such a key follows node order, so it can move when
 * an earlier form changes; once a prompt reads it, it is stored.
 */
export function buildScenarioFormAnswersKeyStamps(
  nodes: readonly ScenarioFormNode[]
): Map<string, ScenarioFormAnswersKeyStamp> {
  const keys = resolveScenarioFormKeys(nodes);
  const stamps = new Map<string, ScenarioFormAnswersKeyStamp>();
  for (const node of nodes) {
    const key = keys.get(node.id);
    if (!key || !isRecord(node.data)) continue;
    const data = node.data as ScenarioNodeData;
    const config = resolveScenarioWhatsAppInteractiveFlowConfig(data);
    if (!config || readScenarioStoredFormKey(config) === key) continue;
    const patch = buildScenarioWhatsAppInteractiveFlowConfigPatch(data, {
      ...config,
      answersKey: key,
    });
    if (patch) stamps.set(key, { nodeId: node.id, patch });
  }
  return stamps;
}

/** The stamps for forms whose answers a step's AI prompt reads. */
export function listScenarioFormAnswersKeyStampsReadBy(
  data: ScenarioNodeData,
  stamps: ReadonlyMap<string, ScenarioFormAnswersKeyStamp>
): ScenarioFormAnswersKeyStamp[] {
  if (stamps.size === 0) return [];
  const formKeys = new Set(
    listScenarioFormAnswerTokenReferences(
      readScenarioFormAnswerPrompt(data)
    ).map(reference => reference.formKey)
  );
  return Array.from(formKeys).flatMap(formKey => {
    const stamp = stamps.get(formKey);
    return stamp ? [stamp] : [];
  });
}

import {
  humanizeScenarioAnswerKey,
  listScenarioActionFormFields,
  normalizeScenarioWhatsAppTemplateForm,
  parseScenarioFormAnswerToken,
  readScenarioActionForm,
  readScenarioStoredFormKey,
  readSingleWhatsAppTemplateFlowButtonFlowId,
  SCENARIO_WHATSAPP_TEMPLATE_FORM_VERSION,
  type ScenarioNodeData,
  type ScenarioWhatsAppTemplateForm,
} from "@icecore/scenario-contracts";
import { isRecord } from "@icecore/shared/lib/value-utils";
import { isWhatsAppFlowGraphId } from "@/lib/whatsapp/flows/template-flow-health";
import type { TemplateFormAnswerSchema } from "@/lib/whatsapp/flows/template-form-answer-schema";
import {
  buildScenarioFormAnswersKeysByNodeId,
  listUnavailableScenarioFormAnswerTokensByNodeId,
  stampScenarioFormAnswersKey,
} from "./scenario-form-answer-checks";

/*
 * A template step's saved form: the fields of the form its FLOW button
 * opens, read from the Flow, so AI steps can read its answers.
 */

type SnapshotNode = Readonly<{ id: string; data: ScenarioNodeData }>;
type SnapshotEdge = Readonly<{
  source: string;
  target: string;
  sourceHandle?: string | null;
}>;

/** An answer AI prompts read that a refresh of the form no longer gives. */
export type WhatsAppTemplateFormRemovedAnswer = Readonly<{
  token: string;
  label: string;
}>;

export type WhatsAppTemplateFormSnapshotPatch =
  | Readonly<{
      patch: Pick<ScenarioNodeData, "actionWhatsAppTemplateForm">;
      snapshot: ScenarioWhatsAppTemplateForm;
      newlyUnavailable: WhatsAppTemplateFormRemovedAnswer[];
    }>
  | Readonly<{ unchanged: true }>;

/**
 * The Flow whose form fields a template step can load: the one its single
 * FLOW button opens. Null for other steps, and for a form built here, whose
 * listed fields win over saved ones.
 */
export function readLoadableWhatsAppTemplateFormFlowId(
  data: unknown
): string | null {
  if (
    !isRecord(data) ||
    data.kind !== "action" ||
    data.actionType !== "whatsapp_template"
  ) {
    return null;
  }
  const form = readScenarioActionForm(data);
  if (
    form &&
    !form.snapshotFlowId &&
    listScenarioActionFormFields(form).length > 0
  ) {
    return null;
  }
  const flowId = readSingleWhatsAppTemplateFlowButtonFlowId(
    data.actionWhatsAppTemplateComponents
  );
  return isWhatsAppFlowGraphId(flowId) ? flowId : null;
}

/** The step's saved form for `flowId`, as the form readers read it. */
export function readSavedWhatsAppTemplateForm(
  data: Pick<ScenarioNodeData, "actionWhatsAppTemplateForm">,
  flowId: string
): ScenarioWhatsAppTemplateForm | null {
  const saved = normalizeScenarioWhatsAppTemplateForm(
    data.actionWhatsAppTemplateForm
  );
  return saved.status === "supported" && saved.value.flowId === flowId
    ? saved.value
    : null;
}

/**
 * The key of the step's saved form, whichever Flow it was read from: a form
 * button moved to another Flow keeps it, so the new form keeps the step's key.
 */
function readSavedWhatsAppTemplateFormKey(
  data: Pick<ScenarioNodeData, "actionWhatsAppTemplateForm">
): string {
  const saved = normalizeScenarioWhatsAppTemplateForm(
    data.actionWhatsAppTemplateForm
  );
  return saved.status === "supported" ? saved.value.answersKey : "";
}

function withoutReadAt(form: ScenarioWhatsAppTemplateForm): string {
  return JSON.stringify({ ...form, readAt: "" });
}

/**
 * Answers AI prompts read that the step's new fields no longer give, named
 * as its earlier fields named them. These are the tokens activation, and a
 * save of an active scenario, newly block on.
 */
function listNewlyUnavailableAnswers(params: {
  before: readonly SnapshotNode[];
  after: readonly SnapshotNode[];
  edges: readonly SnapshotEdge[];
  node: SnapshotNode;
  formKey: string | undefined;
}): WhatsAppTemplateFormRemovedAnswer[] {
  const before = listUnavailableScenarioFormAnswerTokensByNodeId({
    nodes: params.before,
    edges: params.edges,
  });
  const after = listUnavailableScenarioFormAnswerTokensByNodeId({
    nodes: params.after,
    edges: params.edges,
  });
  const tokens = new Set<string>();
  for (const [nodeId, unavailable] of after) {
    const known = new Set(before.get(nodeId));
    for (const token of unavailable) if (!known.has(token)) tokens.add(token);
  }
  const labels = new Map(
    listScenarioActionFormFields(readScenarioActionForm(params.node.data)).map(
      field => [field.key, field.label]
    )
  );
  return Array.from(tokens, token => {
    const reference = parseScenarioFormAnswerToken(token);
    const fieldKey = reference?.fieldKey ?? token;
    const label =
      reference?.formKey === params.formKey ? labels.get(fieldKey) : "";
    return { token, label: label || humanizeScenarioAnswerKey(fieldKey) };
  });
}

/**
 * Saves the fields of the form a template step's FLOW button opens, as read
 * from its Flow. The form keeps its key across refreshes, and when the
 * button moves to another Flow, such as a renamed copy: a key its Flow
 * config stores wins, as the readers read it, then its saved form's key. A
 * key another form has gives way to the key the step's form resolves to,
 * and a new form gets one from its Flow name.
 *
 * `unchanged` when only the read time would change. Null when the step no
 * longer opens `flowId` with a form it can load, or the fields can't be
 * saved.
 */
export function buildWhatsAppTemplateFormSnapshotPatch(params: {
  nodes: readonly SnapshotNode[];
  edges: readonly SnapshotEdge[];
  nodeId: string;
  flowId: string;
  schema: TemplateFormAnswerSchema;
  /** When the Flow was read: its facts' `checkedAt`. */
  readAt: string;
}): WhatsAppTemplateFormSnapshotPatch | null {
  const node = params.nodes.find(item => item.id === params.nodeId);
  if (
    !node ||
    readLoadableWhatsAppTemplateFormFlowId(node.data) !== params.flowId
  ) {
    return null;
  }
  const saved = readSavedWhatsAppTemplateForm(node.data, params.flowId);
  const formKeysByNodeId = buildScenarioFormAnswersKeysByNodeId(params.nodes);
  const { answersKey } = stampScenarioFormAnswersKey(
    {
      templateId: "",
      screens: [],
      ctaText: "",
      answersKey:
        readScenarioStoredFormKey(node.data.actionFlowConfig) ||
        readSavedWhatsAppTemplateFormKey(node.data),
      metaFlowName: params.schema.flowName,
    },
    { nodeId: params.nodeId, formKeysByNodeId }
  );
  const candidate = normalizeScenarioWhatsAppTemplateForm({
    version: SCENARIO_WHATSAPP_TEMPLATE_FORM_VERSION,
    flowId: params.flowId,
    flowName: params.schema.flowName,
    answersKey,
    digest: params.schema.digest,
    coverage: params.schema.coverage,
    endpoint: params.schema.endpoint,
    readAt: params.readAt,
    fields: params.schema.fields,
  });
  if (candidate.status !== "supported") return null;
  const snapshot = candidate.value;
  if (saved && withoutReadAt(saved) === withoutReadAt(snapshot)) {
    return { unchanged: true };
  }

  const patch = { actionWhatsAppTemplateForm: snapshot };
  return {
    patch,
    snapshot,
    newlyUnavailable: listNewlyUnavailableAnswers({
      before: params.nodes,
      after: params.nodes.map(item =>
        item === node ? { ...item, data: { ...item.data, ...patch } } : item
      ),
      edges: params.edges,
      node,
      formKey: formKeysByNodeId.get(params.nodeId),
    }),
  };
}

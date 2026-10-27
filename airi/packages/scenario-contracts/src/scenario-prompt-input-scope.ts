import {
  listScenarioActionFormFields,
  readScenarioActionForm,
  readScenarioFormLabel,
  resolveScenarioFormKeys,
  type ScenarioFormField,
} from "./scenario-form-answers";
import {
  listInsertableScenarioPromptInputs,
  listScenarioFlowTextPromptInputs,
  PROMPT_INPUTS_UNMET_HANDLE,
  type ScenarioPromptInputField,
} from "./scenario-prompt-inputs";
import {
  isWhatsAppTemplateFormSubmittedSourceHandleId,
  parseFlowBranchSourceHandleId,
} from "./scenario-branch-handles";
import { isUsableGenerativeAIReferenceImage } from "./scenario-generative-ai";
import {
  listScenarioWhatsAppServiceOptions,
  normalizeScenarioWhatsAppServiceMessage,
} from "./whatsapp-service-message";

type PromptInputScopeNode = {
  id: string;
  data?: { kind?: string; actionWhatsAppServiceMessage?: unknown };
};
type PromptInputScopeEdge = {
  source: string;
  target: string;
  sourceHandle?: string | null;
};

function reachableNodes(
  roots: readonly string[],
  outgoing: ReadonlyMap<string, readonly string[]>,
  blockedNodeId?: string,
): Set<string> {
  const visited = new Set<string>();
  const queue = [...roots];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    if (!id || id === blockedNodeId || visited.has(id)) continue;
    visited.add(id);
    queue.push(...(outgoing.get(id) ?? []));
  }
  return visited;
}

type ScopeEdge = { target: string; sourceHandle: string | null | undefined };

type ScopeGraph = {
  roots: string[];
  outgoing: Map<string, string[]>;
  outgoingEdges: Map<string, ScopeEdge[]>;
  reachable: Set<string>;
};

/**
 * Scope graphs by the node and edge arrays they were built from. The builder
 * reads one graph for inputs, picks and form answers, and graph arrays are
 * replaced, never changed in place, so the same pair gives the same graph.
 * Callers only read a graph.
 */
const scopeGraphsByNodes = new WeakMap<
  readonly PromptInputScopeNode[],
  WeakMap<readonly PromptInputScopeEdge[], ScopeGraph>
>();

function buildScopeGraph(params: {
  nodes: readonly PromptInputScopeNode[];
  edges: readonly PromptInputScopeEdge[];
}): ScopeGraph {
  let graphsByEdges = scopeGraphsByNodes.get(params.nodes);
  const cached = graphsByEdges?.get(params.edges);
  if (cached) return cached;
  const graph = createScopeGraph(params);
  if (!graphsByEdges) {
    graphsByEdges = new WeakMap();
    scopeGraphsByNodes.set(params.nodes, graphsByEdges);
  }
  graphsByEdges.set(params.edges, graph);
  return graph;
}

function createScopeGraph(params: {
  nodes: readonly PromptInputScopeNode[];
  edges: readonly PromptInputScopeEdge[];
}): ScopeGraph {
  const nodeIds = new Set(params.nodes.map((node) => node.id));
  const outgoing = new Map<string, string[]>();
  const outgoingEdges = new Map<string, ScopeEdge[]>();
  const incoming = new Set<string>();
  for (const edge of params.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    outgoing.set(edge.source, [
      ...(outgoing.get(edge.source) ?? []),
      edge.target,
    ]);
    outgoingEdges.set(edge.source, [
      ...(outgoingEdges.get(edge.source) ?? []),
      { target: edge.target, sourceHandle: edge.sourceHandle },
    ]);
    incoming.add(edge.target);
  }
  const roots = params.nodes
    .filter(
      (node) =>
        node.data?.kind === "trigger" ||
        node.data?.kind === "bulk" ||
        !incoming.has(node.id),
    )
    .map((node) => node.id);
  return {
    roots,
    outgoing,
    outgoingEdges,
    reachable: reachableNodes(roots, outgoing),
  };
}

/**
 * How a route out of a source relates to it: it continues `through` the
 * source's result, goes `around` it, or may do `either`.
 */
type ScopeRoute = "through" | "around" | "either";

/**
 * The nodes after `sourceId`, by how they are reached. `always`: every entry
 * path passes a route through the source. `somePaths`: a route through it
 * reaches the node, and so does a path around it.
 */
function listNodesAfterSource(
  graph: ScopeGraph,
  sourceId: string,
  classify: (sourceHandle: string | null | undefined) => ScopeRoute,
): { always: string[]; somePaths: string[] } {
  const through: string[] = [];
  const around: string[] = [];
  for (const edge of graph.outgoingEdges.get(sourceId) ?? []) {
    const route = classify(edge.sourceHandle);
    if (route !== "around") through.push(edge.target);
    if (route !== "through") around.push(edge.target);
  }
  const bypass = reachableNodes(
    [...graph.roots, ...around],
    graph.outgoing,
    sourceId,
  );
  const always: string[] = [];
  const somePaths: string[] = [];
  for (const target of reachableNodes(through, graph.outgoing, sourceId)) {
    (bypass.has(target) ? somePaths : always).push(target);
  }
  return { always, somePaths };
}

/** An ask's unmet route also leaves it, so it counts both ways. */
function classifyAskRoute(sourceHandle: string | null | undefined): ScopeRoute {
  return sourceHandle === PROMPT_INPUTS_UNMET_HANDLE ? "either" : "through";
}

/**
 * Offer only predecessor answers, never a global catalog on every action.
 * A bypass entry or unmet route makes availability conditional, so omit it.
 * Runtime template validation remains authoritative (e.g. optional Flow fields).
 */
export function buildScenarioPromptInputsByNodeId(params: {
  nodes: readonly PromptInputScopeNode[];
  edges: readonly PromptInputScopeEdge[];
}): Map<string, ScenarioPromptInputField[]> {
  const fieldsByNodeId = new Map<string, ScenarioPromptInputField[]>(
    params.nodes.map((node) => [node.id, []]),
  );
  const graph = buildScopeGraph(params);
  const seenByNodeId = new Map<string, Set<string>>();
  for (const source of params.nodes) {
    if (!graph.reachable.has(source.id)) continue;
    const fields = [
      ...listInsertableScenarioPromptInputs([source]),
      ...listScenarioFlowTextPromptInputs(source.data),
    ];
    if (fields.length === 0) continue;
    for (const target of listNodesAfterSource(
      graph,
      source.id,
      classifyAskRoute,
    ).always) {
      const current = fieldsByNodeId.get(target);
      if (!current) continue;
      const seen = seenByNodeId.get(target) ?? new Set<string>();
      for (const field of fields) {
        if (seen.has(field.key)) continue;
        seen.add(field.key);
        current.push(field);
      }
      seenByNodeId.set(target, seen);
    }
  }
  return fieldsByNodeId;
}

/** A message whose tapped option later steps can read. */
export type ScenarioPickedOptionSource = {
  nodeId: string;
  kind: "reply_buttons" | "list" | "media_carousel";
  /** A carousel whose every quick-reply card has an image usable as a reference. */
  cardImagesUsable: boolean;
};

function readPickedOptionSource(
  node: PromptInputScopeNode,
): ScenarioPickedOptionSource | null {
  const normalized = normalizeScenarioWhatsAppServiceMessage(
    node.data?.actionWhatsAppServiceMessage,
  );
  if (normalized.status !== "supported") return null;
  const message = normalized.value.message;
  if (
    (message.kind !== "reply_buttons" &&
      message.kind !== "list" &&
      message.kind !== "media_carousel") ||
    listScenarioWhatsAppServiceOptions(normalized.value).length === 0
  ) {
    return null;
  }
  const choiceCards =
    message.kind === "media_carousel"
      ? message.cards.filter(
          (card) => card.interaction.kind === "quick_replies",
        )
      : [];
  return {
    nodeId: node.id,
    kind: message.kind,
    cardImagesUsable:
      choiceCards.length > 0 &&
      choiceCards.every((card) =>
        isUsableGenerativeAIReferenceImage(card.media),
      ),
  };
}

/**
 * The buttons, list and carousel messages every entry path to a node passes,
 * in node order. A node reading a picked option may name only one of these.
 */
export function buildScenarioPickedOptionSourcesByNodeId(params: {
  nodes: readonly PromptInputScopeNode[];
  edges: readonly PromptInputScopeEdge[];
}): Map<string, ScenarioPickedOptionSource[]> {
  const sourcesByNodeId = new Map<string, ScenarioPickedOptionSource[]>(
    params.nodes.map((node) => [node.id, []]),
  );
  const graph = buildScopeGraph(params);
  const sources = params.nodes.flatMap((node) => {
    if (!graph.reachable.has(node.id)) return [];
    const source = readPickedOptionSource(node);
    return source ? [source] : [];
  });
  for (const source of sources) {
    // The tap happened before any route leaves the message, unmet included.
    for (const target of listNodesAfterSource(
      graph,
      source.nodeId,
      () => "through",
    ).always) {
      sourcesByNodeId.get(target)?.push(source);
    }
  }
  return sourcesByNodeId;
}

/** Whether every path to a step passes the form's submission. */
export type ScenarioFormAnswerAvailability = "always" | "some_paths";

export type ScenarioFormAnswerSourceField = ScenarioFormField & {
  /**
   * The step can run without this answer: the customer may reach it without
   * submitting the form, the field is optional, or a data-endpoint Flow can
   * route past the field's screen.
   */
  mayBeEmpty: boolean;
};

/** A form whose answers a step can read. */
export type ScenarioFormAnswerSource = {
  nodeId: string;
  formKey: string;
  /** The Flow's name; the builder shows its own step label instead. */
  formLabel: string;
  availability: ScenarioFormAnswerAvailability;
  /** "unknown" for a form made in Meta, whose fields are not listed here. */
  schema: "known" | "unknown";
  /** The fields leave out answers the form can send, which no step can read. */
  partial?: true;
  fields: ScenarioFormAnswerSourceField[];
};

/** The action's default output: SCENARIO_HANDLE_RULES.action.outputHandleId. */
const DEFAULT_OUTPUT_HANDLE = "right-source";

/**
 * Routes that pass a form's submission. A Flow branch follows an answer, and
 * a template's "Form submitted" route follows the submission. A service
 * message's default output is its "Form submitted" route, while a template's
 * default output also takes a typed reply, so it counts both ways. No reply,
 * any reply, answer, payment, button and other routes go around the form.
 */
function classifyFormRoute(
  sender: "service_message" | "template",
): (sourceHandle: string | null | undefined) => ScopeRoute {
  return (sourceHandle) => {
    const handle = typeof sourceHandle === "string" ? sourceHandle.trim() : "";
    if (
      parseFlowBranchSourceHandleId(handle) ||
      isWhatsAppTemplateFormSubmittedSourceHandleId(handle)
    ) {
      return "through";
    }
    if (!handle || handle === DEFAULT_OUTPUT_HANDLE) {
      return sender === "service_message" ? "through" : "either";
    }
    return "around";
  };
}

/**
 * The forms before each node whose answers it can read, in node order.
 * Forms compound: a node after two forms reads both. A form the customer can
 * go around on the way to the node is offered as `some_paths`, and every one
 * of its fields may be empty there.
 */
export function buildScenarioFormAnswerSourcesByNodeId(params: {
  nodes: readonly PromptInputScopeNode[];
  edges: readonly PromptInputScopeEdge[];
}): Map<string, ScenarioFormAnswerSource[]> {
  const sourcesByNodeId = new Map<string, ScenarioFormAnswerSource[]>(
    params.nodes.map((node) => [node.id, []]),
  );
  const graph = buildScopeGraph(params);
  const formKeys = resolveScenarioFormKeys(params.nodes);
  for (const node of params.nodes) {
    const form = readScenarioActionForm(node.data);
    const formKey = formKeys.get(node.id);
    if (!form || !formKey || !graph.reachable.has(node.id)) continue;
    const fields = listScenarioActionFormFields(form);
    // Routes of a data-endpoint Flow can skip every screen after the first.
    const skipsScreens = form.flowConfig.flowNavigationMode === "data_endpoint";
    const source = {
      nodeId: node.id,
      formKey,
      formLabel: readScenarioFormLabel(form.flowConfig),
      // A Flow linked from Meta is saved without its fields.
      schema:
        fields.length === 0 &&
        typeof form.flowConfig.providerReference === "object" &&
        form.flowConfig.providerReference !== null
          ? "unknown"
          : "known",
      // A template's form read from its Flow can leave answers out.
      ...(form.partial ? { partial: true as const } : {}),
    } as const;
    const after = listNodesAfterSource(
      graph,
      node.id,
      classifyFormRoute(form.sender),
    );
    for (const availability of ["always", "some_paths"] as const) {
      const sourceFields = fields.map((field) => ({
        ...field,
        mayBeEmpty:
          availability === "some_paths" ||
          !field.required ||
          field.conditional === true ||
          (skipsScreens && field.screenIndex > 0),
      }));
      const targets =
        availability === "always" ? after.always : after.somePaths;
      for (const target of targets) {
        sourcesByNodeId
          .get(target)
          ?.push({ ...source, availability, fields: sourceFields });
      }
    }
  }
  return sourcesByNodeId;
}

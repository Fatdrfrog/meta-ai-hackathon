import "server-only";

import {
  BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
  SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
  MAX_RECIPIENT_COLUMN_SPLIT_PATHS,
  RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID,
  buildRecipientColumnSplitPathHandleId,
  isBulkCampaignRootNode,
  matchRecipientColumnSplit,
  normalizeBulkCampaignRecipientPolicy,
  normalizeScenarioRecipientColumnSplit,
  type BulkCampaignRecipientPolicy,
  type BulkCampaignEligibilityMessageIntent,
  type ScenarioCampaignRecipient,
  type ScenarioRecipientColumnSplitConfig,
} from "@icecore/scenario-contracts";
import type {
  WhatsAppComponent,
  WhatsAppTemplate,
  WhatsAppTemplateCategory,
} from "@icecore/shared/types/whatsapp";
import { normalizeWhatsAppTemplateLanguageForSend } from "@icecore/shared/constants/whatsapp-templates";

import { resolveScenarioActionTypeFromNodeData } from "@icecore/airi-runtime/scenario-action-semantics";
import { isRecipientColumnSplitNodeData } from "@/lib/scenarios/recipient-column-split";
import {
  staleWhatsAppTemplateCatalogMissError,
  type WhatsAppTemplateCatalogError,
  type WhatsAppTemplateCatalogResult,
} from "@/lib/whatsapp/templates/catalog-contracts";
import { isRecord, readTrimmedString } from "@icecore/shared/lib/value-utils";
import type { BulkCampaignCompatibleProvenanceIntent } from "./bulk-campaign-contracts";
import type { CampaignScenarioStepTemplate } from "./campaign-recipient-utils";

type BulkCampaignChannel = "whatsapp" | "telegram" | "email";
const MAX_VERIFIED_BULK_CAMPAIGN_SOURCE_IDS = 20;

const verifiedBulkCampaignProvenanceBrand: unique symbol = Symbol(
  "verifiedBulkCampaignProvenance"
);
const verifiedBulkCampaignCapabilityBrand: unique symbol = Symbol(
  "verifiedBulkCampaignCapability"
);
const verifiedBulkCampaignScheduleCapabilityBrand: unique symbol = Symbol(
  "verifiedBulkCampaignScheduleCapability"
);
const verifiedGeneratedBulkCampaignCapabilityBrand: unique symbol = Symbol(
  "verifiedGeneratedBulkCampaignCapability"
);

export type VerifiedBulkCampaignRoute = {
  recipientStableId: string;
  actionNodeId: string;
  channel: BulkCampaignChannel;
  sourceId: string | null;
  template?: {
    name: string;
    language: string;
    category: WhatsAppTemplateCategory;
    components: WhatsAppComponent[];
  };
  /** The action step's saved template, whose button ids name its routes. */
  stepTemplate?: CampaignScenarioStepTemplate;
};

export type VerifiedBulkCampaignProvenance = {
  readonly [verifiedBulkCampaignProvenanceBrand]: true;
  kind: "ad_hoc" | "scenario_run_now" | "scenario_schedule";
  scenarioId?: string;
  rootNodeId?: string;
  columnSplitNodeId?: string;
  routes: VerifiedBulkCampaignRoute[];
  /** Schedule rows on an unconnected split path or Else; they get no route. */
  skippedStableIds?: string[];
};

export type VerifiedGeneratedBulkCampaignRoute = VerifiedBulkCampaignRoute & {
  actionNode: {
    id: string;
    data: Record<string, unknown>;
  };
};

export type VerifiedGeneratedBulkCampaignProvenance = Omit<
  VerifiedBulkCampaignProvenance,
  "routes"
> & {
  routes: VerifiedGeneratedBulkCampaignRoute[];
  supportsWhatsAppTemplate: boolean;
  recipientPolicy: BulkCampaignRecipientPolicy;
};

export type VerifyBulkCampaignProvenanceInput = {
  workspaceId: string;
  intent: BulkCampaignCompatibleProvenanceIntent;
  channel: BulkCampaignChannel;
  recipients: Array<{
    stableId: string;
    recipient: ScenarioCampaignRecipient;
  }>;
  messageIntent: BulkCampaignEligibilityMessageIntent;
};

export type VerifyBulkCampaignProvenanceCapabilityInput = Omit<
  VerifyBulkCampaignProvenanceInput,
  "recipients"
>;

type VerifyScenarioProvenanceCapabilityInput = Omit<
  VerifyBulkCampaignProvenanceCapabilityInput,
  "intent"
> & {
  intent: Exclude<BulkCampaignCompatibleProvenanceIntent, { kind: "ad_hoc" }>;
};

type VerifyScenarioScheduleClaimedCapabilityInput = Omit<
  VerifyBulkCampaignProvenanceCapabilityInput,
  "intent"
> & {
  scenarioId: string;
  scheduledNodeId: string;
};

type ScenarioRecord = {
  _id?: unknown;
  workspaceId?: unknown;
  mode?: unknown;
  deletedAt?: unknown;
  nodes?: unknown;
  edges?: unknown;
};

export type VerifyBulkCampaignProvenanceDependencies = {
  findScenario(params: {
    workspaceId: string;
    scenarioId: string;
  }): Promise<ScenarioRecord | null>;
  listApprovedWhatsAppTemplatesForSend(
    workspaceId: string,
    options: { sourceId: string }
  ): Promise<WhatsAppTemplate[]>;
  /**
   * The same templates with the catalog's freshness; used instead of
   * `listApprovedWhatsAppTemplatesForSend` when given. A scenario's template
   * missing from a stale catalog then fails the lookup instead of reading as
   * not approved.
   */
  readApprovedWhatsAppTemplatesForSend?(
    workspaceId: string,
    options: { sourceId: string }
  ): Promise<WhatsAppTemplateCatalogResult>;
  normalizeWhatsAppTemplateLanguageForSend?(value: unknown): string;
};

type ResolvedDependencies = VerifyBulkCampaignProvenanceDependencies & {
  normalizeWhatsAppTemplateLanguageForSend(value: unknown): string;
};

type GraphNode = {
  id: string;
  data: Record<string, unknown>;
};

type GraphEdge = {
  source: string;
  target: string;
  sourceHandle: string | null;
};

type ParsedGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeById: Map<string, GraphNode>;
};

type ResolvedWhatsAppTemplate = {
  name: string;
  language: string;
  category: WhatsAppTemplateCategory;
  components: WhatsAppComponent[];
};

type VerifiedAction = {
  nodeId: string;
  templatesBySourceId?: Map<string, ResolvedWhatsAppTemplate>;
  stepTemplate?: CampaignScenarioStepTemplate;
};

type DirectRoutingState = {
  kind: "direct";
  action: VerifiedAction;
};

type SplitRoutingState = {
  kind: "column_split";
  splitNodeId: string;
  config: ScenarioRecipientColumnSplitConfig;
  actionByHandle: Map<string, VerifiedAction>;
};

type ScenarioCapabilityState = {
  scenarioId: string;
  rootNodeId: string;
  channel: BulkCampaignChannel;
  sourceIds: string[];
  recipientPolicy: BulkCampaignRecipientPolicy;
  normalizeTemplateLanguage(value: unknown): string;
  routing: DirectRoutingState | SplitRoutingState;
};

type GeneratedScenarioCapabilityState = {
  workspaceId: string;
  scenarioId: string;
  rootNodeId: string;
  sourceIds: string[];
  configuredChannels: BulkCampaignChannel[];
  recipientPolicy: BulkCampaignRecipientPolicy;
  normalizeTemplateLanguage(value: unknown): string;
  actionById: Map<string, { branchId: string; actionNode: GraphNode }>;
  dependencies: ResolvedDependencies;
};

export type VerifiedBulkCampaignProvenanceCapability = {
  readonly [verifiedBulkCampaignCapabilityBrand]: true;
};

export type VerifiedBulkCampaignScenarioScheduleCapability = {
  readonly [verifiedBulkCampaignScheduleCapabilityBrand]: true;
};

export type VerifiedGeneratedBulkCampaignProvenanceCapability = {
  readonly [verifiedGeneratedBulkCampaignCapabilityBrand]: true;
};

type CapabilityPrivateState =
  | { kind: "ad_hoc"; scenario: null }
  | {
      kind: "scenario_run_now" | "scenario_schedule";
      scenario: ScenarioCapabilityState;
    }
  | { kind: "generated_scenario"; scenario: GeneratedScenarioCapabilityState };

const capabilityPrivateState = new WeakMap<object, CapabilityPrivateState>();

export class BulkCampaignProvenanceError extends Error {
  readonly code = "bulk_campaign_provenance_invalid" as const;

  constructor(
    readonly reason: string,
    options?: { cause?: unknown }
  ) {
    super(
      reason === "template_bindings_require_conversation"
        ? "The first WhatsApp action in a bulk campaign cannot use conversation value bindings. Remove these bindings and use campaign recipient mappings. Conversation value bindings remain available in follow-up actions."
        : `Bulk campaign provenance is invalid: ${reason}`,
      options
    );
    this.name = "BulkCampaignProvenanceError";
  }
}

// No mode filter: builder campaigns live in conversation-mode scenarios, and
// the verifiers below prove the claimed bulk root from the graph itself.
const defaultFindScenario: VerifyBulkCampaignProvenanceDependencies["findScenario"] =
  async ({ workspaceId, scenarioId }) => {
    const [{ default: connectDB }, { Scenario }] = await Promise.all([
      import("@/lib/mongoose"),
      import("@/models/scenario"),
    ]);
    await connectDB();
    return Scenario.findOne({
      _id: scenarioId,
      workspaceId,
      deletedAt: null,
    }).lean<ScenarioRecord | null>();
  };

async function resolveDependencies(
  dependencies?: VerifyBulkCampaignProvenanceDependencies
): Promise<ResolvedDependencies> {
  if (dependencies) {
    return {
      ...dependencies,
      normalizeWhatsAppTemplateLanguageForSend:
        dependencies.normalizeWhatsAppTemplateLanguageForSend ??
        normalizeWhatsAppTemplateLanguageForSend,
    };
  }
  const sendLookup = await import("@/lib/whatsapp/templates/send-lookup");
  return {
    findScenario: defaultFindScenario,
    listApprovedWhatsAppTemplatesForSend:
      sendLookup.listApprovedWhatsAppTemplatesForSend,
    readApprovedWhatsAppTemplatesForSend:
      sendLookup.readApprovedWhatsAppTemplatesForSend,
    normalizeWhatsAppTemplateLanguageForSend,
  };
}

/**
 * Scheduled runs start in the worker, which has no user session: the default
 * session client reads no source there, so every scheduled send failed with
 * "WhatsApp credentials not found". The node run already trusts the workspace
 * and resolved its source with the same server-only client.
 */
async function resolveScheduleDependencies(
  dependencies?: VerifyBulkCampaignProvenanceDependencies
): Promise<VerifyBulkCampaignProvenanceDependencies> {
  if (dependencies) return dependencies;
  const [sendLookup, { supabaseAdmin }] = await Promise.all([
    import("@/lib/whatsapp/templates/send-lookup"),
    import("@/lib/supabase/admin"),
  ]);
  return {
    findScenario: defaultFindScenario,
    listApprovedWhatsAppTemplatesForSend: (workspaceId, options) =>
      sendLookup.listApprovedWhatsAppTemplatesForSend(workspaceId, {
        ...options,
        supabase: supabaseAdmin,
      }),
    readApprovedWhatsAppTemplatesForSend: (workspaceId, options) =>
      sendLookup.readApprovedWhatsAppTemplatesForSend(workspaceId, {
        ...options,
        supabase: supabaseAdmin,
      }),
  };
}

function invalid(reason: string, cause?: unknown): never {
  throw new BulkCampaignProvenanceError(
    reason,
    cause === undefined ? undefined : { cause }
  );
}

function createCapabilityToken(
  state:
    | { kind: "ad_hoc"; scenario: null }
    | { kind: "scenario_run_now"; scenario: ScenarioCapabilityState }
): VerifiedBulkCampaignProvenanceCapability;
function createCapabilityToken(state: {
  kind: "scenario_schedule";
  scenario: ScenarioCapabilityState;
}): VerifiedBulkCampaignScenarioScheduleCapability;
function createCapabilityToken(state: {
  kind: "generated_scenario";
  scenario: GeneratedScenarioCapabilityState;
}): VerifiedGeneratedBulkCampaignProvenanceCapability;
function createCapabilityToken(
  state: CapabilityPrivateState
):
  | VerifiedBulkCampaignProvenanceCapability
  | VerifiedBulkCampaignScenarioScheduleCapability
  | VerifiedGeneratedBulkCampaignProvenanceCapability {
  const token = Object.create(null) as object;
  capabilityPrivateState.set(token, state);
  return Object.freeze(token) as
    | VerifiedBulkCampaignProvenanceCapability
    | VerifiedBulkCampaignScenarioScheduleCapability
    | VerifiedGeneratedBulkCampaignProvenanceCapability;
}

function readCapabilityPrivateState(
  capability: unknown,
  expectedKind: CapabilityPrivateState["kind"]
): CapabilityPrivateState {
  if (!capability || typeof capability !== "object") {
    return invalid("capability_invalid");
  }
  const state = capabilityPrivateState.get(capability);
  if (!state || state.kind !== expectedKind) {
    return invalid("capability_invalid");
  }
  return state;
}

function cloneWhatsAppComponents(
  components: WhatsAppComponent[]
): WhatsAppComponent[] {
  return structuredClone(components);
}

function normalizedPersistedIdentity(value: unknown): string {
  const stringValue = readTrimmedString(value);
  if (stringValue) return stringValue;
  if (!value || typeof value !== "object") return "";
  try {
    const serialized = String(value).trim();
    return serialized && serialized !== "[object Object]" ? serialized : "";
  } catch {
    return "";
  }
}

function parseGraph(scenario: ScenarioRecord): ParsedGraph {
  if (!Array.isArray(scenario.nodes) || !Array.isArray(scenario.edges)) {
    return invalid("malformed_graph");
  }

  const nodes: GraphNode[] = [];
  const nodeById = new Map<string, GraphNode>();
  for (const rawNode of scenario.nodes) {
    if (!isRecord(rawNode) || !isRecord(rawNode.data)) {
      return invalid("malformed_graph_node");
    }
    const id = readTrimmedString(rawNode.id);
    if (!id || nodeById.has(id)) {
      return invalid("malformed_graph_node");
    }
    const node = { id, data: rawNode.data };
    nodes.push(node);
    nodeById.set(id, node);
  }

  const edges: GraphEdge[] = [];
  for (const rawEdge of scenario.edges) {
    if (!isRecord(rawEdge)) return invalid("malformed_graph_edge");
    const source = readTrimmedString(rawEdge.source);
    const target = readTrimmedString(rawEdge.target);
    if (!source || !target || !nodeById.has(source) || !nodeById.has(target)) {
      return invalid("malformed_graph_edge");
    }
    if (
      rawEdge.sourceHandle !== undefined &&
      rawEdge.sourceHandle !== null &&
      typeof rawEdge.sourceHandle !== "string"
    ) {
      return invalid("malformed_graph_edge");
    }
    edges.push({
      source,
      target,
      sourceHandle: readTrimmedString(rawEdge.sourceHandle) || null,
    });
  }

  return { nodes, edges, nodeById };
}

function rootOutboundEdges(
  graph: ParsedGraph,
  rootNodeId: string
): GraphEdge[] {
  return graph.edges.filter(
    edge =>
      edge.source === rootNodeId &&
      edge.sourceHandle === BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID
  );
}

function isBulkRoot(node: GraphNode | undefined): node is GraphNode {
  return isBulkCampaignRootNode(node);
}

function parseRootSourceIds(root: GraphNode): string[] {
  const config = root.data.bulkRootConfig;
  if (!isRecord(config)) return invalid("bulk_root_config_missing");
  const sourceIds = config.sourceIds;
  if (sourceIds === undefined) return [];
  if (
    !Array.isArray(sourceIds) ||
    sourceIds.some(value => typeof value !== "string")
  ) {
    return invalid("bulk_root_sources_invalid");
  }
  return Array.from(
    new Set(
      sourceIds.flatMap(value => {
        const trimmed = value.trim();
        return trimmed ? [trimmed] : [];
      })
    )
  );
}

function assertRootChannel(
  root: GraphNode,
  channel: BulkCampaignChannel
): void {
  const config = root.data.bulkRootConfig;
  if (!isRecord(config) || !Array.isArray(config.channels)) {
    return invalid("bulk_root_channels_invalid");
  }
  if (
    config.channels.some(value => typeof value !== "string") ||
    !config.channels.map(value => value.trim()).includes(channel)
  ) {
    return invalid("bulk_root_channel_mismatch");
  }
}

function isSplitNode(node: GraphNode | undefined): boolean {
  return Boolean(
    node &&
      isRecipientColumnSplitNodeData(
        node.data as Parameters<typeof isRecipientColumnSplitNodeData>[0]
      )
  );
}

function parseSplitRouting(params: {
  graph: ParsedGraph;
  splitNode: GraphNode;
}): {
  config: ScenarioRecipientColumnSplitConfig;
  actionNodeByHandle: Map<string, GraphNode>;
} {
  const rawConfig = params.splitNode.data.recipientColumnSplit;
  if (!isRecord(rawConfig) || !Array.isArray(rawConfig.paths)) {
    return invalid("column_split_config_invalid");
  }
  if (rawConfig.paths.length > MAX_RECIPIENT_COLUMN_SPLIT_PATHS) {
    return invalid("column_split_path_limit_exceeded");
  }

  const normalized = normalizeScenarioRecipientColumnSplit(rawConfig);
  if (
    normalized.status !== "supported" ||
    normalized.value.paths.length !== rawConfig.paths.length
  ) {
    return invalid("column_split_config_invalid");
  }
  const handles = [
    ...normalized.value.paths.map(path =>
      buildRecipientColumnSplitPathHandleId(path.id)
    ),
    RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID,
  ];
  if (new Set(handles).size !== handles.length) {
    return invalid("column_split_handles_ambiguous");
  }

  const allowedHandles = new Set(handles);
  const splitEdges = params.graph.edges.filter(
    edge => edge.source === params.splitNode.id
  );
  if (
    splitEdges.some(
      edge => !edge.sourceHandle || !allowedHandles.has(edge.sourceHandle)
    )
  ) {
    return invalid("column_split_edge_invalid");
  }

  // The editor lets a path or Else stay unconnected ("leave empty to skip
  // send"), so an empty handle is valid here. routeRecipient still rejects any
  // row that lands on one; the scenario bulk node never sends such rows.
  const actionNodeByHandle = new Map<string, GraphNode>();
  for (const handle of handles) {
    const matchingEdges = splitEdges.filter(
      edge => edge.sourceHandle === handle
    );
    if (matchingEdges.length === 0) continue;
    if (matchingEdges.length > 1) {
      return invalid("column_split_route_ambiguous");
    }
    const actionNode = params.graph.nodeById.get(matchingEdges[0]!.target);
    if (actionNode?.data.kind !== "action") {
      return invalid("column_split_route_action_invalid");
    }
    actionNodeByHandle.set(handle, actionNode);
  }
  if (actionNodeByHandle.size === 0) {
    return invalid("column_split_routes_missing");
  }

  return { config: normalized.value, actionNodeByHandle };
}

function findLegacyRoot(params: {
  graph: ParsedGraph;
  claimedNodeId: string;
  preserveClaimedSplitAction?: boolean;
}): { rootNodeId: string; actionNodeId?: string; columnSplitNodeId?: string } {
  const matches: Array<{
    rootNodeId: string;
    actionNodeId?: string;
    columnSplitNodeId?: string;
  }> = [];

  for (const root of params.graph.nodes.filter(isBulkRoot)) {
    const outbound = rootOutboundEdges(params.graph, root.id);
    for (const edge of outbound) {
      const target = params.graph.nodeById.get(edge.target);
      if (
        target?.data.kind === "action" &&
        target.id === params.claimedNodeId
      ) {
        matches.push({ rootNodeId: root.id, actionNodeId: target.id });
        continue;
      }
      if (!target || !isSplitNode(target)) continue;
      if (target.id === params.claimedNodeId) {
        matches.push({ rootNodeId: root.id, columnSplitNodeId: target.id });
        continue;
      }
      if (
        params.graph.edges.some(
          splitEdge =>
            splitEdge.source === target.id &&
            splitEdge.target === params.claimedNodeId &&
            Boolean(splitEdge.sourceHandle)
        )
      ) {
        matches.push({
          rootNodeId: root.id,
          columnSplitNodeId: target.id,
          ...(params.preserveClaimedSplitAction
            ? { actionNodeId: params.claimedNodeId }
            : {}),
        });
      }
    }
  }

  const uniqueMatches = Array.from(
    new Map(matches.map(match => [match.rootNodeId, match])).values()
  );
  if (uniqueMatches.length !== 1) {
    return invalid("legacy_root_not_unique");
  }
  return uniqueMatches[0]!;
}

function normalizeTemplateKey(
  name: unknown,
  language: unknown,
  normalizeLanguage: (value: unknown) => string
): string {
  const normalizedName = readTrimmedString(name).toLowerCase();
  const normalizedLanguage = normalizeLanguage(language);
  if (!normalizedName || !normalizedLanguage)
    return invalid("template_identity_missing");
  return `${normalizedName}:${normalizedLanguage}`;
}

function isApprovedCategory(value: unknown): value is WhatsAppTemplateCategory {
  return (
    value === "MARKETING" || value === "UTILITY" || value === "AUTHENTICATION"
  );
}

function readActionTemplateIdentity(
  action: GraphNode,
  normalizeLanguage: (value: unknown) => string
): {
  name: string;
  language: string;
  categoryHint: string;
} {
  const draft = isRecord(action.data.generatedTemplateDraft)
    ? action.data.generatedTemplateDraft
    : null;
  const name =
    readTrimmedString(action.data.actionWhatsAppTemplateName) ||
    readTrimmedString(draft?.name);
  const language =
    normalizeLanguage(action.data.actionWhatsAppTemplateLanguage) ||
    normalizeLanguage(draft?.language) ||
    "en";
  const categoryHint = (
    readTrimmedString(action.data.actionWhatsAppTemplateCategory) ||
    readTrimmedString(action.data.templateCategory) ||
    readTrimmedString(draft?.category)
  ).toUpperCase();
  if (!name) return invalid("template_identity_missing");
  return { name, language, categoryHint };
}

/** Bulk primary sends have recipient mappings, not a conversation execution context. */
export function assertBulkPrimaryWhatsAppTemplateHasNoConversationBindings(
  actionData: Record<string, unknown> | undefined
): void {
  if (actionData?.actionWhatsAppTemplateBindings !== undefined) {
    return invalid("template_bindings_require_conversation");
  }
}

function assertActionMatchesChannel(
  action: GraphNode,
  channel: BulkCampaignChannel
): void {
  if (action.data.kind !== "action") return invalid("action_node_invalid");
  const actionType = resolveScenarioActionTypeFromNodeData(
    action.data as Parameters<typeof resolveScenarioActionTypeFromNodeData>[0]
  );
  if (channel === "whatsapp") {
    if (actionType !== "whatsapp_template") {
      return invalid("action_message_kind_mismatch");
    }
    assertBulkPrimaryWhatsAppTemplateHasNoConversationBindings(action.data);
    return;
  }
  if (
    actionType !== "reply" ||
    readTrimmedString(action.data.actionReplyChannel).toLowerCase() !== channel
  ) {
    return invalid("action_message_kind_mismatch");
  }
}

function assertMessageIntentMatchesChannel(
  messageIntent: BulkCampaignEligibilityMessageIntent,
  channel: BulkCampaignChannel
): void {
  if (channel === "whatsapp") {
    if (messageIntent.kind !== "whatsapp_template") {
      return invalid("message_intent_mismatch");
    }
    return;
  }
  if (
    messageIntent.kind !== "unsupported" ||
    messageIntent.messageKind !== channel
  ) {
    return invalid("message_intent_mismatch");
  }
}

async function loadTemplateCatalogs(params: {
  workspaceId: string;
  sourceIds: string[];
  dependencies: ResolvedDependencies;
}): Promise<{
  catalogs: Map<string, Map<string, WhatsAppTemplate>>;
  /** Per source, what a template missing from its stale catalog means. */
  staleMissErrors: Map<string, WhatsAppTemplateCatalogError>;
}> {
  const catalogs = new Map<string, Map<string, WhatsAppTemplate>>();
  const staleMissErrors = new Map<string, WhatsAppTemplateCatalogError>();
  const { dependencies } = params;
  for (const sourceId of params.sourceIds) {
    const result = dependencies.readApprovedWhatsAppTemplatesForSend
      ? await dependencies.readApprovedWhatsAppTemplatesForSend(
          params.workspaceId,
          { sourceId }
        )
      : {
          templates: await dependencies.listApprovedWhatsAppTemplatesForSend(
            params.workspaceId,
            { sourceId }
          ),
          catalog: null,
        };
    const templates = result?.templates;
    if (!Array.isArray(templates)) return invalid("template_catalog_invalid");
    const staleMissError = staleWhatsAppTemplateCatalogMissError(
      result.catalog
    );
    if (staleMissError) staleMissErrors.set(sourceId, staleMissError);
    const catalog = new Map<string, WhatsAppTemplate>();
    for (const template of templates) {
      if (!template || template.status !== "APPROVED") continue;
      const key = normalizeTemplateKey(
        template.name,
        template.language,
        params.dependencies.normalizeWhatsAppTemplateLanguageForSend
      );
      if (catalog.has(key)) return invalid("template_catalog_duplicate_key");
      catalog.set(key, template);
    }
    catalogs.set(sourceId, catalog);
  }
  return { catalogs, staleMissErrors };
}

function verifyWhatsAppAction(params: {
  action: GraphNode;
  sourceIds: string[];
  catalogs: Map<string, Map<string, WhatsAppTemplate>>;
  /** When given, a template missing from a stale catalog is lookup_failed. */
  staleMissErrors?: Map<string, WhatsAppTemplateCatalogError>;
  normalizeLanguage(value: unknown): string;
}): VerifiedAction {
  assertActionMatchesChannel(params.action, "whatsapp");
  const identity = readActionTemplateIdentity(
    params.action,
    params.normalizeLanguage
  );
  const key = normalizeTemplateKey(
    identity.name,
    identity.language,
    params.normalizeLanguage
  );
  const templatesBySourceId = new Map<string, ResolvedWhatsAppTemplate>();

  for (const sourceId of params.sourceIds) {
    const template = params.catalogs.get(sourceId)?.get(key);
    const staleMissError = template
      ? undefined
      : params.staleMissErrors?.get(sourceId);
    if (staleMissError) return invalid("lookup_failed", staleMissError);
    if (!template || !isApprovedCategory(template.category)) {
      return invalid("approved_template_missing");
    }
    if (identity.categoryHint && identity.categoryHint !== template.category) {
      return invalid("template_category_conflict");
    }
    templatesBySourceId.set(sourceId, {
      name: template.name,
      language: params.normalizeLanguage(template.language),
      category: template.category,
      components: Array.isArray(template.components)
        ? cloneWhatsAppComponents(template.components)
        : [],
    });
  }
  return {
    nodeId: params.action.id,
    templatesBySourceId,
    stepTemplate: {
      components: params.action.data.actionWhatsAppTemplateComponents,
      buttonIds: params.action.data.actionWhatsAppTemplateButtonIds,
    },
  };
}

function verifyNonWhatsAppAction(
  action: GraphNode,
  channel: "telegram" | "email"
): VerifiedAction {
  assertActionMatchesChannel(action, channel);
  return { nodeId: action.id };
}

function collectRouteActions(
  routing:
    | { kind: "direct"; actionNode: GraphNode }
    | {
        kind: "column_split";
        splitNodeId: string;
        config: ScenarioRecipientColumnSplitConfig;
        actionNodeByHandle: Map<string, GraphNode>;
      }
): GraphNode[] {
  const actions =
    routing.kind === "direct"
      ? [routing.actionNode]
      : Array.from(routing.actionNodeByHandle.values());
  return Array.from(
    new Map(actions.map(action => [action.id, action])).values()
  );
}

async function buildScenarioCapability(params: {
  input: Pick<
    VerifyBulkCampaignProvenanceCapabilityInput,
    "workspaceId" | "channel" | "messageIntent"
  >;
  provenanceKind: "scenario_run_now" | "scenario_schedule";
  scenario: ScenarioRecord;
  graph: ParsedGraph;
  rootNodeId: string;
  actionNodeId?: string;
  columnSplitNodeId?: string;
  dependencies: ResolvedDependencies;
}): Promise<
  | VerifiedBulkCampaignProvenanceCapability
  | VerifiedBulkCampaignScenarioScheduleCapability
> {
  const root = params.graph.nodeById.get(params.rootNodeId);
  if (!isBulkRoot(root)) return invalid("bulk_root_invalid");
  assertRootChannel(root, params.input.channel);
  assertMessageIntentMatchesChannel(
    params.input.messageIntent,
    params.input.channel
  );

  const outbound = rootOutboundEdges(params.graph, root.id);
  if (outbound.length !== 1) return invalid("bulk_root_edge_ambiguous");
  const target = params.graph.nodeById.get(outbound[0]!.target);
  if (!target) return invalid("bulk_root_target_missing");

  let routing:
    | { kind: "direct"; actionNode: GraphNode }
    | {
        kind: "column_split";
        splitNodeId: string;
        config: ScenarioRecipientColumnSplitConfig;
        actionNodeByHandle: Map<string, GraphNode>;
      };
  if (isSplitNode(target)) {
    if (
      (params.columnSplitNodeId !== undefined &&
        params.columnSplitNodeId !== target.id) ||
      (params.actionNodeId !== undefined &&
        params.provenanceKind !== "scenario_schedule")
    ) {
      return invalid("column_split_mismatch");
    }
    const parsed = parseSplitRouting({
      graph: params.graph,
      splitNode: target,
    });
    if (params.actionNodeId !== undefined) {
      const claimedAction = Array.from(parsed.actionNodeByHandle.values()).find(
        action => action.id === params.actionNodeId
      );
      if (!claimedAction) return invalid("action_node_unreachable");
      routing = { kind: "direct", actionNode: claimedAction };
    } else {
      routing = {
        kind: "column_split",
        splitNodeId: target.id,
        ...parsed,
      };
    }
  } else {
    if (
      target.data.kind !== "action" ||
      params.columnSplitNodeId !== undefined ||
      (params.actionNodeId !== undefined && params.actionNodeId !== target.id)
    ) {
      return invalid("action_node_unreachable");
    }
    routing = { kind: "direct", actionNode: target };
  }

  const configuredSourceIds = parseRootSourceIds(root);
  const rootConfig = root.data.bulkRootConfig;
  if (!isRecord(rootConfig)) return invalid("bulk_root_config_missing");
  let recipientPolicy: BulkCampaignRecipientPolicy;
  try {
    recipientPolicy = normalizeBulkCampaignRecipientPolicy(
      rootConfig.recipientPolicy
    );
  } catch (error) {
    return invalid("recipient_policy_invalid", error);
  }
  if (
    params.provenanceKind === "scenario_schedule" &&
    configuredSourceIds.length > MAX_VERIFIED_BULK_CAMPAIGN_SOURCE_IDS
  ) {
    return invalid("bulk_root_sources_limit_exceeded");
  }
  let sourceIds: string[] = [];
  if (params.input.channel === "whatsapp") {
    if (params.input.messageIntent.kind !== "whatsapp_template") {
      return invalid("message_intent_mismatch");
    }
    if (params.provenanceKind === "scenario_schedule") {
      if (configuredSourceIds.length > 0) {
        sourceIds = [...configuredSourceIds];
      } else {
        // A builder root without stored sourceIds uses the workspace source
        // node-run resolved for this run. Legacy scenarios still need one.
        const requestedSourceId =
          params.scenario.mode === "bulk_campaign"
            ? ""
            : readTrimmedString(params.input.messageIntent.sourceId);
        if (!requestedSourceId) {
          return invalid("whatsapp_source_missing");
        }
        sourceIds = [requestedSourceId];
      }
    } else {
      // The bulk-send route resolves this source server-side. Builder bulk
      // roots store no sourceIds, so those send from the workspace source.
      const requestedSourceId = readTrimmedString(
        params.input.messageIntent.sourceId
      );
      if (requestedSourceId) {
        if (
          configuredSourceIds.length > 0 &&
          !configuredSourceIds.includes(requestedSourceId)
        ) {
          return invalid("whatsapp_source_mismatch");
        }
        sourceIds = [requestedSourceId];
      } else if (configuredSourceIds.length === 1) {
        sourceIds = configuredSourceIds;
      } else {
        return invalid("whatsapp_source_ambiguous");
      }
    }
  } else if (
    params.input.channel === "telegram" &&
    params.provenanceKind === "scenario_schedule" &&
    params.scenario.mode !== "bulk_campaign" &&
    rootConfig.recipientAudienceSource ===
      SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE
  ) {
    const selectedSourceId = readTrimmedString(
      rootConfig.telegramSubscriberSourceId
    );
    if (!selectedSourceId) return invalid("telegram_source_missing");
    if (
      configuredSourceIds.length > 0 &&
      !configuredSourceIds.includes(selectedSourceId)
    ) {
      return invalid("telegram_source_mismatch");
    }
    sourceIds = [selectedSourceId];
  } else {
    sourceIds = configuredSourceIds;
  }

  const routeActions = collectRouteActions(routing);
  routeActions.forEach(action =>
    assertActionMatchesChannel(action, params.input.channel)
  );

  let verifiedActions: Map<string, VerifiedAction>;
  if (params.input.channel === "whatsapp") {
    const messageIntent = params.input.messageIntent;
    if (messageIntent.kind !== "whatsapp_template") {
      return invalid("message_intent_mismatch");
    }
    const { catalogs, staleMissErrors } = await loadTemplateCatalogs({
      workspaceId: params.input.workspaceId,
      sourceIds,
      dependencies: params.dependencies,
    });
    verifiedActions = new Map(
      routeActions.map(action => [
        action.id,
        verifyWhatsAppAction({
          action,
          sourceIds,
          catalogs,
          staleMissErrors,
          normalizeLanguage:
            params.dependencies.normalizeWhatsAppTemplateLanguageForSend,
        }),
      ])
    );
    if (routing.kind === "direct") {
      const identity = readActionTemplateIdentity(
        routing.actionNode,
        params.dependencies.normalizeWhatsAppTemplateLanguageForSend
      );
      if (
        normalizeTemplateKey(
          identity.name,
          identity.language,
          params.dependencies.normalizeWhatsAppTemplateLanguageForSend
        ) !==
        normalizeTemplateKey(
          messageIntent.templateName,
          messageIntent.language,
          params.dependencies.normalizeWhatsAppTemplateLanguageForSend
        )
      ) {
        return invalid("template_identity_conflict");
      }
    }
  } else {
    const channel = params.input.channel;
    if (channel !== "telegram" && channel !== "email") {
      return invalid("message_intent_mismatch");
    }
    verifiedActions = new Map(
      routeActions.map(action => [
        action.id,
        verifyNonWhatsAppAction(action, channel),
      ])
    );
  }

  const verifiedRouting: DirectRoutingState | SplitRoutingState =
    routing.kind === "direct"
      ? {
          kind: "direct",
          action: verifiedActions.get(routing.actionNode.id)!,
        }
      : {
          kind: "column_split",
          splitNodeId: routing.splitNodeId,
          config: routing.config,
          actionByHandle: new Map(
            Array.from(routing.actionNodeByHandle.entries()).map(
              ([handle, action]) => [handle, verifiedActions.get(action.id)!]
            )
          ),
        };

  const state: ScenarioCapabilityState = {
    scenarioId: normalizedPersistedIdentity(params.scenario._id),
    rootNodeId: root.id,
    channel: params.input.channel,
    sourceIds: [...sourceIds],
    recipientPolicy,
    normalizeTemplateLanguage:
      params.dependencies.normalizeWhatsAppTemplateLanguageForSend,
    routing: verifiedRouting,
  };
  return params.provenanceKind === "scenario_schedule"
    ? createCapabilityToken({ kind: "scenario_schedule", scenario: state })
    : createCapabilityToken({ kind: "scenario_run_now", scenario: state });
}

async function verifyScenarioProvenanceCapability(
  input:
    | VerifyScenarioProvenanceCapabilityInput
    | VerifyScenarioScheduleClaimedCapabilityInput,
  provenanceKind: "scenario_run_now" | "scenario_schedule",
  dependencies?: VerifyBulkCampaignProvenanceDependencies
): Promise<
  | VerifiedBulkCampaignProvenanceCapability
  | VerifiedBulkCampaignScenarioScheduleCapability
> {
  try {
    const resolvedDependencies = await resolveDependencies(dependencies);
    const usesClaimedScheduleNode = "scheduledNodeId" in input;
    const scenarioId = readTrimmedString(
      usesClaimedScheduleNode ? input.scenarioId : input.intent.scenarioId
    );
    if (!readTrimmedString(input.workspaceId) || !scenarioId) {
      return invalid("scenario_identity_missing");
    }
    const scenario = await resolvedDependencies.findScenario({
      workspaceId: input.workspaceId,
      scenarioId,
    });
    if (
      !scenario ||
      normalizedPersistedIdentity(scenario._id) !== scenarioId ||
      readTrimmedString(scenario.workspaceId) !== input.workspaceId ||
      (scenario.deletedAt !== null && scenario.deletedAt !== undefined)
    ) {
      return invalid("scenario_not_found");
    }
    const graph = parseGraph(scenario);

    // Any mode may run now or schedule: the root must still pass isBulkRoot.
    // Only legacy bulk_campaign scenarios schedule a node below the root.
    const scheduledNodeId = usesClaimedScheduleNode
      ? readTrimmedString(input.scheduledNodeId)
      : "";
    const scheduledNode = scheduledNodeId
      ? graph.nodeById.get(scheduledNodeId)
      : undefined;
    const resolved = usesClaimedScheduleNode
      ? isBulkRoot(scheduledNode)
        ? { rootNodeId: scheduledNodeId }
        : scenario.mode === "bulk_campaign"
          ? findLegacyRoot({
              graph,
              claimedNodeId: scheduledNodeId,
              preserveClaimedSplitAction: true,
            })
          : invalid("scheduled_node_not_bulk_root")
      : input.intent.kind === "legacy_scenario_run_now"
        ? findLegacyRoot({
            graph,
            claimedNodeId: readTrimmedString(input.intent.claimedNodeId),
          })
        : {
            rootNodeId: readTrimmedString(input.intent.rootNodeId),
            actionNodeId: input.intent.actionNodeId
              ? readTrimmedString(input.intent.actionNodeId)
              : undefined,
            columnSplitNodeId: input.intent.columnSplitNodeId
              ? readTrimmedString(input.intent.columnSplitNodeId)
              : undefined,
          };

    return await buildScenarioCapability({
      input,
      provenanceKind,
      scenario,
      graph,
      ...resolved,
      dependencies: resolvedDependencies,
    });
  } catch (error) {
    if (error instanceof BulkCampaignProvenanceError) throw error;
    return invalid("lookup_failed", error);
  }
}

export async function verifyBulkCampaignProvenanceCapability(
  input: VerifyBulkCampaignProvenanceCapabilityInput,
  dependencies?: VerifyBulkCampaignProvenanceDependencies
): Promise<VerifiedBulkCampaignProvenanceCapability> {
  const intent = input.intent;
  if (intent.kind === "ad_hoc") {
    return createCapabilityToken({ kind: "ad_hoc", scenario: null });
  }
  return (await verifyScenarioProvenanceCapability(
    { ...input, intent },
    "scenario_run_now",
    dependencies
  )) as VerifiedBulkCampaignProvenanceCapability;
}

export type VerifyGeneratedBulkCampaignProvenanceCapabilityInput = {
  workspaceId: string;
  scenarioId: string;
  rootNodeId: string;
  audienceRevision: string;
};

export type GeneratedBulkCampaignProvenanceRecipient = {
  stableId: string;
  nodeId: string;
  branchId?: string | null;
  channel: BulkCampaignChannel;
  sourceId?: string | null;
  recipient: ScenarioCampaignRecipient;
};

export async function verifyGeneratedBulkCampaignProvenanceCapability(
  input: VerifyGeneratedBulkCampaignProvenanceCapabilityInput,
  dependencies?: VerifyBulkCampaignProvenanceDependencies
): Promise<VerifiedGeneratedBulkCampaignProvenanceCapability> {
  try {
    const workspaceId = readTrimmedString(input.workspaceId);
    const scenarioId = readTrimmedString(input.scenarioId);
    const rootNodeId = readTrimmedString(input.rootNodeId);
    const audienceRevision = readTrimmedString(input.audienceRevision);
    if (!workspaceId || !scenarioId || !rootNodeId || !audienceRevision) {
      return invalid("scenario_identity_missing");
    }
    const resolvedDependencies = await resolveDependencies(dependencies);
    const scenario = await resolvedDependencies.findScenario({
      workspaceId,
      scenarioId,
    });
    if (
      !scenario ||
      normalizedPersistedIdentity(scenario._id) !== scenarioId ||
      readTrimmedString(scenario.workspaceId) !== workspaceId ||
      (scenario.deletedAt !== null && scenario.deletedAt !== undefined)
    ) {
      return invalid("scenario_not_found");
    }
    const graph = parseGraph(scenario);
    const root = graph.nodeById.get(rootNodeId);
    if (!isBulkRoot(root)) return invalid("bulk_root_invalid");
    const config = root.data.bulkRootConfig;
    if (
      !isRecord(config) ||
      readTrimmedString(config.workflowKind) !== "bulk_campaign" ||
      config.sendMode !== "immediate" ||
      readTrimmedString(config.generationJobId) !== audienceRevision
    ) {
      return invalid("generated_revision_mismatch");
    }
    let recipientPolicy: BulkCampaignRecipientPolicy;
    try {
      recipientPolicy = normalizeBulkCampaignRecipientPolicy(
        config.recipientPolicy
      );
    } catch (error) {
      return invalid("recipient_policy_invalid", error);
    }
    const configuredChannels = Array.isArray(config.channels)
      ? config.channels.flatMap(value => {
          const channel = readTrimmedString(value);
          return channel ? [channel] : [];
        })
      : [];
    if (
      configuredChannels.length === 0 ||
      configuredChannels.some(
        channel =>
          channel !== "whatsapp" &&
          channel !== "telegram" &&
          channel !== "email"
      )
    ) {
      return invalid("bulk_root_channels_invalid");
    }
    const cohorts = Array.isArray(config.cohorts) ? config.cohorts : [];
    const cohortBranchIds = cohorts.map(value =>
      isRecord(value) ? readTrimmedString(value.branchId) : ""
    );
    if (
      cohortBranchIds.length === 0 ||
      cohortBranchIds.length > MAX_RECIPIENT_COLUMN_SPLIT_PATHS ||
      cohortBranchIds.some(value => !value) ||
      new Set(cohortBranchIds).size !== cohortBranchIds.length
    ) {
      return invalid("generated_cohorts_invalid");
    }

    const allRootOutbound = graph.edges.filter(edge => edge.source === root.id);
    const outbound = rootOutboundEdges(graph, root.id);
    if (
      outbound.length === 0 ||
      outbound.length > MAX_RECIPIENT_COLUMN_SPLIT_PATHS ||
      allRootOutbound.length !== outbound.length ||
      new Set(outbound.map(edge => edge.target)).size !== outbound.length
    ) {
      return invalid("generated_root_edges_invalid");
    }
    const cohortBranchIdSet = new Set(cohortBranchIds);
    const actions = outbound.map(edge => {
      const action = graph.nodeById.get(edge.target);
      if (!action || action.data.kind !== "action") {
        return invalid("action_node_invalid");
      }
      const branchId = readTrimmedString(action.data.bulkRecipientBranchId);
      if (!branchId || !cohortBranchIdSet.has(branchId)) {
        return invalid("generated_branch_mismatch");
      }
      return action;
    });
    const actionBranchIds = actions.map(action =>
      readTrimmedString(action.data.bulkRecipientBranchId)
    );
    const actionBranchIdSet = new Set(actionBranchIds);
    if (
      actionBranchIdSet.size !== actions.length ||
      actionBranchIds.length !== cohortBranchIds.length ||
      cohortBranchIds.some(branchId => !actionBranchIdSet.has(branchId))
    ) {
      return invalid("generated_branch_ambiguous");
    }

    const sourceIds = parseRootSourceIds(root);
    if (sourceIds.length > MAX_VERIFIED_BULK_CAMPAIGN_SOURCE_IDS) {
      return invalid("bulk_root_sources_limit_exceeded");
    }
    if (configuredChannels.includes("whatsapp") && sourceIds.length === 0) {
      return invalid("whatsapp_source_missing");
    }
    const actionById = new Map<
      string,
      { branchId: string; actionNode: GraphNode }
    >();
    for (const action of actions) {
      actionById.set(action.id, {
        branchId: readTrimmedString(action.data.bulkRecipientBranchId),
        actionNode: action,
      });
    }

    return createCapabilityToken({
      kind: "generated_scenario",
      scenario: {
        workspaceId,
        scenarioId,
        rootNodeId,
        sourceIds,
        configuredChannels: configuredChannels as BulkCampaignChannel[],
        recipientPolicy,
        normalizeTemplateLanguage:
          resolvedDependencies.normalizeWhatsAppTemplateLanguageForSend,
        actionById,
        dependencies: resolvedDependencies,
      },
    });
  } catch (error) {
    if (error instanceof BulkCampaignProvenanceError) throw error;
    return invalid("lookup_failed", error);
  }
}

function recipientStringHint(
  recipient: ScenarioCampaignRecipient,
  key: string
): string {
  return isRecord(recipient)
    ? readTrimmedString((recipient as Record<string, unknown>)[key])
    : "";
}

function resolveRouteSourceId(params: {
  state: ScenarioCapabilityState;
  recipient: ScenarioCampaignRecipient;
}): string | null {
  if (params.state.channel === "email") return null;
  const requested = readTrimmedString(params.recipient.sourceId);
  if (requested) {
    if (!params.state.sourceIds.includes(requested)) {
      return invalid(`${params.state.channel}_source_mismatch`);
    }
    return requested;
  }
  if (params.state.channel === "whatsapp") {
    if (params.state.sourceIds.length !== 1) {
      return invalid("whatsapp_source_ambiguous");
    }
    return params.state.sourceIds[0]!;
  }
  return null;
}

function routeRecipient(params: {
  state: ScenarioCapabilityState;
  stableId: string;
  recipient: ScenarioCampaignRecipient;
}): VerifiedBulkCampaignRoute {
  const sourceId = resolveRouteSourceId({
    state: params.state,
    recipient: params.recipient,
  });
  const action =
    params.state.routing.kind === "direct"
      ? params.state.routing.action
      : params.state.routing.actionByHandle.get(
          matchRecipientColumnSplit(
            params.recipient,
            params.state.routing.config
          ).handleId
        );
  if (!action) return invalid("recipient_route_missing");

  const route: VerifiedBulkCampaignRoute = {
    recipientStableId: params.stableId,
    actionNodeId: action.nodeId,
    channel: params.state.channel,
    sourceId,
  };
  if (params.state.channel !== "whatsapp") return route;
  if (!sourceId) return invalid("whatsapp_source_missing");
  const template = action.templatesBySourceId?.get(sourceId);
  if (!template) return invalid("approved_template_missing");

  const categoryHint = recipientStringHint(
    params.recipient,
    "templateCategory"
  ).toUpperCase();
  if (categoryHint && categoryHint !== template.category) {
    return invalid("template_category_conflict");
  }
  const templateNameHint = recipientStringHint(
    params.recipient,
    "templateName"
  );
  if (
    templateNameHint &&
    templateNameHint.toLowerCase() !== template.name.trim().toLowerCase()
  ) {
    return invalid("template_identity_conflict");
  }
  const languageHint = recipientStringHint(params.recipient, "languageCode");
  if (
    languageHint &&
    params.state.normalizeTemplateLanguage(languageHint) !== template.language
  ) {
    return invalid("template_identity_conflict");
  }

  return {
    ...route,
    template: {
      ...template,
      components: cloneWhatsAppComponents(template.components),
    },
    ...cloneStepTemplate(action.stepTemplate),
  };
}

function cloneStepTemplate(
  stepTemplate: CampaignScenarioStepTemplate | undefined
): Pick<VerifiedBulkCampaignRoute, "stepTemplate"> {
  return stepTemplate ? { stepTemplate: structuredClone(stepTemplate) } : {};
}

function landsOnUnconnectedSplitRoute(
  state: ScenarioCapabilityState,
  recipient: ScenarioCampaignRecipient
): boolean {
  return (
    state.routing.kind === "column_split" &&
    !state.routing.actionByHandle.has(
      matchRecipientColumnSplit(recipient, state.routing.config).handleId
    )
  );
}

function routeVerifiedScenarioCapability(
  kind: "scenario_run_now" | "scenario_schedule",
  state: ScenarioCapabilityState,
  recipients: VerifyBulkCampaignProvenanceInput["recipients"],
  options?: { skipUnconnectedSplitRoutes?: boolean }
): VerifiedBulkCampaignProvenance {
  if (!Array.isArray(recipients)) {
    return invalid("capability_invalid");
  }

  const skippedStableIds: string[] = [];
  const routes = recipients.flatMap(item => {
    const stableId = readTrimmedString(item?.stableId);
    if (!stableId || !isRecord(item?.recipient)) {
      return invalid("recipient_invalid");
    }
    // A schedule skips rows on a split path or Else left unconnected, the
    // same rows the scenario bulk node never sends.
    if (
      options?.skipUnconnectedSplitRoutes &&
      landsOnUnconnectedSplitRoute(state, item.recipient)
    ) {
      skippedStableIds.push(stableId);
      return [];
    }
    return [
      routeRecipient({
        state,
        stableId,
        recipient: item.recipient,
      }),
    ];
  });
  if (
    new Set([
      ...routes.map(route => route.recipientStableId),
      ...skippedStableIds,
    ]).size !==
    routes.length + skippedStableIds.length
  ) {
    return invalid("recipient_stable_id_duplicate");
  }
  // Nothing left to send is still the routing failure it was.
  if (routes.length === 0 && skippedStableIds.length > 0) {
    return invalid("recipient_route_missing");
  }

  return {
    [verifiedBulkCampaignProvenanceBrand]: true,
    kind,
    scenarioId: state.scenarioId,
    rootNodeId: state.rootNodeId,
    ...(state.routing.kind === "column_split"
      ? { columnSplitNodeId: state.routing.splitNodeId }
      : {}),
    routes,
    ...(skippedStableIds.length > 0 ? { skippedStableIds } : {}),
  };
}

export function routeVerifiedBulkCampaignProvenance(
  capability: VerifiedBulkCampaignProvenanceCapability,
  recipients: VerifyBulkCampaignProvenanceInput["recipients"]
): VerifiedBulkCampaignProvenance {
  if (!capability || typeof capability !== "object") {
    return invalid("capability_invalid");
  }
  const privateState = capabilityPrivateState.get(capability);
  if (
    !privateState ||
    privateState.kind === "scenario_schedule" ||
    privateState.kind === "generated_scenario"
  ) {
    return invalid("capability_invalid");
  }
  if (privateState.kind === "ad_hoc") {
    return {
      [verifiedBulkCampaignProvenanceBrand]: true,
      kind: "ad_hoc",
      routes: [],
    };
  }
  return routeVerifiedScenarioCapability(
    "scenario_run_now",
    privateState.scenario,
    recipients
  );
}

export async function routeVerifiedGeneratedBulkCampaignProvenance(
  capability: VerifiedGeneratedBulkCampaignProvenanceCapability,
  recipients: readonly GeneratedBulkCampaignProvenanceRecipient[]
): Promise<VerifiedGeneratedBulkCampaignProvenance> {
  const privateState = readCapabilityPrivateState(
    capability,
    "generated_scenario"
  );
  if (
    privateState.kind !== "generated_scenario" ||
    !Array.isArray(recipients)
  ) {
    return invalid("capability_invalid");
  }
  const state = privateState.scenario;
  const configuredChannelSet = new Set(state.configuredChannels);
  const sourceIdSet = new Set(state.sourceIds);
  const routedRecipients = recipients.map(item => {
    const stableId = readTrimmedString(item?.stableId);
    const nodeId = readTrimmedString(item?.nodeId);
    const branchId = readTrimmedString(item?.branchId);
    const routed = state.actionById.get(nodeId);
    if (
      !stableId ||
      !branchId ||
      !routed ||
      branchId !== routed.branchId ||
      !configuredChannelSet.has(item.channel) ||
      !isRecord(item.recipient)
    ) {
      return invalid("recipient_route_missing");
    }
    const candidateSourceId = readTrimmedString(item.sourceId);
    const recipientSourceId = readTrimmedString(item.recipient.sourceId);
    if (
      candidateSourceId &&
      recipientSourceId &&
      candidateSourceId !== recipientSourceId
    ) {
      return invalid(`${item.channel}_source_mismatch`);
    }
    let sourceId = candidateSourceId || recipientSourceId || null;
    if (sourceId && item.channel !== "email" && !sourceIdSet.has(sourceId)) {
      return invalid(`${item.channel}_source_mismatch`);
    }
    if (
      !sourceId &&
      item.channel !== "email" &&
      state.configuredChannels.length === 1 &&
      state.sourceIds.length === 1
    ) {
      sourceId = state.sourceIds[0]!;
    }
    return {
      stableId,
      sourceId,
      channel: item.channel,
      recipient: {
        ...item.recipient,
        ...(sourceId ? { sourceId } : {}),
      },
      routed,
    };
  });
  if (
    new Set(routedRecipients.map(route => route.stableId)).size !==
    routedRecipients.length
  ) {
    return invalid("recipient_stable_id_duplicate");
  }
  const whatsappSourceIds = Array.from(
    new Set(
      routedRecipients.flatMap(route =>
        route.channel === "whatsapp" && route.sourceId ? [route.sourceId] : []
      )
    )
  );
  // Generated sends keep approved_template_missing for every miss, stale
  // catalog or not: their orchestrator branches on that reason.
  const catalogs =
    whatsappSourceIds.length > 0
      ? (
          await loadTemplateCatalogs({
            workspaceId: state.workspaceId,
            sourceIds: whatsappSourceIds,
            dependencies: state.dependencies,
          })
        ).catalogs
      : new Map<string, Map<string, WhatsAppTemplate>>();
  const verifiedWhatsAppActions = new Map<string, VerifiedAction>();
  const routes: VerifiedGeneratedBulkCampaignRoute[] = routedRecipients.map(
    route => {
      const common = {
        recipientStableId: route.stableId,
        actionNodeId: route.routed.actionNode.id,
        channel: route.channel,
        sourceId: route.sourceId,
        actionNode: structuredClone(route.routed.actionNode),
      };
      if (route.channel !== "whatsapp") return common;
      if (!route.sourceId) return invalid("whatsapp_source_missing");
      const actionKey = `${route.routed.actionNode.id}:${route.sourceId}`;
      let action = verifiedWhatsAppActions.get(actionKey);
      if (!action) {
        action = verifyWhatsAppAction({
          action: route.routed.actionNode,
          sourceIds: [route.sourceId],
          catalogs,
          normalizeLanguage: state.normalizeTemplateLanguage,
        });
        verifiedWhatsAppActions.set(actionKey, action);
      }
      const template = action.templatesBySourceId?.get(route.sourceId);
      if (!template) return invalid("approved_template_missing");
      const categoryHint = recipientStringHint(
        route.recipient,
        "templateCategory"
      ).toUpperCase();
      if (categoryHint && categoryHint !== template.category) {
        return invalid("template_category_conflict");
      }
      const templateNameHint = recipientStringHint(
        route.recipient,
        "templateName"
      );
      if (
        templateNameHint &&
        templateNameHint.toLowerCase() !== template.name.trim().toLowerCase()
      ) {
        return invalid("template_identity_conflict");
      }
      const languageHint = recipientStringHint(route.recipient, "languageCode");
      if (
        languageHint &&
        state.normalizeTemplateLanguage(languageHint) !== template.language
      ) {
        return invalid("template_identity_conflict");
      }
      return {
        ...common,
        template: {
          ...template,
          components: cloneWhatsAppComponents(template.components),
        },
      };
    }
  );
  return {
    [verifiedBulkCampaignProvenanceBrand]: true,
    kind: "scenario_run_now",
    scenarioId: state.scenarioId,
    rootNodeId: state.rootNodeId,
    routes,
    supportsWhatsAppTemplate: routes.some(
      route => route.channel === "whatsapp" && Boolean(route.template)
    ),
    recipientPolicy: structuredClone(state.recipientPolicy),
  };
}

export async function verifyBulkCampaignProvenance(
  input: VerifyBulkCampaignProvenanceInput,
  dependencies?: VerifyBulkCampaignProvenanceDependencies
): Promise<VerifiedBulkCampaignProvenance> {
  const capability = await verifyBulkCampaignProvenanceCapability(
    {
      workspaceId: input.workspaceId,
      intent: input.intent,
      channel: input.channel,
      messageIntent: input.messageIntent,
    },
    dependencies
  );
  return routeVerifiedBulkCampaignProvenance(capability, input.recipients);
}

type VerifyBulkCampaignScenarioScheduleLocation =
  | {
      scheduledNodeId: string;
      rootNodeId?: never;
      actionNodeId?: never;
      columnSplitNodeId?: never;
    }
  | {
      /** @deprecated Prefer scheduledNodeId so the server derives the root. */
      scheduledNodeId?: never;
      rootNodeId: string;
      actionNodeId?: string;
      columnSplitNodeId?: string;
    };

export type VerifyBulkCampaignScenarioScheduleProvenanceInput = Omit<
  VerifyBulkCampaignProvenanceInput,
  "intent"
> & { scenarioId: string } & VerifyBulkCampaignScenarioScheduleLocation;

export type VerifyBulkCampaignScenarioScheduleCapabilityInput = Omit<
  VerifyBulkCampaignScenarioScheduleProvenanceInput,
  "recipients"
>;

export async function verifyBulkCampaignScenarioScheduleCapability(
  input: VerifyBulkCampaignScenarioScheduleCapabilityInput,
  dependencies?: VerifyBulkCampaignProvenanceDependencies
): Promise<VerifiedBulkCampaignScenarioScheduleCapability> {
  const scheduleDependencies = await resolveScheduleDependencies(dependencies);
  if ("scheduledNodeId" in input && input.scheduledNodeId) {
    return (await verifyScenarioProvenanceCapability(
      {
        workspaceId: input.workspaceId,
        scenarioId: input.scenarioId,
        scheduledNodeId: input.scheduledNodeId,
        channel: input.channel,
        messageIntent: input.messageIntent,
      },
      "scenario_schedule",
      scheduleDependencies
    )) as VerifiedBulkCampaignScenarioScheduleCapability;
  }
  const rootNodeId =
    "rootNodeId" in input ? readTrimmedString(input.rootNodeId) : "";
  return (await verifyScenarioProvenanceCapability(
    {
      workspaceId: input.workspaceId,
      intent: {
        kind: "scenario_run_now",
        scenarioId: input.scenarioId,
        rootNodeId,
        ...("actionNodeId" in input && input.actionNodeId
          ? { actionNodeId: input.actionNodeId }
          : {}),
        ...("columnSplitNodeId" in input && input.columnSplitNodeId
          ? { columnSplitNodeId: input.columnSplitNodeId }
          : {}),
      },
      channel: input.channel,
      messageIntent: input.messageIntent,
    },
    "scenario_schedule",
    scheduleDependencies
  )) as VerifiedBulkCampaignScenarioScheduleCapability;
}

export function routeVerifiedBulkCampaignScenarioScheduleProvenance(
  capability: VerifiedBulkCampaignScenarioScheduleCapability,
  recipients: VerifyBulkCampaignProvenanceInput["recipients"]
): VerifiedBulkCampaignProvenance {
  const privateState = readCapabilityPrivateState(
    capability,
    "scenario_schedule"
  );
  if (privateState.kind !== "scenario_schedule") {
    return invalid("capability_invalid");
  }
  return routeVerifiedScenarioCapability(
    "scenario_schedule",
    privateState.scenario,
    recipients,
    { skipUnconnectedSplitRoutes: true }
  );
}

export function readVerifiedBulkCampaignScenarioScheduleContext(
  capability: VerifiedBulkCampaignScenarioScheduleCapability
): {
  rootNodeId: string;
  recipientPolicy: BulkCampaignRecipientPolicy;
} {
  const privateState = readCapabilityPrivateState(
    capability,
    "scenario_schedule"
  );
  if (privateState.kind !== "scenario_schedule") {
    return invalid("capability_invalid");
  }
  return {
    rootNodeId: privateState.scenario.rootNodeId,
    recipientPolicy: structuredClone(privateState.scenario.recipientPolicy),
  };
}

export async function verifyBulkCampaignScenarioScheduleProvenance(
  input: VerifyBulkCampaignScenarioScheduleProvenanceInput,
  dependencies?: VerifyBulkCampaignProvenanceDependencies
): Promise<VerifiedBulkCampaignProvenance> {
  const capability = await verifyBulkCampaignScenarioScheduleCapability(
    {
      workspaceId: input.workspaceId,
      scenarioId: input.scenarioId,
      ...(input.scheduledNodeId
        ? { scheduledNodeId: input.scheduledNodeId }
        : {
            rootNodeId: input.rootNodeId,
            ...(input.actionNodeId ? { actionNodeId: input.actionNodeId } : {}),
            ...(input.columnSplitNodeId
              ? { columnSplitNodeId: input.columnSplitNodeId }
              : {}),
          }),
      channel: input.channel,
      messageIntent: input.messageIntent,
    },
    dependencies
  );
  return routeVerifiedBulkCampaignScenarioScheduleProvenance(
    capability,
    input.recipients
  );
}

import {
  createMetaWhatsAppFlow,
  findMetaWhatsAppFlowByExactName,
  findMetaWhatsAppFlowByIdOnWaba,
  getMetaWhatsAppFlow,
  isMetaWhatsAppFlowOwnedByWaba,
  updateMetaWhatsAppFlow,
  type MetaWhatsAppFlow,
} from "@/lib/whatsapp/flows/service";
import { pickWhatsAppTemplateFlowIdentifier } from "@icecore/shared/types/whatsapp-flows";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";

export class TemplateFlowRemapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateFlowRemapError";
  }
}

export type RemapTemplateFlowsForWabaDeps = {
  getFlow: typeof getMetaWhatsAppFlow;
  createFlow: typeof createMetaWhatsAppFlow;
  updateFlow: typeof updateMetaWhatsAppFlow;
  findFlowByName: typeof findMetaWhatsAppFlowByExactName;
  findFlowByIdOnWaba: typeof findMetaWhatsAppFlowByIdOnWaba;
};

const defaultDeps: RemapTemplateFlowsForWabaDeps = {
  getFlow: getMetaWhatsAppFlow,
  createFlow: createMetaWhatsAppFlow,
  updateFlow: updateMetaWhatsAppFlow,
  findFlowByName: findMetaWhatsAppFlowByExactName,
  findFlowByIdOnWaba: findMetaWhatsAppFlowByIdOnWaba,
};

function compactId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function flowStatus(flow: MetaWhatsAppFlow | null | undefined): string {
  return typeof flow?.status === "string" ? flow.status : "";
}

function flowName(
  flow: MetaWhatsAppFlow | null | undefined
): string | undefined {
  if (typeof flow?.name === "string" && flow.name.trim()) {
    return flow.name.trim();
  }
  return undefined;
}

function flowEndpointUri(
  flow: MetaWhatsAppFlow | null | undefined
): string | undefined {
  if (typeof flow?.endpoint_uri === "string" && flow.endpoint_uri.trim()) {
    return flow.endpoint_uri.trim();
  }
  return undefined;
}

const DEFAULT_FLOW_CATEGORIES = ["OTHER"];

function flowCategories(flow: MetaWhatsAppFlow | null | undefined): string[] {
  const raw = flow?.categories;
  if (!Array.isArray(raw)) return [...DEFAULT_FLOW_CATEGORIES];
  const categories = raw
    .map(value => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  return categories.length > 0 ? categories : [...DEFAULT_FLOW_CATEGORIES];
}

function asFlowJsonString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function clonedFlowId(result: {
  ok: boolean;
  flow?: MetaWhatsAppFlow | null;
  providerFlowId?: string;
}): string | undefined {
  return (
    compactId(result.flow?.id) ||
    compactId(result.providerFlowId) ||
    undefined
  );
}

function looksLikeNameConflict(error?: string): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes("already exists") ||
    lower.includes("already in use") ||
    lower.includes("duplicate") ||
    lower.includes("same name")
  );
}

export function collectTemplateFlowButtonIds(
  components: WhatsAppComponent[]
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const component of components) {
    if (component.type !== "BUTTONS") continue;
    for (const button of component.buttons) {
      if (button.type !== "FLOW") continue;
      const identifier = pickWhatsAppTemplateFlowIdentifier(button);
      if (identifier?.kind !== "flow_id") continue;
      const id = identifier.flow_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function remapTemplateFlowButtonIds(
  components: WhatsAppComponent[],
  idMap: Map<string, string>
): WhatsAppComponent[] {
  if (idMap.size === 0) return components;
  return components.map(component => {
    if (component.type !== "BUTTONS") return component;
    return {
      ...component,
      buttons: component.buttons.map(button => {
        if (button.type !== "FLOW") return button;
        const current = compactId(button.flow_id);
        const next = current ? idMap.get(current) : undefined;
        if (!next || next === current) return button;
        return { ...button, flow_id: next };
      }),
    };
  });
}

async function publishIfNeeded(
  params: {
    accessToken: string;
    flowId: string;
    status: string;
  },
  deps: RemapTemplateFlowsForWabaDeps
) {
  if (params.status === "PUBLISHED") return;
  const published = await deps.updateFlow({
    accessToken: params.accessToken,
    flowId: params.flowId,
    operation: "publish",
  });
  if (!published.ok) {
    throw new TemplateFlowRemapError(
      published.error ||
        "Copied the Flow onto the current WhatsApp account, but Meta could not publish it. Publish that Flow, then try again."
    );
  }
}

async function reuseFlowByNameOnCurrentWaba(
  params: {
    accessToken: string;
    currentWabaId: string;
    sourceName: string;
    sourceFlowId: string;
    sourceStatus: string;
  },
  deps: RemapTemplateFlowsForWabaDeps
): Promise<string | undefined> {
  const existing = await deps.findFlowByName({
    accessToken: params.accessToken,
    wabaId: params.currentWabaId,
    name: params.sourceName,
  });
  const existingId = clonedFlowId(existing);
  if (!existingId || existingId === params.sourceFlowId) return undefined;
  await publishIfNeeded(
    {
      accessToken: params.accessToken,
      flowId: existingId,
      status: flowStatus(existing.flow) || params.sourceStatus,
    },
    deps
  );
  return existingId;
}

async function readSourceFlow(
  params: {
    accessToken: string;
    flowId: string;
    sourceWabaId?: string;
  },
  deps: RemapTemplateFlowsForWabaDeps
): Promise<{
  flow: MetaWhatsAppFlow | null;
  flowJson?: unknown;
}> {
  const details = await deps.getFlow({
    accessToken: params.accessToken,
    flowId: params.flowId,
    includeJson: true,
  });
  if (details.ok && details.flow) {
    return { flow: details.flow, flowJson: details.flowJson };
  }

  if (!params.sourceWabaId) {
    return { flow: null };
  }

  const listed = await deps.findFlowByIdOnWaba({
    accessToken: params.accessToken,
    wabaId: params.sourceWabaId,
    flowId: params.flowId,
  });
  const listedFlow = listed.ok ? listed.flow ?? null : null;
  if (!listedFlow) {
    return { flow: null };
  }

  const listedId = compactId(listedFlow.id) || params.flowId;
  if (listedId === params.flowId) {
    return { flow: listedFlow };
  }

  const listedDetails = await deps.getFlow({
    accessToken: params.accessToken,
    flowId: listedId,
    includeJson: true,
  });
  return {
    flow: listedDetails.ok && listedDetails.flow ? listedDetails.flow : listedFlow,
    flowJson: listedDetails.flowJson,
  };
}

async function createFlowOnCurrentWaba(
  params: {
    accessToken: string;
    currentWabaId: string;
    name: string;
    categories: string[];
    flowJson: string;
    endpointUri?: string;
  },
  deps: RemapTemplateFlowsForWabaDeps
) {
  return deps.createFlow({
    accessToken: params.accessToken,
    wabaId: params.currentWabaId,
    name: params.name,
    categories: params.categories,
    flowJson: params.flowJson,
    publish: true,
    ...(params.endpointUri ? { endpointUri: params.endpointUri } : {}),
  });
}

async function copyFlowOntoCurrentWaba(
  params: {
    accessToken: string;
    currentWabaId: string;
    flowId: string;
    sourceFlow: MetaWhatsAppFlow;
    flowJson?: unknown;
  },
  deps: RemapTemplateFlowsForWabaDeps
): Promise<string> {
  const sourceName = flowName(params.sourceFlow);
  if (!sourceName) {
    throw new TemplateFlowRemapError(
      `This template uses a WhatsApp Flow that has no name (${params.flowId}). Rename that Flow, then try again.`
    );
  }

  const reused = await reuseFlowByNameOnCurrentWaba(
    {
      accessToken: params.accessToken,
      currentWabaId: params.currentWabaId,
      sourceName,
      sourceFlowId: params.flowId,
      sourceStatus: flowStatus(params.sourceFlow),
    },
    deps
  );
  if (reused) return reused;

  const flowJson = asFlowJsonString(params.flowJson);
  if (!flowJson) {
    throw new TemplateFlowRemapError(
      `Could not read Flow JSON for ${params.flowId} from the previous WhatsApp account. Recreate that Flow on the current account, then try again.`
    );
  }

  const categories = flowCategories(params.sourceFlow);
  const endpointUri = flowEndpointUri(params.sourceFlow);
  const created = await createFlowOnCurrentWaba(
    {
      accessToken: params.accessToken,
      currentWabaId: params.currentWabaId,
      name: sourceName,
      categories,
      flowJson,
      endpointUri,
    },
    deps
  );
  let nextId = clonedFlowId(created);
  let nextStatus = flowStatus(created.flow);
  let copyError = created.error;

  if (!nextId && looksLikeNameConflict(created.error)) {
    const existingId = await reuseFlowByNameOnCurrentWaba(
      {
        accessToken: params.accessToken,
        currentWabaId: params.currentWabaId,
        sourceName,
        sourceFlowId: params.flowId,
        sourceStatus: flowStatus(params.sourceFlow),
      },
      deps
    );
    if (existingId) return existingId;

    const retry = await createFlowOnCurrentWaba(
      {
        accessToken: params.accessToken,
        currentWabaId: params.currentWabaId,
        name: `${sourceName}_${params.currentWabaId.slice(-6)}`,
        categories,
        flowJson,
        endpointUri,
      },
      deps
    );
    nextId = clonedFlowId(retry);
    nextStatus = flowStatus(retry.flow);
    copyError = retry.error || copyError;
  }

  if (!nextId) {
    throw new TemplateFlowRemapError(
      copyError ||
        `Could not copy WhatsApp Flow ${params.flowId} onto the current account. Recreate that Flow on the current WhatsApp account, then try again.`
    );
  }

  await publishIfNeeded(
    {
      accessToken: params.accessToken,
      flowId: nextId,
      status: nextStatus,
    },
    deps
  );
  return nextId;
}

async function resolveFlowIdOnCurrentWaba(
  params: {
    accessToken: string;
    currentWabaId: string;
    sourceWabaId?: string;
    flowId: string;
  },
  deps: RemapTemplateFlowsForWabaDeps
): Promise<string> {
  const source = await readSourceFlow(
    {
      accessToken: params.accessToken,
      flowId: params.flowId,
      sourceWabaId: compactId(params.sourceWabaId),
    },
    deps
  );

  if (
    source.flow &&
    isMetaWhatsAppFlowOwnedByWaba(source.flow, params.currentWabaId)
  ) {
    await publishIfNeeded(
      {
        accessToken: params.accessToken,
        flowId: params.flowId,
        status: flowStatus(source.flow),
      },
      deps
    );
    return params.flowId;
  }

  if (source.flow) {
    return copyFlowOntoCurrentWaba(
      {
        accessToken: params.accessToken,
        currentWabaId: params.currentWabaId,
        flowId: params.flowId,
        sourceFlow: source.flow,
        flowJson: source.flowJson,
      },
      deps
    );
  }

  throw new TemplateFlowRemapError(
    `This template uses a WhatsApp Flow that does not exist on the current account (${params.flowId}). Recreate that Flow on the current WhatsApp account, then try again.`
  );
}

export async function remapTemplateFlowsForCurrentWaba(
  params: {
    accessToken: string;
    currentWabaId: string;
    sourceWabaId?: string;
    components: WhatsAppComponent[];
  },
  deps: RemapTemplateFlowsForWabaDeps = defaultDeps
): Promise<WhatsAppComponent[]> {
  const flowIds = collectTemplateFlowButtonIds(params.components);
  if (flowIds.length === 0) return params.components;

  const idMap = new Map<string, string>();
  for (const flowId of flowIds) {
    const nextId = await resolveFlowIdOnCurrentWaba(
      {
        accessToken: params.accessToken,
        currentWabaId: params.currentWabaId,
        sourceWabaId: params.sourceWabaId,
        flowId,
      },
      deps
    );
    if (nextId !== flowId) {
      idMap.set(flowId, nextId);
    }
  }

  return remapTemplateFlowButtonIds(params.components, idMap);
}

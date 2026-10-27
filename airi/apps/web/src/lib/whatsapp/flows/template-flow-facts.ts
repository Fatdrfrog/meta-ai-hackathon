import type { WhatsAppGraphClient } from "@icecore/shared/lib/meta/api";
import { extractWhatsAppFlowScreenIds } from "./screen-ids";
import {
  getMetaWhatsAppFlow,
  type WhatsAppFlowDetailsServiceResult,
} from "./service";
import {
  readCachedTemplateFlowFacts,
  writeCachedTemplateFlowFacts,
} from "./template-flow-facts-cache";
import {
  isWhatsAppFlowGraphId,
  TEMPLATE_FLOW_CHECK_MAX_FLOWS,
  type TemplateFlowFacts,
} from "./template-flow-health";
import { buildTemplateFormAnswerSchema } from "./template-form-answer-schema";

const TEMPLATE_FLOW_READ_TIMEOUT_MS = 8_000;
// Each Flow costs three Graph requests (details, assets, JSON download).
const TEMPLATE_FLOW_READ_CONCURRENCY = 4;

const templateFlowReadsInFlight = new Map<string, Promise<TemplateFlowFacts>>();

type ReadTemplateFlowFactsParams = {
  wabaId: string;
  accessToken: string;
  flowIds: readonly string[];
  /** Skip the cache and read Meta, then store the fresh answer. */
  refresh?: boolean;
  client?: WhatsAppGraphClient;
  now?: () => Date;
};

/**
 * Status, screen ids and answers of the Flows that template buttons open,
 * read through a shared cache. Failures come back as "unavailable" facts:
 * they never turn into warnings and never expose Graph error details.
 */
export async function readTemplateFlowFacts(
  params: ReadTemplateFlowFactsParams
): Promise<TemplateFlowFacts[]> {
  const flowIds = Array.from(
    new Set(params.flowIds.filter(isWhatsAppFlowGraphId))
  ).slice(0, TEMPLATE_FLOW_CHECK_MAX_FLOWS);

  const results: TemplateFlowFacts[] = new Array(flowIds.length);
  let next = 0;
  const worker = async () => {
    while (next < flowIds.length) {
      const index = next;
      next += 1;
      results[index] = await readOneTemplateFlowFacts(params, flowIds[index]);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(TEMPLATE_FLOW_READ_CONCURRENCY, flowIds.length) },
      worker
    )
  );
  return results;
}

async function readOneTemplateFlowFacts(
  params: ReadTemplateFlowFactsParams,
  flowId: string
): Promise<TemplateFlowFacts> {
  if (!params.refresh) {
    const cached = await readCachedTemplateFlowFacts({
      flowId,
      wabaId: params.wabaId,
      now: params.now,
    });
    if (cached) return cached;
  }

  const inFlightKey = `${params.wabaId}:${flowId}`;
  const existing = templateFlowReadsInFlight.get(inFlightKey);
  if (existing) return existing;

  const read = (async () => {
    const facts = await readLiveTemplateFlowFacts(params, flowId);
    await writeCachedTemplateFlowFacts({ wabaId: params.wabaId, facts });
    return facts;
  })();
  templateFlowReadsInFlight.set(inFlightKey, read);
  try {
    return await read;
  } finally {
    if (templateFlowReadsInFlight.get(inFlightKey) === read) {
      templateFlowReadsInFlight.delete(inFlightKey);
    }
  }
}

function isMissingFlowResult(result: WhatsAppFlowDetailsServiceResult) {
  // 404: not owned by this WABA. 100/33: Graph object doesn't exist.
  return (
    result.status === 404 ||
    (result.providerCode === 100 && result.providerSubcode === 33)
  );
}

async function readLiveTemplateFlowFacts(
  params: ReadTemplateFlowFactsParams,
  flowId: string
): Promise<TemplateFlowFacts> {
  const checkedAt = (params.now?.() ?? new Date()).toISOString();
  const unavailable: TemplateFlowFacts = {
    flowId,
    state: "unavailable",
    checkedAt,
  };
  try {
    const result = await getMetaWhatsAppFlow({
      accessToken: params.accessToken,
      flowId,
      includeJson: true,
      expectedWabaId: params.wabaId,
      signal: AbortSignal.timeout(TEMPLATE_FLOW_READ_TIMEOUT_MS),
      ...(params.client ? { client: params.client } : {}),
    });
    if (!result.ok || !result.flow) {
      return isMissingFlowResult(result)
        ? { flowId, state: "missing", checkedAt }
        : unavailable;
    }

    const status =
      typeof result.flow.status === "string"
        ? result.flow.status.trim().toUpperCase()
        : "";
    if (!status) return unavailable;
    const name =
      typeof result.flow.name === "string" && result.flow.name.trim()
        ? result.flow.name.trim()
        : null;
    const screenIds = result.flowJsonError
      ? []
      : extractWhatsAppFlowScreenIds(result.flowJson);
    return {
      flowId,
      state: "found",
      name,
      status,
      screenIds: screenIds.length > 0 ? screenIds : null,
      answerSchema: result.flowJsonError
        ? null
        : buildTemplateFormAnswerSchema({
            flowJson: result.flowJson,
            flowName: name,
          }),
      checkedAt,
    };
  } catch {
    return unavailable;
  }
}

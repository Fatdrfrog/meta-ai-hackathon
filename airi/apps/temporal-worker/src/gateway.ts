import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  AI_GATEWAY_PATHS,
  type AiGatewayAction,
  type AskDataContextGatewayRequest,
  type AskDataContextGatewayResponse,
  type DocumentEmbeddingBatchGatewayRequest,
  type DocumentEmbeddingBatchGatewayResponse,
  type DocumentEmbeddingGatewayRequest,
  type DocumentEmbeddingGatewayResponse,
  type LlmAnalyticsGatewayEventResponse,
  type LlmAnalyticsQueryGatewayRequest,
  type LlmAnalyticsQueryGatewayResponse,
  type QueryEmbeddingGatewayRequest,
  type QueryEmbeddingGatewayResponse,
} from "@icecore/airi-runtime/ai-gateway";
import { validateLlmAnalyticsEventBatch } from "@icecore/airi-runtime/llm-analytics";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  publishLlmAnalyticsEventsToPubSub,
  queryLlmAnalyticsFromBigQuery,
} from "./gcp-llm-analytics.js";
import {
  authorizeVercelOidcRequest,
  createVercelOidcAuthConfig,
  getHttpErrorStatus,
  HttpRequestValidationError,
  parseEnabledFlag,
  readJsonBody,
  type VercelOidcAuthConfig,
  writeJson,
} from "./http-service.js";
import { loadTemporalWorkerEnv } from "./load-env.js";

const DEFAULT_PORT = 8080;
const requireWeb = createRequire(import.meta.url);

type EmbeddingsModule = {
  getDocumentEmbeddingResult: (
    text: string,
    options?: { title?: string; action?: AiGatewayAction },
  ) => Promise<DocumentEmbeddingGatewayResponse["result"]>;
  getDocumentEmbeddingResultsBatch: (
    items: DocumentEmbeddingBatchGatewayRequest["items"],
    action?: AiGatewayAction,
  ) => Promise<DocumentEmbeddingBatchGatewayResponse["results"]>;
  getQueryEmbeddingResultWithCache: (
    text: string,
    action?: AiGatewayAction,
  ) => Promise<QueryEmbeddingGatewayResponse["result"]>;
};

type AskDataSearchModule = {
  searchAskDataContextLocal: (
    params: AskDataContextGatewayRequest,
  ) => Promise<AskDataContextGatewayResponse>;
};

let embeddingsModule: EmbeddingsModule | null = null;
let askDataSearchModule: AskDataSearchModule | null = null;

function getEmbeddingsModule(): EmbeddingsModule {
  embeddingsModule ||= requireWeb(
    "../../../apps/web/src/lib/ai/embeddings",
  ) as EmbeddingsModule;
  return embeddingsModule;
}

function getAskDataSearchModule(): AskDataSearchModule {
  askDataSearchModule ||= requireWeb(
    "../../../apps/web/src/lib/ai/ask-data-search-local",
  ) as AskDataSearchModule;
  return askDataSearchModule;
}

async function connectGatewayMongo(): Promise<unknown> {
  const { connectDB } = await import("@icecore/airi-runtime/mongoose");
  return connectDB();
}

type GatewayWarmupDependencies = {
  loadModules(): void;
  connect(): Promise<unknown>;
};

const gatewayWarmupDependencies: GatewayWarmupDependencies = {
  loadModules: () => {
    getAskDataSearchModule();
    getEmbeddingsModule();
  },
  connect: connectGatewayMongo,
};

/**
 * Loads the web module tree and opens the Mongo connection at startup, so
 * the first search request does not pay for them (about 14 s observed).
 * The module load is synchronous and happens before this returns; the
 * connection continues in the background. Failures are logged only: the
 * request path still loads and connects lazily, exactly as before.
 */
export function warmAIGatewayRuntime(
  dependencies: GatewayWarmupDependencies = gatewayWarmupDependencies,
): Promise<void> {
  const startedAt = Date.now();
  const fail = (phase: "modules" | "mongo", error: unknown) => {
    airiWorkerLogger.warn("airi.worker.ai_gateway_warmup_failed", {
      phase,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  };
  try {
    dependencies.loadModules();
  } catch (error) {
    fail("modules", error);
    return Promise.resolve();
  }
  const modulesMs = Date.now() - startedAt;
  return Promise.resolve()
    .then(() => dependencies.connect())
    .then(
      () => {
        airiWorkerLogger.info("airi.worker.ai_gateway", {
          note: "warmed",
          modulesMs,
          durationMs: Date.now() - startedAt,
        });
      },
      (error: unknown) => fail("mongo", error),
    );
}

function getGatewayAuthConfig(): VercelOidcAuthConfig {
  return createVercelOidcAuthConfig({
    authDisabled: parseEnabledFlag(process.env.AI_GATEWAY_DISABLE_AUTH, false),
    serviceName: "AI gateway",
  });
}

async function handleQueryEmbedding(
  request: QueryEmbeddingGatewayRequest,
): Promise<QueryEmbeddingGatewayResponse> {
  return {
    result: await getEmbeddingsModule().getQueryEmbeddingResultWithCache(
      request.text,
      request.action,
    ),
  };
}

async function handleDocumentEmbedding(
  request: DocumentEmbeddingGatewayRequest,
): Promise<DocumentEmbeddingGatewayResponse> {
  return {
    result: await getEmbeddingsModule().getDocumentEmbeddingResult(
      request.text,
      {
        title: request.title,
        action: request.action,
      },
    ),
  };
}

async function handleDocumentEmbeddingBatch(
  request: DocumentEmbeddingBatchGatewayRequest,
): Promise<DocumentEmbeddingBatchGatewayResponse> {
  return {
    results: await getEmbeddingsModule().getDocumentEmbeddingResultsBatch(
      request.items,
      request.action,
    ),
  };
}

async function handleAskDataContextSearch(
  request: AskDataContextGatewayRequest,
): Promise<AskDataContextGatewayResponse> {
  const startedAt = Date.now();
  const result = await getAskDataSearchModule().searchAskDataContextLocal({
    workspaceId: request.workspaceId,
    action: request.action,
    query: request.query,
    conversationLimit: request.conversationLimit,
    kbLimit: request.kbLimit,
    sourceIds: request.sourceIds,
    includeConversations: request.includeConversations,
    includeKnowledge: request.includeKnowledge,
  });

  airiWorkerLogger.info("airi.gateway.ask_data_context_search", {
    workspaceId: request.workspaceId,
    queryLength: String(request.query || "").length,
    conversationLimit: request.conversationLimit ?? null,
    kbLimit: request.kbLimit ?? null,
    sourceIdsCount: request.sourceIds?.length ?? 0,
    includeConversations: request.includeConversations ?? true,
    includeKnowledge: request.includeKnowledge ?? true,
    conversationsFound: result.conversations.length,
    kbArticlesFound: result.kbArticles.length,
    retrievalPath: result.metadata?.retrievalPath ?? null,
    vectorIndex: result.metadata?.vectorIndex ?? null,
    vectorConversationCount: result.metadata?.vectorConversationCount ?? null,
    fallbackConversationCount:
      result.metadata?.fallbackConversationCount ?? null,
    durationMs: Date.now() - startedAt,
  });

  return result;
}

async function handleLlmAnalyticsEvents(
  request: unknown,
): Promise<LlmAnalyticsGatewayEventResponse> {
  let batch;
  try {
    batch = validateLlmAnalyticsEventBatch(request);
  } catch (error) {
    throw new HttpRequestValidationError(
      error instanceof Error ? error.message : "Invalid analytics event batch",
    );
  }
  return publishLlmAnalyticsEventsToPubSub(batch.events);
}

async function handleLlmAnalyticsQuery(
  request: LlmAnalyticsQueryGatewayRequest,
): Promise<LlmAnalyticsQueryGatewayResponse> {
  return queryLlmAnalyticsFromBigQuery(request);
}

export async function routeGatewayRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  authConfig: VercelOidcAuthConfig,
): Promise<void> {
  const method = request.method || "GET";
  const url = new URL(request.url || "/", "http://127.0.0.1");

  if (method === "GET" && url.pathname === AI_GATEWAY_PATHS.health) {
    writeJson(response, 200, { ok: true });
    return;
  }

  if (method !== "POST") {
    writeJson(response, 405, { error: "Method not allowed" });
    return;
  }

  await authorizeVercelOidcRequest(request, authConfig);

  if (url.pathname === AI_GATEWAY_PATHS.queryEmbedding) {
    writeJson(
      response,
      200,
      await handleQueryEmbedding(
        await readJsonBody<QueryEmbeddingGatewayRequest>(request),
      ),
    );
    return;
  }

  if (url.pathname === AI_GATEWAY_PATHS.documentEmbedding) {
    writeJson(
      response,
      200,
      await handleDocumentEmbedding(
        await readJsonBody<DocumentEmbeddingGatewayRequest>(request),
      ),
    );
    return;
  }

  if (url.pathname === AI_GATEWAY_PATHS.documentEmbeddingBatch) {
    writeJson(
      response,
      200,
      await handleDocumentEmbeddingBatch(
        await readJsonBody<DocumentEmbeddingBatchGatewayRequest>(request),
      ),
    );
    return;
  }

  if (url.pathname === AI_GATEWAY_PATHS.askDataContextSearch) {
    writeJson(
      response,
      200,
      await handleAskDataContextSearch(
        await readJsonBody<AskDataContextGatewayRequest>(request),
      ),
    );
    return;
  }

  if (url.pathname === AI_GATEWAY_PATHS.llmEvents) {
    writeJson(
      response,
      202,
      await handleLlmAnalyticsEvents(await readJsonBody<unknown>(request)),
    );
    return;
  }

  if (url.pathname === AI_GATEWAY_PATHS.llmAnalyticsQuery) {
    writeJson(
      response,
      200,
      await handleLlmAnalyticsQuery(
        await readJsonBody<LlmAnalyticsQueryGatewayRequest>(request),
      ),
    );
    return;
  }

  writeJson(response, 404, { error: "Not found" });
}

export async function runAIGatewayServer(): Promise<void> {
  const loadedEnvFiles = loadTemporalWorkerEnv();
  const port = Math.max(1, Number(process.env.PORT || DEFAULT_PORT));
  const authConfig = getGatewayAuthConfig();
  // Before listening, so a request never waits on the synchronous module
  // load; the Mongo connection finishes in the background.
  void warmAIGatewayRuntime();

  const server = http.createServer((request, response) => {
    routeGatewayRequest(request, response, authConfig).catch((error) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const statusCode = getHttpErrorStatus(error);
      airiWorkerLogger.warn("airi.worker.ai_gateway_request_failed", {
        path: url.pathname,
        method: request.method || "GET",
        statusCode,
        error: error instanceof Error ? error.message : String(error),
      });
      writeJson(response, statusCode, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve());
  });

  airiWorkerLogger.info("airi.worker.ai_gateway", {
    port,
    note: "started",
    authDisabled: authConfig.authDisabled,
    issuerUrl: authConfig.issuerUrl,
    audience: authConfig.audience,
    allowedSubjects: authConfig.allowedSubjects,
    loadedEnvFiles,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAIGatewayServer().catch((error) => {
    airiWorkerLogger.error("airi.worker.ai_gateway", error, {
      note: "start_failed",
    });
    process.exit(1);
  });
}

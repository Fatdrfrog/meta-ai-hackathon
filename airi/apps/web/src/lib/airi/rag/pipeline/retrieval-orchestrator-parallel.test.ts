jest.mock("@/lib/ai", () => ({
  ...jest.requireActual("@/lib/ai"),
  getQueryEmbeddingWithCache: jest.fn(),
}));
jest.mock("@/lib/company-context", () => ({
  fetchCompanyContextByWorkspace: jest.fn(async () => ({})),
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn(), rpc: jest.fn() },
}));
jest.mock("./retrieval", () => ({ retrieveBestAnswer: jest.fn() }));
jest.mock("@/lib/airi/rag/kb/kb-retrieval", () => ({
  retrieveRelevantKBArticles: jest.fn(),
  retrievePinnedKBArticles: jest.fn(async () => []),
}));
jest.mock("./reranker", () => ({
  ...jest.requireActual("./reranker"),
  rerankKBArticles: jest.fn(async (_query: string, articles: unknown[]) =>
    articles.map(article => ({ ...(article as object), rerankerScore: 0.5 }))
  ),
}));

import { getQueryEmbeddingWithCache } from "@/lib/ai";
import { retrieveRelevantKBArticles } from "@/lib/airi/rag/kb/kb-retrieval";
import type { KBArticleResult } from "@/lib/airi/rag/kb/kb-types";
import type {
  HybridRetrievalOptions,
  RetrievedAnswer,
} from "@/lib/airi/rag/types";
import { RetrievalOrchestrator } from "./retrieval-orchestrator";
import { rerankKBArticles } from "./reranker";
import { retrieveBestAnswer } from "./retrieval";

const embedding = jest.mocked(getQueryEmbeddingWithCache);
const snippetSearch = jest.mocked(retrieveBestAnswer);
const kbSearch = jest.mocked(retrieveRelevantKBArticles);
const rerank = jest.mocked(rerankKBArticles);

const QUERY = "Сколько стоит доставка в Астану?";
const baseOptions: HybridRetrievalOptions = {
  includeSnippets: true,
  includeKB: true,
  includeConversationSummaries: false,
  enableTranslation: false,
  enableReranking: false,
  enableVerification: false,
  enableHyDE: false,
  skipLlmRetrievalPlanner: true,
  retrievalIntent: {
    query: QUERY,
    language: "ru",
    label: "pricing",
    confidence: "high",
    shouldUseBroadRetrieval: false,
    shouldUseOverviewVariants: false,
    queryVariants: [],
    reason: "fixture",
    source: "turn_understanding",
  },
};

function kbArticle(id: string): KBArticleResult {
  return {
    id,
    title: `Article ${id}`,
    fullContent: "Доставка по Астане — 2000 ₸.",
    similarity: 0.7,
    locale: "ru",
  };
}

/** Resolves when `release` is called, or after `ms` so a sequential run still ends. */
function gate(ms = 150) {
  let release!: () => void;
  const opened = new Promise<void>(resolve => {
    release = resolve;
    setTimeout(resolve, ms);
  });
  return { opened, release };
}

let events: string[];

beforeEach(() => {
  jest.clearAllMocks();
  events = [];
  embedding.mockImplementation(async (text: string) => {
    events.push(`embed:${text}`);
    return [1, 0, 0];
  });
});

function run(options: Partial<HybridRetrievalOptions> = {}) {
  return new RetrievalOrchestrator("workspace-a", QUERY, "ru", {
    ...baseOptions,
    ...options,
  }).orchestrate();
}

it("searches KB alongside the snippet instead of after it", async () => {
  const kbStarted = gate();
  snippetSearch.mockImplementation(async () => {
    events.push("snippet:start");
    await kbStarted.opened;
    events.push("snippet:end");
    return null;
  });
  kbSearch.mockImplementation(async (_workspaceId, variant) => {
    events.push(`kb:${variant}`);
    kbStarted.release();
    return [kbArticle("kb-1")];
  });

  const context = await run();

  expect(events.indexOf(`kb:${QUERY}`)).toBeGreaterThan(-1);
  expect(events.indexOf(`kb:${QUERY}`)).toBeLessThan(
    events.indexOf("snippet:end")
  );
  expect(context.kbArticles.map(article => article.id)).toEqual(["kb-1"]);
});

it("still drops KB results when a confident snippet short-circuits", async () => {
  const confident: RetrievedAnswer = {
    id: "snippet-1",
    question: "Сколько стоит доставка?",
    answer: "2000 ₸ по Астане.",
    score: 0.99,
  };
  snippetSearch.mockResolvedValue(confident);
  kbSearch.mockResolvedValue([kbArticle("kb-1")]);

  const context = await run();

  expect(context.snippet?.id).toBe("snippet-1");
  expect(context.kbArticles).toEqual([]);
});

it("embeds every variant up front and runs a blended turn's stage two with stage one", async () => {
  const variants = ["доставка Астана цена", "оплата при получении"];
  const stageTwoStarted = gate();
  snippetSearch.mockImplementation(async () => {
    events.push("snippet:end");
    return null;
  });
  kbSearch.mockImplementation(async (_workspaceId, variant) => {
    events.push(`kb:${variant}:start`);
    if (variant === QUERY) {
      await stageTwoStarted.opened;
    } else {
      stageTwoStarted.release();
    }
    events.push(`kb:${variant}:end`);
    return [kbArticle(variant)];
  });

  const context = await run({
    queryVariants: variants,
    forceBlendedRetrieval: true,
    forceBlendedReason: "thread_plan",
  });

  // Each variant's embedding is requested before any search finishes.
  for (const variant of variants) {
    expect(events.indexOf(`embed:${variant}`)).toBeLessThan(
      events.indexOf("snippet:end")
    );
    // Stage two starts while stage one is still searching.
    expect(events.indexOf(`kb:${variant}:start`)).toBeLessThan(
      events.indexOf(`kb:${QUERY}:end`)
    );
  }
  // One embedding request per distinct query text.
  expect(embedding).toHaveBeenCalledTimes(1 + variants.length);
  expect(context.kbArticles.map(article => article.id).sort()).toEqual(
    [QUERY, ...variants].sort()
  );
});

it("waits for stage one before deciding stage two on an unblended turn", async () => {
  snippetSearch.mockResolvedValue(null);
  kbSearch.mockImplementation(async (_workspaceId, variant) => {
    events.push(`kb:${variant}`);
    // A strong stage-one hit makes the extra variant unnecessary.
    return [{ ...kbArticle(variant), similarity: 0.99 }];
  });

  await run({ queryVariants: ["оплата при получении"] });

  expect(events.filter(event => event.startsWith("kb:"))).toEqual([
    `kb:${QUERY}`,
  ]);
});

it.each([
  ["skips", 0.95, 0],
  ["keeps", 0.7, 1],
])(
  "%s the rerank call when the top KB match is %s similar",
  async (_label, similarity, rerankCalls) => {
    snippetSearch.mockResolvedValue(null);
    kbSearch.mockResolvedValue([{ ...kbArticle("kb-1"), similarity }]);

    await run({ enableReranking: true });

    expect(rerank).toHaveBeenCalledTimes(rerankCalls);
  }
);

jest.mock("@/lib/kb/content-utils", () => ({
  extractPlainText: (content: string) => content,
}));

import { resolveEffectiveCitationDiscipline } from "@/lib/airi/grounding/citation-discipline";
import type {
  CitationStrength,
  FactualIntent,
  PlannerMode,
  RetrievalPlan,
} from "@/lib/airi/rag/evidence/evidence-types";
import type { KBArticleResult } from "@/lib/airi/rag/kb/kb-types";
import { rankKBArticlesForEval } from "@/lib/airi/rag/kb/kb-ranking";
import { chunkKbArticleByHeadings } from "@/lib/airi/rag/knowledge/knowledge-chunkers";
import {
  createFallbackRetrievalPlan,
  planRetrievalQuery,
} from "@/lib/airi/rag/pipeline/retrieval-planner";

import golden from "./golden-cases.json";

const GOLDEN_VERSION = 1;

type PlannerGoldenRow = {
  id: string;
  vertical?: string;
  query: string;
  language?: string;
  pinnedSourceIds?: string[];
  forceBlendedRetrieval?: boolean;
  expect: Partial<{
    plannerMode: PlannerMode;
    hydeRecommended: boolean;
    factualIntent: FactualIntent;
    requiredCitationStrength: CitationStrength;
  }>;
};

type CitationGoldenRow = {
  id: string;
  vertical?: string;
  planOverrides: {
    normalizedQuery?: string;
    standaloneQuery?: string;
    factualIntent?: FactualIntent;
    requiredCitationStrength?: CitationStrength;
    plannerMode?: PlannerMode;
    hydeRecommended?: boolean;
  };
  groundedStrictEnforcement: boolean;
  hasRetrievedSources: boolean;
  expectEffectiveCitation: CitationStrength;
};

type RankingGoldenRow = {
  id: string;
  vertical?: string;
  limit: number;
  expectOrder: string[];
  articles: Array<Record<string, unknown>>;
  metric?: { precisionAt1?: boolean; note?: string };
};

type GoldenFile = {
  version: number;
  planner: PlannerGoldenRow[];
  citation: CitationGoldenRow[];
  ranking: RankingGoldenRow[];
};

const g = golden as GoldenFile;

function mergeGoldenCitationPlan(
  overrides: CitationGoldenRow["planOverrides"]
): RetrievalPlan {
  const q = String(overrides.normalizedQuery ?? "golden-query");
  const base = createFallbackRetrievalPlan(q);
  return {
    ...base,
    normalizedQuery: overrides.normalizedQuery ?? base.normalizedQuery,
    standaloneQuery: overrides.standaloneQuery ?? base.standaloneQuery,
    factualIntent: overrides.factualIntent ?? base.factualIntent,
    requiredCitationStrength:
      overrides.requiredCitationStrength ?? base.requiredCitationStrength,
    plannerMode: overrides.plannerMode ?? base.plannerMode,
    hydeRecommended: overrides.hydeRecommended ?? base.hydeRecommended,
    ragQueryPreparation: {
      ...base.ragQueryPreparation,
      cleanedQuery:
        overrides.standaloneQuery ??
        overrides.normalizedQuery ??
        base.ragQueryPreparation.cleanedQuery,
      originalQuery:
        overrides.normalizedQuery ?? base.ragQueryPreparation.originalQuery,
    },
  };
}

function toKBArticle(row: Record<string, unknown>): KBArticleResult {
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    fullContent: String(row.fullContent ?? ""),
    similarity: Number(row.similarity),
    locale: String(row.locale ?? "en"),
    sourceType: row.sourceType as KBArticleResult["sourceType"],
    retrievalMethod: row.retrievalMethod as KBArticleResult["retrievalMethod"],
    contextFormat:
      (row.contextFormat as KBArticleResult["contextFormat"]) ?? "preview",
    chunkFusedScore:
      row.chunkFusedScore != null &&
      Number.isFinite(Number(row.chunkFusedScore))
        ? Number(row.chunkFusedScore)
        : undefined,
    chunkAuthorityScore:
      row.chunkAuthorityScore != null &&
      Number.isFinite(Number(row.chunkAuthorityScore))
        ? Number(row.chunkAuthorityScore)
        : undefined,
    chunkFreshnessAt:
      row.chunkFreshnessAt === undefined
        ? undefined
        : row.chunkFreshnessAt === null
          ? null
          : String(row.chunkFreshnessAt),
  };
}

describe("RAG golden cases (offline)", () => {
  it("golden-cases.json schema version matches runner", () => {
    expect(g.version).toBe(GOLDEN_VERSION);
  });

  describe.each(g.planner)("planner: $id", row => {
    it(`vertical=${row.vertical ?? "n/a"}`, async () => {
      const plan = await planRetrievalQuery({
        query: row.query,
        language: row.language ?? "en",
        pinnedSourceIds: row.pinnedSourceIds,
        forceBlendedRetrieval: row.forceBlendedRetrieval,
      });
      expect(plan).toEqual(expect.objectContaining(row.expect));
    });
  });

  describe.each(g.citation)("citation discipline: $id", row => {
    it(`effective citation = ${row.expectEffectiveCitation}`, () => {
      const plan = mergeGoldenCitationPlan(row.planOverrides);
      const level = resolveEffectiveCitationDiscipline({
        plan,
        groundedStrictEnforcement: row.groundedStrictEnforcement,
        hasRetrievedSources: row.hasRetrievedSources,
      });
      expect(level).toBe(row.expectEffectiveCitation);
    });
  });

  describe.each(g.ranking)("ranking: $id", row => {
    it(`order = ${row.expectOrder.join(",")}`, () => {
      const articles = row.articles.map(toKBArticle);
      const ranked = rankKBArticlesForEval(articles, row.limit);
      const ids = ranked.map(a => a.id);
      expect(ids).toEqual(row.expectOrder);
      if (row.metric?.precisionAt1 && row.expectOrder.length > 0) {
        expect(ids[0]).toBe(row.expectOrder[0]);
      }
    });
  });

  describe("chunking: FAQ article (locked behavior)", () => {
    const body = `
<h1>Руководство пользователя</h1>
<p>Добро пожаловать в наше руководство. Здесь вы найдёте ответы на популярные вопросы и инструкции по настройке.</p>
<h2>Начало работы</h2>
<p>Для начала работы создайте учётную запись и подтвердите адрес электронной почты. Это займёт не более пары минут.</p>
<h2>Часто задаваемые вопросы</h2>
<p>Вопрос: Как отменить подписку?</p>
<p>Ответ: Зайдите в настройки, откройте раздел «Подписка» и нажмите «Отменить подписку». Изменения вступят в силу в конце расчётного периода.</p>
<p>Вопрос: Есть ли бесплатный период?</p>
<p>Ответ: Да, для всех новых пользователей действует бесплатный период 7 дней. Пробный период подключается автоматически после регистрации.</p>
<p>Вопрос: Как связаться со службой поддержки?</p>
<p>Ответ: Напишите нам на support@example.com или нажмите на иконку чата в правом нижнем углу. Мы отвечаем в течение часа в рабочее время.</p>
`;

    it("produces 1 Q/A chunk per FAQ pair, each with the FAQ breadcrumb", () => {
      const chunks = chunkKbArticleByHeadings({
        articleId: "faq-golden",
        title: "Руководство",
        bodyText: body,
      });

      const faqChunks = chunks.filter(c => {
        const path = c.metadata?.headingPath as string[] | undefined;
        return path?.some(entry => /часто\s+задаваем/iu.test(entry)) ?? false;
      });

      expect(faqChunks.length).toBeGreaterThanOrEqual(3);

      for (const chunk of faqChunks) {
        const path = chunk.metadata?.headingPath as string[];
        expect(path.length).toBeGreaterThanOrEqual(2);
        expect(path).toContain("Часто задаваемые вопросы");
        // Leaf element is the specific question, not the FAQ heading.
        expect(path[path.length - 1]).not.toBe("Часто задаваемые вопросы");
      }

      const questions = faqChunks.map(c => {
        const path = c.metadata?.headingPath as string[];
        return path[path.length - 1];
      });
      expect(questions.some(q => /отменить\s+подписку/iu.test(q))).toBe(true);
      expect(questions.some(q => /бесплатн/iu.test(q))).toBe(true);
      expect(questions.some(q => /поддержки/iu.test(q))).toBe(true);

      for (const chunk of faqChunks) {
        expect(chunk.text).not.toMatch(/<\/?[a-z]+>/i);
        expect(chunk.text.startsWith("Q:")).toBe(true);
      }
    });

    it("keeps non-FAQ sections separately chunked (no FAQ cross-talk)", () => {
      const chunks = chunkKbArticleByHeadings({
        articleId: "faq-golden-2",
        title: "Руководство",
        bodyText: body,
      });
      const nonFaq = chunks.filter(c => {
        const path = c.metadata?.headingPath as string[] | undefined;
        return !(
          path?.some(entry => /часто\s+задаваем/iu.test(entry)) ?? false
        );
      });
      expect(nonFaq.length).toBeGreaterThan(0);
      expect(nonFaq.every(c => !c.text.includes("отменить подписку"))).toBe(
        true
      );
    });
  });
});

/** Lazy translation fallback: search in the query language first; translate only if retrieval misses. */

import { fetchCompanyContextByWorkspace } from "@/lib/company-context";
import type { KBArticleResult } from "@/lib/airi/rag/kb/kb-types";
import { retrieveRelevantKBArticles } from "@/lib/airi/rag/kb/kb-retrieval";
import { ragLogger } from "@/lib/airi/shared/logger";
import {
  shouldTranslateForRAG,
  translateQueryForRAG,
  type CompanyLanguage,
} from "@/lib/airi/rag/query/query-translator";
import { retrieveBestAnswer } from "@/lib/airi/rag/pipeline/retrieval";
import type { RetrievedAnswer } from "@/lib/airi/rag/types";

export interface TranslationInfo {
  wasTranslated: boolean;
  originalQuery: string;
  translatedQuery: string;
  fromLang: string;
  toLang: string;
}

export class TranslationCoordinator {
  static shouldTranslate(
    queryLang: string,
    companyLang?: CompanyLanguage
  ): boolean {
    return shouldTranslateForRAG(queryLang, companyLang);
  }

  /** Resolve company language for lazy fallback (no translation LLM call). */
  static async prepareTranslation(
    queryLang: string,
    workspaceId: string,
    preloadedCompanyLang?: CompanyLanguage
  ): Promise<{
    translationTimeMs: number;
  }> {
    let companyLang = preloadedCompanyLang;
    let hasCompanyContext = preloadedCompanyLang !== undefined;

    // Fetch company context only if it wasn't already fetched by the caller.
    if (companyLang === undefined) {
      const companyContext = await fetchCompanyContextByWorkspace(
        workspaceId
      ).catch(err => {
        ragLogger.translation.error(
          "Failed to fetch company context for translation",
          err,
          { workspaceId, queryLang }
        );
        return {};
      });

      hasCompanyContext = !!companyContext;
      companyLang = (companyContext as { airiLanguage?: CompanyLanguage })
        ?.airiLanguage;
    }

    ragLogger.translation.debug("Translation eligibility checked", {
      workspaceId,
      queryLang,
      companyLang,
      shouldTranslate: this.shouldTranslate(queryLang, companyLang),
      hasCompanyContext,
    });

    return {
      translationTimeMs: 0,
    };
  }

  static async buildFallbackTranslation(
    query: string,
    queryLang: string,
    companyLang: CompanyLanguage,
    workspaceId: string
  ): Promise<{ translationInfo?: TranslationInfo; translationTimeMs: number }> {
    if (!this.shouldTranslate(queryLang, companyLang)) {
      return { translationTimeMs: 0 };
    }

    const translationStart = Date.now();
    const translation = await translateQueryForRAG(
      query,
      queryLang,
      companyLang
    );
    const translationTimeMs = Date.now() - translationStart;

    if (!translation.wasTranslated) {
      return { translationTimeMs };
    }

    const translationInfo: TranslationInfo = {
      wasTranslated: true,
      originalQuery: query,
      translatedQuery: translation.translatedQuery,
      fromLang: translation.fromLang,
      toLang: translation.toLang,
    };

    ragLogger.translation.info("Translation prepared for fallback retrieval", {
      workspaceId,
      fromLang: queryLang,
      toLang: companyLang,
      originalPreview: query.slice(0, 50),
      translatedPreview: translation.translatedQuery.slice(0, 50),
      translationTimeMs,
    });

    return { translationInfo, translationTimeMs };
  }

  /** Retrieve snippet/KB using the translated query after an empty original-language pass. */
  static async executeTranslationFallback(
    translationInfo: TranslationInfo,
    workspaceId: string,
    options: {
      includeSnippets: boolean;
      includeKB: boolean;
      snippetThreshold: number;
      kbThreshold: number;
      kbLimit: number;
      enableReranking: boolean;
      enableHyDE?: boolean;
      allowedSnippetIds?: string[];
      companyLang: CompanyLanguage;
      knowledgeSearchPrincipal?: import("@/lib/airi/rag/knowledge/knowledge-search-permissions").KnowledgeSearchPrincipal;
      matchAllowedVisibilities?: string[] | null;
      matchSourceKinds?:
        | import("@/lib/airi/rag/kb/kb-types").KnowledgeCanonicalSourceKind[]
        | null;
    }
  ): Promise<{
    snippet: RetrievedAnswer | null;
    kbArticles: KBArticleResult[];
  }> {
    const {
      includeSnippets,
      includeKB,
      snippetThreshold,
      kbThreshold,
      kbLimit,
      enableReranking,
      enableHyDE,
      allowedSnippetIds,
      companyLang,
      knowledgeSearchPrincipal,
      matchAllowedVisibilities,
      matchSourceKinds,
    } = options;

    ragLogger.translation.info("Executing translation fallback retrieval", {
      workspaceId,
      originalLang: translationInfo.fromLang,
      translatedLang: translationInfo.toLang,
    });

    const [snippetTranslated, kbTranslated] = await Promise.all([
      includeSnippets
        ? retrieveBestAnswer(workspaceId, translationInfo.translatedQuery, {
            threshold: snippetThreshold,
            language: companyLang,
            allowedSnippetIds,
          }).catch(err => {
            ragLogger.translation.error(
              "Snippet retrieval with translated query failed",
              err,
              {
                workspaceId,
                translatedLang: companyLang,
              }
            );
            return null;
          })
        : Promise.resolve(null),
      includeKB
        ? retrieveRelevantKBArticles(
            workspaceId,
            translationInfo.translatedQuery,
            companyLang,
            {
              limit: enableReranking ? kbLimit * 2 : kbLimit,
              threshold: kbThreshold * 0.9, // Slightly lower threshold for translated search
              enableHyDERescue: enableHyDE,
              knowledgeSearchPrincipal,
              matchAllowedVisibilities,
              matchSourceKinds,
            }
          ).catch(err => {
            ragLogger.translation.error(
              "KB retrieval with translated query failed",
              err,
              {
                workspaceId,
                translatedLang: companyLang,
              }
            );
            return [];
          })
        : Promise.resolve([]),
    ]);

    ragLogger.translation.info("Translation fallback retrieval completed", {
      workspaceId,
      translatedLang: companyLang,
      snippetFound: !!snippetTranslated,
      kbResultsFound: kbTranslated?.length || 0,
      topKbSimilarity: kbTranslated?.[0]?.similarity || null,
    });

    return {
      snippet: snippetTranslated,
      kbArticles: kbTranslated || [],
    };
  }
}

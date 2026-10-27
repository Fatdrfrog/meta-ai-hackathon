/**
 * RAG-specific logger wrapper
 *
 * Extends shared logger with RAG-specific prefixes and context.
 * Provides consistent logging format across all RAG components.
 *
 * Usage:
 * ```ts
 * import { ragLogger } from './logger';
 *
 * ragLogger.retrieval.info('Starting KB search', { workspaceId, query });
 * ragLogger.decision.debug('Context decision', { priority, reason });
 * ragLogger.verification.error('Verification failed', error, { query });
 * ```
 */

import { createLogger, type LogContext } from "@icecore/shared/lib/logger";
import { RAG_CONFIG } from "@/lib/airi/rag/config";

// Base logger instance
const baseLogger = createLogger("rag");

// Extended LogContext for RAG operations
export interface RAGLogContext extends LogContext {
  workspaceId?: string;
  conversationId?: string;
  query?: string;
  [key: string]: unknown;
}

/**
 * RAG Logger with component-specific prefixes
 */
class RAGLogger {
  private baseLogger = baseLogger;
  private logLevel: "debug" | "info" | "warn" | "error";
  private enablePerformanceLogs: boolean;

  constructor() {
    this.logLevel = RAG_CONFIG.logging.level;
    this.enablePerformanceLogs = RAG_CONFIG.logging.enablePerformanceLogs;
  }

  /**
   * Check if a log level should be output
   */
  private shouldLog(level: "debug" | "info" | "warn" | "error"): boolean {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    return levels[level] >= levels[this.logLevel];
  }

  /**
   * Create a component-specific logger
   */
  private createComponentLogger(component: string) {
    return {
      debug: (message: string, context?: RAGLogContext) => {
        if (this.shouldLog("debug")) {
          this.baseLogger.debug(`[RAG:${component}] ${message}`, context);
        }
      },
      info: (message: string, context?: RAGLogContext) => {
        if (this.shouldLog("info")) {
          this.baseLogger.info(`[RAG:${component}] ${message}`, context);
        }
      },
      warn: (message: string, context?: RAGLogContext) => {
        if (this.shouldLog("warn")) {
          this.baseLogger.warn(`[RAG:${component}] ${message}`, context);
        }
      },
      error: (
        message: string,
        error?: Error | unknown,
        context?: RAGLogContext
      ) => {
        if (this.shouldLog("error")) {
          this.baseLogger.error(
            `[RAG:${component}] ${message}`,
            error,
            context
          );
        }
      },
      performance: (
        operation: string,
        durationMs: number,
        context?: RAGLogContext
      ) => {
        if (this.enablePerformanceLogs && this.shouldLog("info")) {
          this.baseLogger.info(`[RAG:${component}] Performance: ${operation}`, {
            ...context,
            durationMs,
            operation,
          });
        }
      },
    };
  }

  /** Retrieval operations (KB, snippets, conversation summaries) */
  retrieval = this.createComponentLogger("Retrieval");

  /** Decision engine (context selection, priority) */
  decision = this.createComponentLogger("Decision");

  /** Verification operations */
  verification = this.createComponentLogger("Verification");

  /** Reranking operations */
  reranker = this.createComponentLogger("Reranker");

  /** RRF fusion operations */
  rrf = this.createComponentLogger("RRF");

  /** Translation operations */
  translation = this.createComponentLogger("Translation");

  /** Query processing (cleaning, classification, etc.) */
  query = this.createComponentLogger("Query");

  /** General RAG operations */
  general = this.createComponentLogger("General");

  /**
   * Single structured wide event (no [RAG:Component] prefix on message).
   * Use stable `name` values such as `rag.request.complete` (canonical RAG wide event).
   */
  emitWideEvent(name: string, context?: LogContext): void {
    if (!this.shouldLog("info")) {
      return;
    }
    this.baseLogger.info(name, context);
  }
}

// Export singleton instance
export const ragLogger = new RAGLogger();

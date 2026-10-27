/**
 * Airi.chat Web Logger with PostHog Integration
 *
 * Extends shared logger with PostHog analytics tracking.
 * Automatically tracks errors and performance metrics.
 */

import {
  createLogger,
  type LogContext as BaseLogContext,
} from "@icecore/shared/lib/logger";
import { trackError, trackPerformance } from "./analytics";

// Extend LogContext to include app-specific fields
export interface LogContext extends BaseLogContext {
  workspaceId?: string;
  companyId?: string;
}

/**
 * Enhanced logger that integrates with PostHog
 */
class WebLogger {
  private baseLogger = createLogger("icecore-web");

  debug(message: string, context?: LogContext) {
    this.baseLogger.debug(message, context);
  }

  info(message: string, context?: LogContext) {
    this.baseLogger.info(message, context);
  }

  warn(message: string, context?: LogContext) {
    this.baseLogger.warn(message, context);
  }

  error(message: string, error?: Error | unknown, context?: LogContext) {
    this.baseLogger.error(message, error, context);

    // Track error in PostHog if workspace/company context is available
    if (context?.companyId && context?.workspaceId) {
      try {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        // Convert context to EventProperties (filter to compatible types)
        const eventContext: Record<
          string,
          string | number | boolean | string[] | undefined
        > = {};
        if (context) {
          for (const [key, value] of Object.entries(context)) {
            if (
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean" ||
              Array.isArray(value)
            ) {
              eventContext[key] = value as string | number | boolean | string[];
            } else if (value !== undefined && value !== null) {
              eventContext[key] = String(value);
            }
          }
        }

        trackError(
          context.companyId,
          context.workspaceId,
          "server_error",
          errorMessage,
          eventContext
        );
      } catch {
        // Silently fail if PostHog is not available
      }
    }
  }
}

// Export singleton instance
export const logger = new WebLogger();

/**
 * Widget-specific logging and analytics helpers
 * Integrates with PostHog for tracking
 */
export const widgetLogger = {
  configFetched: (
    workspaceId: string,
    companyId: string,
    clientKey: string
  ) => {
    logger.info("Widget config fetched", {
      event: "widget.config.fetched",
      workspaceId,
      companyId,
      clientKey: clientKey.slice(0, 16) + "...", // Partial key for security
    });

    // Track in PostHog
    try {
      trackPerformance(companyId, workspaceId, "widget_config_fetch", 0, {
        client_key: clientKey.slice(0, 16) + "...",
      });
    } catch {
      // Silently fail
    }
  },

  messageSent: (
    workspaceId: string,
    companyId: string,
    sourceId: string,
    conversationId: string,
    visitorId: string,
    pageUrl?: string
  ) => {
    logger.info("Widget message sent", {
      event: "widget.message.sent",
      workspaceId,
      companyId,
      sourceId,
      conversationId,
      visitorId,
      pageUrl,
    });
  },

  rateLimitExceeded: (
    endpoint: string,
    identifier: string,
    workspaceId?: string,
    companyId?: string
  ) => {
    logger.warn("Widget rate limit exceeded", {
      event: "widget.ratelimit.exceeded",
      endpoint,
      identifier,
      workspaceId,
      companyId,
    });

    // Track in PostHog if context available
    if (workspaceId && companyId) {
      try {
        trackError(
          companyId,
          workspaceId,
          "widget_rate_limit",
          "Rate limit exceeded",
          {
            endpoint,
            identifier,
          }
        );
      } catch {
        // Silently fail
      }
    }
  },

  domainUnauthorized: (
    origin: string,
    clientKey: string,
    workspaceId?: string,
    companyId?: string
  ) => {
    logger.warn("Widget domain unauthorized", {
      event: "widget.domain.unauthorized",
      origin,
      clientKey: clientKey.slice(0, 16) + "...",
      workspaceId,
      companyId,
    });

    // Track in PostHog if context available
    if (workspaceId && companyId) {
      try {
        trackError(
          companyId,
          workspaceId,
          "widget_domain_unauthorized",
          "Domain not authorized",
          {
            origin,
            client_key: clientKey.slice(0, 16) + "...",
          }
        );
      } catch {
        // Silently fail
      }
    }
  },

  error: (
    operation: string,
    error: Error | unknown,
    context?: LogContext & { workspaceId?: string; companyId?: string }
  ) => {
    logger.error(`Widget error: ${operation}`, error, {
      event: "widget.error",
      operation,
      ...context,
    });

    // Track in PostHog if context available
    if (context?.workspaceId && context?.companyId) {
      try {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        trackError(
          context.companyId,
          context.workspaceId,
          "widget_error",
          errorMessage,
          {
            operation,
            ...context,
          }
        );
      } catch {
        // Silently fail
      }
    }
  },
};

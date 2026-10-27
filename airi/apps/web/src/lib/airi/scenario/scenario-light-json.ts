import "server-only";

import { airiOrchestrationLogger } from "@/lib/airi/reply/runtime/reply-logging";
import {
  chatCompletionWithFallback,
  getLightStructuredJsonGenerationConfig,
  getLightTextModel,
} from "@/lib/ai";
import { withWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";
import { isRecord } from "@icecore/shared/lib/value-utils";

/** A model reply's JSON object, read strictly after any Markdown code fence. */
export function parseFencedJsonObject(
  content: string,
  label: string
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    content
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim()
  );
  if (!isRecord(parsed)) throw new Error(`${label} was not a JSON object.`);
  return parsed;
}

/**
 * One light-model JSON call about a customer's words, under the workspace's
 * AI policy. Null when the call fails or its reply does not parse.
 */
export async function completeScenarioLightJson<T>(params: {
  workspaceId: string;
  /** The policy action, analytics operation and log event. */
  operation: string;
  system: string;
  user: string;
  parse: (content: string) => T;
}): Promise<T | null> {
  try {
    return await withWorkspaceTextAiAction(
      { workspaceId: params.workspaceId, actionId: params.operation },
      async () => {
        const result = await chatCompletionWithFallback({
          model: getLightTextModel(),
          temperature: 0,
          responseFormat: { type: "json_object" },
          generationConfig: getLightStructuredJsonGenerationConfig(),
          resilience: {
            maxRetries: 1,
            timeoutMs: 8000,
            disableInternalFallbacks: true,
          },
          analytics: {
            workspaceId: params.workspaceId,
            operation: params.operation,
            sourceService: "web",
          },
          messages: [
            { role: "system", content: params.system },
            { role: "user", content: params.user },
          ],
        });
        return params.parse(result.content);
      }
    );
  } catch (error) {
    airiOrchestrationLogger.warn(`airi.orchestration.${params.operation}`, {
      workspaceId: params.workspaceId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

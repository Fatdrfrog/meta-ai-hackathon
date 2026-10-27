"use client";

import { listFlowFieldAnswerTokens } from "@/components/scenarios/builders/whatsapp/flow-field-answer-tokens";
import type { WhatsAppFlowConfig } from "@/components/scenarios/types";
import { stampScenarioFormAnswersKey } from "@/lib/scenarios/scenario-form-answer-checks";
import { useCallback, useMemo } from "react";

/**
 * The form a step's Flow builder edits, with its `answersKey` stored: the
 * builder shows it with its key and every change it commits keeps that key,
 * so a form gets its name in variables when it is made and keeps it. Outside
 * a scenario graph there are no keys to keep unique, and nothing is stamped.
 */
export function useFormAnswersKeyStamp({
  nodeId,
  formKeysByNodeId,
  flowConfig,
  onFlowConfigChange,
}: {
  nodeId: string | undefined;
  formKeysByNodeId: ReadonlyMap<string, string> | undefined;
  flowConfig: WhatsAppFlowConfig | null | undefined;
  onFlowConfigChange: (config: WhatsAppFlowConfig) => void;
}) {
  const scope = useMemo(
    () =>
      nodeId !== undefined && formKeysByNodeId
        ? { nodeId, formKeysByNodeId }
        : null,
    [formKeysByNodeId, nodeId]
  );
  const stampedConfig = useMemo(
    () =>
      flowConfig && scope
        ? stampScenarioFormAnswersKey(flowConfig, scope)
        : flowConfig,
    [flowConfig, scope]
  );
  const commitFlowConfig = useCallback(
    (config: WhatsAppFlowConfig) =>
      onFlowConfigChange(
        scope ? stampScenarioFormAnswersKey(config, scope) : config
      ),
    [onFlowConfigChange, scope]
  );
  const answerTokens = useMemo(
    () => listFlowFieldAnswerTokens(stampedConfig),
    [stampedConfig]
  );
  return { flowConfig: stampedConfig, commitFlowConfig, answerTokens };
}

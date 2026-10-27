"use client";

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { mutate } from "swr";
import type {
  ScenarioNodeData,
  ScenarioWhatsAppTemplate,
} from "@icecore/scenario-contracts";
import { workspaceOnboardingKey } from "@/components/nav/workspace-onboarding-state";
import { describeTemplateFlowIssue } from "@/components/whatsapp-templates/template-flow-health-notice";
import { projectActiveClientMessageFilters } from "@/lib/scenarios/client-message-trigger-criteria";
import {
  type ScenarioGraphValidationErrorKey,
  validateScenarioGraph,
  validateScenarioGraphActionPayloads,
} from "@/lib/scenarios/graph-validation";
import { normalizeScenarioTriggerConfig } from "@/lib/scenarios/trigger-utils";
import { listWhatsAppTemplateButtonDrift } from "@/lib/scenarios/whatsapp-template-button-branches";
import { findMatchingScenarioWhatsAppTemplate } from "@/lib/scenarios/whatsapp-template-selection";
import { fetchTemplateFlowFacts } from "@/lib/whatsapp/flows/client";
import {
  collectTemplateFlowIds,
  evaluateTemplateFlowHealth,
  type TemplateFlowFactsByFlowId,
} from "@/lib/whatsapp/flows/template-flow-health";
import type {
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioStatus,
  ScenarioSummary,
  TranslateFn,
} from "../types";
import { buildScenarioSummaryChips } from "./scenario-builder-summary-labels";
import type { ScenarioIssueVisualSeverity } from "./scenario-issue-visuals";
import { translateScenarioErrorCode } from "./scenario-request-error-utils";
import { describeWhatsAppTemplateButtonDrift } from "./scenario-template-utils";

export type ScenarioActivationImpactGraph = {
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
};

export type ScenarioActivationImpactIssue = {
  id: string;
  severity: ScenarioIssueVisualSeverity;
  title: string;
  description: string;
  /** The block to fix, named for people; never the raw node id. */
  block?: { nodeId: string; label: string };
};

export type ScenarioActivationImpact = {
  scenarioId: string;
  scenarioName: string;
  summaryChips: string[];
  journeyDescription: string;
  issues: ScenarioActivationImpactIssue[];
  /** Template Flow checks are still reading Meta; they only ever add warnings. */
  pendingChecks?: boolean;
};

type ScenarioTemplateFlowTarget = {
  key: string;
  templateName: string;
  components: unknown;
};

/** Templates with Flow buttons that the scenario sends, once per template. */
export function collectScenarioTemplateFlowTargets(params: {
  nodes: ScenarioFlowNode[];
  whatsAppTemplates: ScenarioWhatsAppTemplate[];
}): ScenarioTemplateFlowTarget[] {
  const targets = new Map<string, ScenarioTemplateFlowTarget>();
  for (const node of params.nodes) {
    const data = node.data as Partial<ScenarioNodeData> | undefined;
    if (data?.actionType !== "whatsapp_template") continue;
    const liveTemplate = findMatchingScenarioWhatsAppTemplate({
      nodeData: data,
      whatsAppTemplates: params.whatsAppTemplates,
    });
    // Meta sends the template as it is now; the node keeps an older copy.
    const components =
      liveTemplate?.components ?? data.actionWhatsAppTemplateComponents;
    if (collectTemplateFlowIds(components).length === 0) continue;
    const templateName =
      data.actionWhatsAppTemplateName?.trim() || liveTemplate?.name || "";
    const language =
      data.actionWhatsAppTemplateLanguage?.trim() ||
      liveTemplate?.language ||
      "";
    const key = `${templateName}:${language}`;
    if (!targets.has(key)) {
      targets.set(key, { key, templateName, components });
    }
  }
  return Array.from(targets.values());
}

/**
 * Non-blocking warnings: the approved template's reply buttons change where
 * a step's routes run. Once per template and difference.
 */
export function buildTemplateButtonDriftActivationIssues(params: {
  graph: ScenarioActivationImpactGraph;
  whatsAppTemplates: ScenarioWhatsAppTemplate[];
  t: TranslateFn;
}): ScenarioActivationImpactIssue[] {
  const issues = new Map<string, ScenarioActivationImpactIssue>();
  for (const node of params.graph.nodes) {
    const data = node.data as Partial<ScenarioNodeData> | undefined;
    if (data?.actionType !== "whatsapp_template") continue;
    const liveTemplate = findMatchingScenarioWhatsAppTemplate({
      nodeData: data,
      whatsAppTemplates: params.whatsAppTemplates,
    });
    if (!liveTemplate) continue;
    const drift = listWhatsAppTemplateButtonDrift({
      nodeData: data,
      liveComponents: liveTemplate.components,
      routedSourceHandleIds: params.graph.edges.flatMap(edge =>
        edge.source === node.id && edge.sourceHandle ? [edge.sourceHandle] : []
      ),
    });
    const template = liveTemplate.name;
    for (const item of drift) {
      const description = describeWhatsAppTemplateButtonDrift(item, params.t);
      const id = `template-buttons-${template}:${liveTemplate.language}-${description}`;
      issues.set(id, {
        id,
        severity: "warning",
        title: params.t("activationImpactTemplateButtonsTitle", { template }),
        description,
      });
    }
  }
  return Array.from(issues.values());
}

/** Non-blocking warnings: the messages still send, only the button fails. */
export function buildTemplateFlowActivationIssues(params: {
  targets: ScenarioTemplateFlowTarget[];
  factsByFlowId: TemplateFlowFactsByFlowId;
  t: TranslateFn;
  tTemplates: (key: string, values?: Record<string, string>) => string;
}): ScenarioActivationImpactIssue[] {
  return params.targets.flatMap(target =>
    evaluateTemplateFlowHealth(
      target.components,
      params.factsByFlowId
    ).issues.map(issue => ({
      id: `template-flow-${target.key}-${issue.button.index}-${issue.code}`,
      severity: "warning" as const,
      title: params.t("activationImpactTemplateFlowTitle", {
        template: target.templateName,
      }),
      description: describeTemplateFlowIssue(issue, params.tTemplates),
    }))
  );
}

function resolveJourneyDescription(params: {
  scenario: ScenarioSummary;
  scenarios: ScenarioSummary[];
  t: TranslateFn;
}) {
  const parentIds = Array.isArray(params.scenario.linkedParentScenarioIds)
    ? params.scenario.linkedParentScenarioIds.filter(Boolean)
    : [];

  if (parentIds.length === 0) {
    return params.t("activationImpactJourneyStarts");
  }

  if (parentIds.length === 1) {
    const parentScenario = params.scenarios.find(
      scenario => scenario._id === parentIds[0]
    );
    return params.t("activationImpactJourneyJoins", {
      name: parentScenario?.name || params.t("unknown"),
    });
  }

  return params.t("activationImpactJourneyMultiple", {
    count: parentIds.length,
  });
}

type ActivationBlockedNode = {
  code: ScenarioGraphValidationErrorKey;
  nodeId: string;
  kind: "trigger" | "action";
};

/**
 * Runnable checks that need no server evidence: an empty message filter and
 * an unfinished reply, the blockers every first scenario used to hit. Checked
 * per block so the dialog can name each one. Provider bindings and QR
 * readiness stay with the server, which needs stored evidence for them.
 */
export function collectActivationBlockedNodes(
  nodes: Array<{ id: string; data: ScenarioNodeData }>
): ActivationBlockedNode[] {
  const blocked: ActivationBlockedNode[] = [];
  for (const node of nodes) {
    if (node.data?.kind === "trigger") {
      const criteria = projectActiveClientMessageFilters(
        normalizeScenarioTriggerConfig({ nodeData: node.data })
      );
      if (criteria.enabled && criteria.text.status !== "valid") {
        blocked.push({
          code: "messageTriggerIncomplete",
          nodeId: node.id,
          kind: "trigger",
        });
      }
    } else if (node.data?.kind === "action") {
      const code = validateScenarioGraphActionPayloads([node]);
      if (code) blocked.push({ code, nodeId: node.id, kind: "action" });
    }
  }
  return blocked;
}

/**
 * Surface the blocks that would stop activation: the graph-mode check plus
 * the evidence-free runnable checks above. A listed error always blocks
 * activation, so the modal never over-reports.
 */
function buildActivationImpactIssues(params: {
  graph?: ScenarioActivationImpactGraph;
  whatsAppTemplates?: ScenarioWhatsAppTemplate[];
  t: TranslateFn;
}): ScenarioActivationImpactIssue[] {
  if (!params.graph) return [];
  const nodes = params.graph.nodes as Array<{
    id: string;
    data: ScenarioNodeData;
  }>;
  const code = validateScenarioGraph(nodes, params.graph.edges, {
    mode: "graph",
  });
  const describe = (errorCode: string) =>
    translateScenarioErrorCode(
      errorCode,
      params.t,
      "activationImpactBlockingIssueGeneric"
    );
  const blockers: ScenarioActivationImpactIssue[] = code
    ? [
        {
          id: `activation-blocker-${code}`,
          severity: "error",
          title: params.t("activationImpactBlockingIssueTitle"),
          description: describe(code),
        },
      ]
    : [];
  const blockedNodes = collectActivationBlockedNodes(nodes).map(
    (blocked): ScenarioActivationImpactIssue => ({
      id: `activation-blocker-${blocked.code}-${blocked.nodeId}`,
      severity: "error",
      title: params.t("activationImpactBlockingIssueTitle"),
      description: describe(blocked.code),
      block: {
        nodeId: blocked.nodeId,
        label: params.t("activationImpactBlockLabel", {
          block: params.t(
            blocked.kind === "trigger" ? "badgeTrigger" : "messageSection"
          ),
        }),
      },
    })
  );
  return [
    ...blockers,
    ...blockedNodes,
    ...buildTemplateButtonDriftActivationIssues({
      graph: params.graph,
      whatsAppTemplates: params.whatsAppTemplates ?? [],
      t: params.t,
    }),
  ];
}

export function buildScenarioActivationImpact(params: {
  scenario: ScenarioSummary;
  scenarios: ScenarioSummary[];
  graph?: ScenarioActivationImpactGraph;
  /** The approved templates, for the reply-button checks. */
  whatsAppTemplates?: ScenarioWhatsAppTemplate[];
  t: TranslateFn;
}): ScenarioActivationImpact {
  return {
    scenarioId: params.scenario._id,
    scenarioName: params.scenario.name,
    summaryChips: buildScenarioSummaryChips(params.scenario, params.t),
    journeyDescription: resolveJourneyDescription(params),
    issues: buildActivationImpactIssues({
      graph: params.graph,
      whatsAppTemplates: params.whatsAppTemplates,
      t: params.t,
    }),
  };
}

export type ScenarioSettingsSaveParams = {
  scenarioId: string;
  status: ScenarioStatus;
  priority: number;
};

type PendingScenarioActivationImpact = {
  params: ScenarioSettingsSaveParams;
  impact: ScenarioActivationImpact;
  flowCheckId: number;
};

type ScenarioActivationImpactPlanParams = {
  scenario: ScenarioSummary;
  saveParams: ScenarioSettingsSaveParams;
  workspaceId?: string;
  activeScenario: ScenarioSummary | null | undefined;
  activeScenarioName: string;
  activeScenarioStatus: ScenarioStatus;
  activeScenarioNodes: ScenarioFlowNode[];
  activeScenarioEdges: ScenarioFlowEdge[];
  scenarios: ScenarioSummary[];
  whatsAppTemplates?: ScenarioWhatsAppTemplate[];
  t: TranslateFn;
};

/** The scenario as activation leaves it, with the editor's unsaved name. */
function resolveScenarioForActivationImpact(
  params: ScenarioActivationImpactPlanParams
): ScenarioSummary {
  const { activeScenario, scenario, saveParams } = params;
  if (!activeScenario || activeScenario._id !== scenario._id) {
    return {
      ...scenario,
      status: saveParams.status,
      priority: saveParams.priority,
    };
  }
  return {
    ...scenario,
    name: params.activeScenarioName || scenario.name,
    status: params.activeScenarioStatus,
    priority: saveParams.priority,
    matchingRole: activeScenario.matchingRole ?? scenario.matchingRole,
  };
}

/**
 * What the activation dialog shows, and the template Flows it still has to
 * check. The editor graph is only in hand for the scenario open in it, so
 * only that one gets graph issues and Flow checks.
 */
function planScenarioActivationImpact(
  params: ScenarioActivationImpactPlanParams
): {
  impact: ScenarioActivationImpact;
  flowTargets: ScenarioTemplateFlowTarget[];
} {
  const isActiveScenario = params.activeScenario?._id === params.scenario._id;
  const impact = buildScenarioActivationImpact({
    scenario: resolveScenarioForActivationImpact(params),
    scenarios: params.scenarios,
    graph: isActiveScenario
      ? { nodes: params.activeScenarioNodes, edges: params.activeScenarioEdges }
      : undefined,
    whatsAppTemplates: params.whatsAppTemplates,
    t: params.t,
  });
  const flowTargets =
    isActiveScenario && params.workspaceId
      ? collectScenarioTemplateFlowTargets({
          nodes: params.activeScenarioNodes,
          whatsAppTemplates: params.whatsAppTemplates ?? [],
        })
      : [];
  return {
    impact:
      flowTargets.length > 0 ? { ...impact, pendingChecks: true } : impact,
    flowTargets,
  };
}

type UseScenarioActivationImpactGuardParams = {
  workspaceId?: string;
  activeScenario: ScenarioSummary | null | undefined;
  activeScenarioName: string;
  activeScenarioStatus: ScenarioStatus;
  activeScenarioNodes: ScenarioFlowNode[];
  activeScenarioEdges: ScenarioFlowEdge[];
  scenarios: ScenarioSummary[];
  whatsAppTemplates?: ScenarioWhatsAppTemplate[];
  saveScenarioSettings: (
    params: ScenarioSettingsSaveParams
  ) => Promise<boolean> | boolean;
  t: TranslateFn;
};

export function useScenarioActivationImpactGuard({
  workspaceId,
  activeScenario,
  activeScenarioName,
  activeScenarioStatus,
  activeScenarioNodes,
  activeScenarioEdges,
  scenarios,
  whatsAppTemplates,
  saveScenarioSettings,
  t,
}: UseScenarioActivationImpactGuardParams) {
  const tTemplates = useTranslations("templates");
  const [pendingActivationImpact, setPendingActivationImpact] =
    useState<PendingScenarioActivationImpact | null>(null);
  const flowCheckIdRef = useRef(0);

  const checkTemplateFlows = useCallback(
    async (targets: ScenarioTemplateFlowTarget[], flowCheckId: number) => {
      let issues: ScenarioActivationImpactIssue[] = [];
      if (workspaceId) {
        try {
          const factsByFlowId = await fetchTemplateFlowFacts({
            workspaceId,
            flowIds: targets.flatMap(target =>
              collectTemplateFlowIds(target.components)
            ),
          });
          issues = buildTemplateFlowActivationIssues({
            targets,
            factsByFlowId,
            t,
            tTemplates: tTemplates as (
              key: string,
              values?: Record<string, string>
            ) => string,
          });
        } catch {
          // A failed check never blocks activation and never warns.
        }
      }
      setPendingActivationImpact(current =>
        current?.flowCheckId === flowCheckId
          ? {
              ...current,
              impact: {
                ...current.impact,
                issues: [...current.impact.issues, ...issues],
                pendingChecks: false,
              },
            }
          : current
      );
    },
    [t, tTemplates, workspaceId]
  );

  const confirmActivationImpact = useCallback(async () => {
    if (!pendingActivationImpact) return;
    const { params } = pendingActivationImpact;
    setPendingActivationImpact(null);
    const saved = await saveScenarioSettings(params);
    if (!saved || params.status !== "active") return;
    toast.success(t("scenarioActivatedToast"));
    // The setup checklist completes on an active scenario.
    if (workspaceId) void mutate(workspaceOnboardingKey(workspaceId));
  }, [pendingActivationImpact, saveScenarioSettings, t, workspaceId]);

  const handleActivationImpactOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setPendingActivationImpact(null);
    }
  }, []);

  const saveScenarioSettingsWithActivationGuard = useCallback(
    async (params: ScenarioSettingsSaveParams): Promise<boolean> => {
      const matchingScenario =
        params.status === "active"
          ? scenarios.find(scenario => scenario._id === params.scenarioId)
          : undefined;
      if (!matchingScenario) return saveScenarioSettings(params);

      const { impact, flowTargets } = planScenarioActivationImpact({
        scenario: matchingScenario,
        saveParams: params,
        workspaceId,
        activeScenario,
        activeScenarioName,
        activeScenarioStatus,
        activeScenarioNodes,
        activeScenarioEdges,
        scenarios,
        whatsAppTemplates,
        t,
      });
      flowCheckIdRef.current += 1;
      const flowCheckId = flowCheckIdRef.current;
      setPendingActivationImpact({ params, impact, flowCheckId });
      if (flowTargets.length > 0) {
        void checkTemplateFlows(flowTargets, flowCheckId);
      }
      return false;
    },
    [
      activeScenario,
      activeScenarioName,
      activeScenarioStatus,
      activeScenarioNodes,
      activeScenarioEdges,
      checkTemplateFlows,
      saveScenarioSettings,
      scenarios,
      t,
      whatsAppTemplates,
      workspaceId,
    ]
  );

  return {
    pendingActivationImpact,
    confirmActivationImpact,
    handleActivationImpactOpenChange,
    saveScenarioSettingsWithActivationGuard,
  };
}

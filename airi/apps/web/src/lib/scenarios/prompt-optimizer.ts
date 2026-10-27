import { withWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";
import { isWorkspaceAiPolicyError } from "@/lib/ai/workspace-ai-errors";
import { chatCompletionWithFallback, getHeavyTextModel } from "@/lib/ai";
import { Scenario } from "@/models/scenario";
import ScenarioEvalCase from "@/models/scenario-eval-case";
import ScenarioEvalOptimizerRun from "@/models/scenario-eval-optimizer-run";
import ScenarioEvalRun from "@/models/scenario-eval-run";
import {
  readStringOrEmpty,
  coerceBoolean,
} from "@icecore/shared/lib/value-utils";
import { listScenarioAnswerReferences } from "@icecore/scenario-contracts";
import { mutateScenarioGraphWithCas } from "@/lib/scenarios/scenario-graph-mutation";

type PromptField = "actionReplyInstruction" | "actionReplyText";
type GateDecision = "promote" | "reject";
type TriggeredBy = "manual" | "cron" | "api";

type PromptPromotionValue =
  | { applied: true; reason: null }
  | { applied: false; reason: string };

type EvalCaseRecord = {
  _id?: unknown;
  runId?: string | null;
  scenarioId?: string | null;
  axialCode?: string | null;
  severity?: string | null;
  failureType?: string | null;
  expectedOutcome?: string | null;
  actualOutcome?: string | null;
};

type ScenarioNodeRecord = {
  id?: unknown;
  type?: unknown;
  data?: unknown;
};

type OptimizablePrompt = {
  actionNodeId: string;
  promptField: PromptField;
  baselinePrompt: string;
};

type CandidatePromptResult = {
  candidatePrompt: string;
  rationale: string;
  /** "fallback" is the fixed policy template used when the generator failed. */
  source: "llm" | "fallback";
};

type CandidateScoring = {
  baselineScore: number;
  candidateScore: number;
  criticalRegressionRisk: boolean;
  /**
   * True only when the scorer returned both scores. Otherwise the scores are
   * placeholders (no improvement) and the candidate must never be promoted.
   */
  scored: boolean;
  reasons: string[];
};

export type PromotionGateResult = {
  decision: GateDecision;
  improvement: number;
  requiredImprovement: number;
  reasons: string[];
};

export type ScenarioPromptOptimizerInput = {
  workspaceId: string;
  evalRunId: string;
  scenarioId?: string | null;
  autoPromote?: boolean;
  runByUserId?: string | null;
  triggeredBy?: TriggeredBy;
  maxCases?: number;
};

export type ScenarioPromptOptimizerResult = {
  optimizerRunId: string;
  workspaceId: string;
  scenarioId: string;
  evalRunId: string;
  gateDecision: "promote" | "reject" | "none";
  promotionApplied: boolean;
  actionNodeId: string;
  promptField: PromptField;
  baselineScore: number;
  candidateScore: number;
  improvement: number;
  requiredImprovement: number;
  criticalRegressionRisk: boolean;
  reasons: string[];
  evaluatedCaseCount: number;
};

function normalizePositiveInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function safeParseJsonObject<T extends Record<string, unknown>>(
  raw: string
): T | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as T;
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      if (!parsed || typeof parsed !== "object") return null;
      return parsed as T;
    } catch {
      return null;
    }
  }
}

/**
 * Each optimizer call runs on the heavy tier (Sonnet) with adaptive thinking.
 * The weekly scenario-eval cron runs many workspaces in one 300 s function, so
 * this stays well below the reasoning tier's latency while leaving the Gemini
 * fallback its share of the deadline.
 */
const OPTIMIZER_AI_TIMEOUT_MS = 60_000;

/**
 * Worst case for the AI work of ONE optimizer run: two sequential calls. The
 * scenario-eval cron runs many workspaces in one 300 s function, so it starts
 * a run only while this much time is left in its budget.
 */
export const SCENARIO_PROMPT_OPTIMIZER_MAX_AI_MS = 2 * OPTIMIZER_AI_TIMEOUT_MS;

/**
 * SCENARIO_EVAL_OPTIMIZER_MODEL may still hold a Gemini id; the AI facade maps
 * it onto whichever provider actually serves the call.
 */
function getEnvModel(): string {
  return (
    readStringOrEmpty(process.env.SCENARIO_EVAL_OPTIMIZER_MODEL, {
      trim: true,
    }) || getHeavyTextModel()
  );
}

function mapAxialCounts(cases: EvalCaseRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of cases) {
    const key = readStringOrEmpty(item.axialCode, { trim: true }) || "other";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function buildCaseDigest(cases: EvalCaseRecord[]): string {
  if (cases.length === 0) return "No evaluation cases were available.";
  return cases
    .slice(0, 20)
    .map((item, index) => {
      const axial =
        readStringOrEmpty(item.axialCode, { trim: true }) || "other";
      const severity =
        readStringOrEmpty(item.severity, { trim: true }) || "medium";
      const expected =
        readStringOrEmpty(item.expectedOutcome, { trim: true }) || "n/a";
      const actual =
        readStringOrEmpty(item.actualOutcome, { trim: true }) || "n/a";
      return `${index + 1}. axial=${axial}; severity=${severity}; expected=${expected}; actual=${actual}`;
    })
    .join("\n");
}

function fallbackPromptCandidate(
  baselinePrompt: string,
  axialCounts: Record<string, number>
): CandidatePromptResult {
  const lines = [
    "Respond in one concise message with factual statements only.",
    "Confirm intent first, then give the next best action.",
    "If required data is missing, ask one direct clarifying question.",
  ];

  if ((axialCounts["channel_template_error"] || 0) > 0) {
    lines.push(
      "Keep channel formatting strict and avoid unsupported placeholders."
    );
  }
  if ((axialCounts["timing_window_error"] || 0) > 0) {
    lines.push(
      "Respect time-window constraints and do not imply actions outside configured windows."
    );
  }

  const base = readStringOrEmpty(baselinePrompt, { trim: true });
  const suffix = lines.map(line => `- ${line}`).join("\n");
  if (!base) {
    return {
      candidatePrompt: `Follow this policy:\n${suffix}`,
      rationale:
        "Fallback optimizer generated a stricter instruction template.",
      source: "fallback",
    };
  }
  return {
    candidatePrompt: `${base}\n\nOptimization policy:\n${suffix}`,
    rationale:
      "Fallback optimizer preserved baseline and appended guardrails from eval failures.",
    source: "fallback",
  };
}

function extractPromptFromActionNode(
  node: ScenarioNodeRecord,
  promptField: PromptField
): OptimizablePrompt | null {
  const nodeId = readStringOrEmpty(node?.id, { trim: true });
  const data =
    node && typeof node.data === "object" && node.data
      ? (node.data as Record<string, unknown>)
      : null;
  if (!nodeId || !data) return null;
  if (readStringOrEmpty(data.kind, { trim: true }) !== "action") return null;
  if (readStringOrEmpty(data.actionType, { trim: true }) !== "reply")
    return null;

  const baselinePrompt = readStringOrEmpty(data[promptField], { trim: true });
  if (!baselinePrompt) return null;

  return {
    actionNodeId: nodeId,
    promptField,
    baselinePrompt,
  };
}

function extractOptimizablePrompt(nodes: unknown): OptimizablePrompt | null {
  if (!Array.isArray(nodes)) return null;

  const typedNodes = nodes as ScenarioNodeRecord[];

  const promptFields: readonly PromptField[] = [
    "actionReplyInstruction",
    "actionReplyText",
  ];
  for (const promptField of promptFields) {
    for (const node of typedNodes) {
      const prompt = extractPromptFromActionNode(node, promptField);
      if (prompt) return prompt;
    }
  }

  return null;
}

function upsertNodePrompt(
  nodes: unknown,
  targetNodeId: string,
  promptField: PromptField,
  nextPrompt: string
): unknown[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.map(node => {
    if (!node || typeof node !== "object") return node;
    const nodeObj = node as Record<string, unknown>;
    if (readStringOrEmpty(nodeObj.id, { trim: true }) !== targetNodeId)
      return node;

    const data =
      nodeObj.data && typeof nodeObj.data === "object"
        ? { ...(nodeObj.data as Record<string, unknown>) }
        : {};
    data[promptField] = nextPrompt;
    return { ...nodeObj, data };
  });
}

function readNodePromptById(
  nodes: unknown,
  targetNodeId: string,
  promptField: PromptField
): string {
  if (!Array.isArray(nodes)) return "";
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const nodeObj = node as Record<string, unknown>;
    if (readStringOrEmpty(nodeObj.id, { trim: true }) !== targetNodeId)
      continue;
    const data =
      nodeObj.data && typeof nodeObj.data === "object"
        ? (nodeObj.data as Record<string, unknown>)
        : null;
    if (!data) return "";
    return readStringOrEmpty(data[promptField], { trim: true });
  }
  return "";
}

function resolveBaselineScore(metricsSnapshot: unknown): number {
  const snapshot =
    metricsSnapshot && typeof metricsSnapshot === "object"
      ? (metricsSnapshot as Record<string, unknown>)
      : null;

  const llm = snapshot?.llmQualityPassRate;
  if (typeof llm === "number" && Number.isFinite(llm)) return clampScore(llm);

  const trigger = snapshot?.triggerPathPassRate;
  if (typeof trigger === "number" && Number.isFinite(trigger)) {
    return clampScore(trigger);
  }

  return 0.5;
}

function requiredImprovementThreshold(): number {
  const fallback = 0.02;
  const parsed = Number.parseFloat(
    readStringOrEmpty(process.env.SCENARIO_EVAL_PROMOTION_MIN_IMPROVEMENT, {
      trim: true,
    }) || ""
  );
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0.005) return 0.005;
  if (parsed > 0.2) return 0.2;
  return parsed;
}

/**
 * Whether a rewrite names the same customer answers as the baseline. The
 * runtime fills answer tokens from what the customer submitted, so a rewrite
 * that drops, renames or adds one changes what the reply knows.
 */
export function keepsScenarioAnswerTokens(
  baselinePrompt: string,
  candidatePrompt: string
): boolean {
  const read = (prompt: string) =>
    listScenarioAnswerReferences(prompt)
      .map(reference => reference.token)
      .sort()
      .join("\n");
  return read(baselinePrompt) === read(candidatePrompt);
}

export function evaluatePromotionGate(input: {
  baselineScore: number;
  candidateScore: number;
  /** False when no evaluator scored the candidate; such a candidate never passes. */
  candidateScored: boolean;
  /**
   * The candidate is the fixed fallback template, not a rewrite of this
   * prompt. It is generic English text, so it is never promoted automatically.
   */
  candidateFromFallback: boolean;
  criticalRegressionRisk: boolean;
  sameAsBaseline: boolean;
  /** The rewrite names other customer answers than the baseline. */
  answerTokensChanged?: boolean;
  requiredImprovement?: number;
}): PromotionGateResult {
  const baselineScore = clampScore(input.baselineScore);
  const candidateScore = clampScore(input.candidateScore);
  const requiredImprovement =
    typeof input.requiredImprovement === "number"
      ? Math.max(0, input.requiredImprovement)
      : requiredImprovementThreshold();
  const improvement = candidateScore - baselineScore;
  const reasons: string[] = [];

  if (!input.candidateScored) {
    reasons.push("candidate_unscored");
  }
  if (input.candidateFromFallback) {
    reasons.push("candidate_from_fallback_template");
  }
  if (input.sameAsBaseline) {
    reasons.push("candidate_same_as_baseline");
  }
  if (input.criticalRegressionRisk) {
    reasons.push("critical_regression_risk");
  }
  if (input.answerTokensChanged) {
    reasons.push("candidate_changed_answer_tokens");
  }
  if (improvement < requiredImprovement) {
    reasons.push("improvement_below_threshold");
  }

  return {
    decision: reasons.length === 0 ? "promote" : "reject",
    improvement,
    requiredImprovement,
    reasons,
  };
}

async function generateCandidatePrompt(input: {
  baselinePrompt: string;
  scenarioName: string;
  caseDigest: string;
  axialCounts: Record<string, number>;
}): Promise<CandidatePromptResult> {
  const baselinePrompt = readStringOrEmpty(input.baselinePrompt, {
    trim: true,
  });
  const fallback = fallbackPromptCandidate(baselinePrompt, input.axialCounts);
  if (!baselinePrompt) return fallback;

  try {
    const result = await chatCompletionWithFallback({
      model: getEnvModel(),
      temperature: 0.2,
      responseFormat: { type: "json_object" },
      resilience: { timeoutMs: OPTIMIZER_AI_TIMEOUT_MS },
      messages: [
        {
          role: "system",
          content:
            "You optimize scenario reply prompts for enterprise support automation. Return strict JSON only.",
        },
        {
          role: "user",
          content: [
            "Improve the baseline prompt using failure evidence.",
            `Scenario: ${input.scenarioName || "Untitled scenario"}`,
            `Baseline prompt:\n${baselinePrompt}`,
            `Axial counts:\n${JSON.stringify(input.axialCounts)}`,
            `Eval samples:\n${input.caseDigest}`,
            'Return JSON: {"candidatePrompt":"string","rationale":"string"}.',
            "Constraints: keep intent, improve reliability, avoid policy-risk language, avoid markdown.",
            "Keep every {{...}} variable exactly as written: each is filled with customer data when the reply is sent.",
          ].join("\n\n"),
        },
      ],
    });

    const parsed = safeParseJsonObject<{
      candidatePrompt?: unknown;
      rationale?: unknown;
    }>(result.content);
    const candidatePrompt = readStringOrEmpty(parsed?.candidatePrompt, {
      trim: true,
    });
    const rationale = readStringOrEmpty(parsed?.rationale, { trim: true });
    if (!candidatePrompt) return fallback;

    return {
      candidatePrompt,
      rationale: rationale || "LLM optimizer proposed this candidate prompt.",
      source: "llm",
    };
  } catch (error) {
    if (isWorkspaceAiPolicyError(error)) throw error;
    return fallback;
  }
}

async function scoreBaselineVsCandidate(input: {
  baselinePrompt: string;
  candidatePrompt: string;
  baselineScoreFromMetrics: number;
  caseDigest: string;
}): Promise<CandidateScoring> {
  // Without a score the candidate gets no improvement and stays unscored, so
  // the promotion gate rejects it. Never invent an improvement here: an outage
  // would otherwise auto-promote a prompt nobody evaluated.
  const unscored = (reason: string): CandidateScoring => {
    const baselineScore = clampScore(input.baselineScoreFromMetrics);
    return {
      baselineScore,
      candidateScore: baselineScore,
      criticalRegressionRisk: false,
      scored: false,
      reasons: [reason],
    };
  };

  if (!readStringOrEmpty(input.candidatePrompt, { trim: true })) {
    return unscored("missing_candidate_prompt");
  }

  try {
    const result = await chatCompletionWithFallback({
      model: getEnvModel(),
      temperature: 0,
      responseFormat: { type: "json_object" },
      resilience: { timeoutMs: OPTIMIZER_AI_TIMEOUT_MS },
      messages: [
        {
          role: "system",
          content:
            "You are a strict evaluator. Compare baseline vs candidate prompt quality based on failure traces and return JSON only.",
        },
        {
          role: "user",
          content: [
            `Baseline prompt:\n${input.baselinePrompt}`,
            `Candidate prompt:\n${input.candidatePrompt}`,
            `Cases:\n${input.caseDigest}`,
            `Baseline pass estimate from deterministic metrics: ${clampScore(input.baselineScoreFromMetrics)}`,
            "Return JSON fields:",
            '{"baselineScore":0-1,"candidateScore":0-1,"criticalRegressionRisk":boolean,"reasons":["..."]}',
            "Rules: candidateScore should be <= baselineScore if candidate introduces ambiguity or policy risk.",
          ].join("\n\n"),
        },
      ],
    });

    const parsed = safeParseJsonObject<{
      baselineScore?: unknown;
      candidateScore?: unknown;
      criticalRegressionRisk?: unknown;
      reasons?: unknown;
    }>(result.content);

    // Both scores must come from the same evaluation on the requested 0..1
    // scale; a candidate score compared with the metrics baseline, or one on
    // another scale, is not a measured improvement. Clamping would turn a
    // scale mismatch (e.g. 0.5 vs 55) into a large gain. The risk flag must be
    // explicit: a missing or non-boolean flag must not read as "no risk".
    const isUnitScore = (value: unknown): value is number =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1;
    if (
      !isUnitScore(parsed?.baselineScore) ||
      !isUnitScore(parsed?.candidateScore) ||
      typeof parsed?.criticalRegressionRisk !== "boolean"
    ) {
      return unscored("llm_scorer_invalid_response");
    }
    const baselineScore = parsed.baselineScore;
    const candidateScore = parsed.candidateScore;
    const criticalRegressionRisk = parsed.criticalRegressionRisk;
    const reasons = Array.isArray(parsed?.reasons)
      ? (parsed?.reasons as unknown[])
          .map(item => readStringOrEmpty(item, { trim: true }))
          .filter(Boolean)
          .slice(0, 8)
      : [];

    return {
      baselineScore,
      candidateScore,
      criticalRegressionRisk,
      scored: true,
      reasons,
    };
  } catch (error) {
    if (isWorkspaceAiPolicyError(error)) throw error;
    return unscored("llm_scorer_fallback");
  }
}

export async function applyScenarioPromptPromotionWithCas(input: {
  workspaceId: string;
  scenarioId: string;
  actionNodeId: string;
  promptField: PromptField;
  baselinePrompt: string;
  candidatePrompt: string;
  updatedBy: string | null;
}): Promise<PromptPromotionValue> {
  const result = await mutateScenarioGraphWithCas<PromptPromotionValue>({
    workspaceId: input.workspaceId,
    scenarioId: input.scenarioId,
    updatedBy: input.updatedBy || "scenario-eval-optimizer",
    project: snapshot => {
      const currentPrompt = readNodePromptById(
        snapshot.nodes,
        input.actionNodeId,
        input.promptField
      );
      if (!currentPrompt) {
        return {
          changed: false,
          value: {
            applied: false,
            reason: "optimizable_prompt_not_found",
          },
        };
      }
      if (
        readStringOrEmpty(currentPrompt, { trim: true }) !==
        readStringOrEmpty(input.baselinePrompt, { trim: true })
      ) {
        return {
          changed: false,
          value: {
            applied: false,
            reason: "baseline_changed_since_eval",
          },
        };
      }

      return {
        changed: true,
        nodes: upsertNodePrompt(
          snapshot.nodes,
          input.actionNodeId,
          input.promptField,
          input.candidatePrompt
        ),
        edges: snapshot.edges,
        value: { applied: true, reason: null },
      };
    },
  });

  if (result.status === "not_found") {
    return { applied: false, reason: "scenario_not_found" };
  }
  if (result.status === "conflict") {
    return { applied: false, reason: "scenario_revision_conflict" };
  }
  return result.value;
}

function inferScenarioName(
  scenarioDoc: Record<string, unknown> | null
): string {
  if (!scenarioDoc) return "";
  return readStringOrEmpty(scenarioDoc.name, { trim: true }) || "Scenario";
}

export async function runScenarioPromptOptimizer(
  input: ScenarioPromptOptimizerInput
): Promise<ScenarioPromptOptimizerResult> {
  return withWorkspaceTextAiAction(
    {
      workspaceId: input.workspaceId,
      actionId: `prompt-optimizer:${input.evalRunId}`,
    },
    () => runScenarioPromptOptimizerImpl(input)
  );
}

async function runScenarioPromptOptimizerImpl(
  input: ScenarioPromptOptimizerInput
): Promise<ScenarioPromptOptimizerResult> {
  const workspaceId = readStringOrEmpty(input.workspaceId, { trim: true });
  const evalRunId = readStringOrEmpty(input.evalRunId, { trim: true });
  const explicitScenarioId = readStringOrEmpty(input.scenarioId, {
    trim: true,
  });
  const runByUserId =
    readStringOrEmpty(input.runByUserId, { trim: true }) || null;
  const triggeredBy: TriggeredBy = input.triggeredBy || "api";
  const autoPromote = coerceBoolean(input.autoPromote) ?? true;
  const maxCases = normalizePositiveInt(input.maxCases, 60, 10, 200);

  if (!workspaceId) {
    throw new Error("workspaceId is required");
  }
  if (!evalRunId) {
    throw new Error("evalRunId is required");
  }

  const existing = await ScenarioEvalOptimizerRun.findOne({
    workspaceId,
    evalRunId,
  })
    .sort({ createdAt: -1 })
    .lean<Record<string, unknown> | null>();

  if (
    existing &&
    readStringOrEmpty(existing.status, { trim: true }) === "completed"
  ) {
    return {
      optimizerRunId: String(existing._id || ""),
      workspaceId,
      scenarioId: readStringOrEmpty(existing.scenarioId, { trim: true }),
      evalRunId,
      gateDecision: (() => {
        const raw = readStringOrEmpty(existing.gateDecision, { trim: true });
        if (raw === "promote" || raw === "reject" || raw === "none") return raw;
        return "none";
      })(),
      promotionApplied: Boolean(existing.promotionApplied),
      actionNodeId: readStringOrEmpty(existing.actionNodeId, { trim: true }),
      promptField:
        readStringOrEmpty(existing.promptField, { trim: true }) ===
        "actionReplyText"
          ? "actionReplyText"
          : "actionReplyInstruction",
      baselineScore:
        typeof existing.baselineScore === "number" ? existing.baselineScore : 0,
      candidateScore:
        typeof existing.candidateScore === "number"
          ? existing.candidateScore
          : 0,
      improvement:
        typeof existing.improvement === "number" ? existing.improvement : 0,
      requiredImprovement:
        typeof existing.requiredImprovement === "number"
          ? existing.requiredImprovement
          : requiredImprovementThreshold(),
      criticalRegressionRisk: Boolean(existing.criticalRegressionRisk),
      reasons: Array.isArray(existing.gateReasons)
        ? (existing.gateReasons as unknown[])
            .map(item => readStringOrEmpty(item, { trim: true }))
            .filter(Boolean)
        : [],
      evaluatedCaseCount:
        typeof existing.evaluatedCaseCount === "number"
          ? existing.evaluatedCaseCount
          : 0,
    };
  }

  const optimizerDoc = await ScenarioEvalOptimizerRun.findOneAndUpdate(
    { workspaceId, evalRunId },
    {
      $setOnInsert: {
        workspaceId,
        scenarioId: explicitScenarioId || "pending",
        evalRunId,
        startedAt: new Date(),
      },
      $set: {
        status: "running",
        triggeredBy,
        runByUserId,
        errorMessage: null,
      },
    },
    { upsert: true, new: true }
  );

  const optimizerRunId = String(optimizerDoc._id);

  try {
    const evalRun = await ScenarioEvalRun.findOne({
      _id: evalRunId,
      workspaceId,
    }).lean<Record<string, unknown> | null>();

    if (!evalRun) {
      throw new Error("Evaluation run not found");
    }
    if (readStringOrEmpty(evalRun.status, { trim: true }) !== "completed") {
      throw new Error("Evaluation run must be completed before optimization");
    }

    const resolvedScenarioId =
      explicitScenarioId ||
      readStringOrEmpty(evalRun.scenarioId, { trim: true });
    if (!resolvedScenarioId) {
      throw new Error("scenarioId is required for prompt optimization");
    }

    const scenarioDoc = await Scenario.findOne({
      workspaceId,
      _id: resolvedScenarioId,
    })
      .select("_id name nodes")
      .lean<Record<string, unknown> | null>();
    if (!scenarioDoc) {
      throw new Error("Scenario not found");
    }

    const promptInfo = extractOptimizablePrompt(scenarioDoc.nodes);
    if (!promptInfo) {
      throw new Error("No optimizable reply prompt found in scenario");
    }

    const evalCases = await ScenarioEvalCase.find({
      workspaceId,
      scenarioId: resolvedScenarioId,
      runId: evalRunId,
    })
      .sort({ sampledAt: -1 })
      .limit(maxCases)
      .lean<EvalCaseRecord[]>();

    const caseDigest = buildCaseDigest(evalCases);
    const axialCounts = mapAxialCounts(evalCases);
    const baselineScoreFromMetrics = resolveBaselineScore(
      evalRun.metricsSnapshot
    );

    const candidate = await generateCandidatePrompt({
      baselinePrompt: promptInfo.baselinePrompt,
      scenarioName: inferScenarioName(scenarioDoc),
      caseDigest,
      axialCounts,
    });

    const scoring = await scoreBaselineVsCandidate({
      baselinePrompt: promptInfo.baselinePrompt,
      candidatePrompt: candidate.candidatePrompt,
      baselineScoreFromMetrics,
      caseDigest,
    });

    const gate = evaluatePromotionGate({
      baselineScore: scoring.baselineScore,
      candidateScore: scoring.candidateScore,
      candidateScored: scoring.scored,
      candidateFromFallback: candidate.source === "fallback",
      criticalRegressionRisk: scoring.criticalRegressionRisk,
      sameAsBaseline:
        readStringOrEmpty(candidate.candidatePrompt, { trim: true }) ===
        readStringOrEmpty(promptInfo.baselinePrompt, { trim: true }),
      answerTokensChanged: !keepsScenarioAnswerTokens(
        promptInfo.baselinePrompt,
        candidate.candidatePrompt
      ),
    });

    const gateReasons = [...scoring.reasons, ...gate.reasons];
    let promotionApplied = false;
    if (gate.decision === "promote" && autoPromote) {
      const promotion = await applyScenarioPromptPromotionWithCas({
        workspaceId,
        scenarioId: resolvedScenarioId,
        actionNodeId: promptInfo.actionNodeId,
        promptField: promptInfo.promptField,
        baselinePrompt: promptInfo.baselinePrompt,
        candidatePrompt: candidate.candidatePrompt,
        updatedBy: runByUserId,
      });
      promotionApplied = promotion.applied;
      if (!promotion.applied && promotion.reason) {
        gateReasons.push(promotion.reason);
      }
    }

    await ScenarioEvalOptimizerRun.updateOne(
      { _id: optimizerRunId },
      {
        $set: {
          scenarioId: resolvedScenarioId,
          status: "completed",
          gateDecision: gate.decision,
          promotionApplied,
          actionNodeId: promptInfo.actionNodeId,
          promptField: promptInfo.promptField,
          baselinePrompt: promptInfo.baselinePrompt,
          candidatePrompt: candidate.candidatePrompt,
          candidateRationale: candidate.rationale,
          baselineScore: scoring.baselineScore,
          candidateScore: scoring.candidateScore,
          improvement: gate.improvement,
          requiredImprovement: gate.requiredImprovement,
          criticalRegressionRisk: scoring.criticalRegressionRisk,
          gateReasons: gateReasons.slice(0, 12),
          evaluatedCaseCount: evalCases.length,
          completedAt: new Date(),
          errorMessage: null,
        },
      }
    );

    return {
      optimizerRunId,
      workspaceId,
      scenarioId: resolvedScenarioId,
      evalRunId,
      gateDecision: gate.decision,
      promotionApplied,
      actionNodeId: promptInfo.actionNodeId,
      promptField: promptInfo.promptField,
      baselineScore: scoring.baselineScore,
      candidateScore: scoring.candidateScore,
      improvement: gate.improvement,
      requiredImprovement: gate.requiredImprovement,
      criticalRegressionRisk: scoring.criticalRegressionRisk,
      reasons: gateReasons.slice(0, 12),
      evaluatedCaseCount: evalCases.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ScenarioEvalOptimizerRun.updateOne(
      { _id: optimizerRunId },
      {
        $set: {
          status: "failed",
          gateDecision: "none",
          promotionApplied: false,
          completedAt: new Date(),
          errorMessage: message.slice(0, 1000),
        },
      }
    );
    throw error;
  }
}

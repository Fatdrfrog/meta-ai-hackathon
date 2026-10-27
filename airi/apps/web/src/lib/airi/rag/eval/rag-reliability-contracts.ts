import {
  scoreCase,
  type RagasCaseInput,
  type RagasCaseScores,
} from "./ragas-metrics";

export type ReliabilityExpectedOutcome =
  | "answer"
  | "abstain"
  | "clarify"
  | "handoff";

export type RagReliabilityCaseInput = RagasCaseInput & {
  locale?: string;
  tags?: readonly string[];
  workspaceId?: string;
  retrievalPath?: "snippet" | "kb" | "blended" | "none";
  citations?: readonly string[];
  sourceWorkspaceIds?: Record<string, string>;
  expected: {
    outcome: ReliabilityExpectedOutcome;
    retrievalPath?: "snippet" | "kb" | "blended" | "none";
    minScores?: Partial<Omit<RagasCaseScores, "id">>;
    requiredAnswerTerms?: readonly string[];
    forbiddenAnswerTerms?: readonly string[];
    requiredCitationSourceIds?: readonly string[];
    requireCitations?: boolean;
    requireWorkspaceIsolation?: boolean;
  };
};

export type RagReliabilityCaseReport = {
  id: string;
  scores: RagasCaseScores;
  failures: string[];
};

function normalizeText(text: string): string {
  return (text || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsTerm(text: string, term: string): boolean {
  const normalizedText = normalizeText(text);
  const normalizedTerm = normalizeText(term);
  return Boolean(normalizedTerm && normalizedText.includes(normalizedTerm));
}

function formatScore(value: number): string {
  return value.toFixed(4);
}

function assertMinScore(
  failures: string[],
  scores: RagasCaseScores,
  metric: keyof Omit<RagasCaseScores, "id">,
  floor: number | undefined
): void {
  if (typeof floor !== "number") return;
  if (scores[metric] < floor) {
    failures.push(
      `${metric}=${formatScore(scores[metric])} below floor ${formatScore(floor)}`
    );
  }
}

function validateOutcome(
  failures: string[],
  input: RagReliabilityCaseInput
): void {
  const generated = input.generatedAnswer.trim();
  const citations = input.citations || [];

  if (input.expected.outcome === "answer" && generated.length === 0) {
    failures.push("expected an answer but generatedAnswer is empty");
  }

  if (input.expected.outcome === "abstain") {
    if (generated.length > 0) {
      failures.push("expected abstention but generatedAnswer is non-empty");
    }
    if (citations.length > 0) {
      failures.push("expected abstention without citations");
    }
  }

  if (
    input.expected.retrievalPath &&
    input.retrievalPath !== input.expected.retrievalPath
  ) {
    failures.push(
      `retrievalPath=${input.retrievalPath || "missing"} expected ${input.expected.retrievalPath}`
    );
  }
}

function validateAnswerTerms(
  failures: string[],
  input: RagReliabilityCaseInput
): void {
  for (const term of input.expected.requiredAnswerTerms || []) {
    if (!containsTerm(input.generatedAnswer, term)) {
      failures.push(`generatedAnswer missing required term: ${term}`);
    }
  }

  for (const term of input.expected.forbiddenAnswerTerms || []) {
    if (containsTerm(input.generatedAnswer, term)) {
      failures.push(`generatedAnswer contains forbidden term: ${term}`);
    }
  }
}

function validateCitations(
  failures: string[],
  input: RagReliabilityCaseInput
): void {
  const citations = input.citations || [];
  const retrieved = new Set(input.retrievedSourceIds);

  if (input.expected.requireCitations && citations.length === 0) {
    failures.push("expected citations but none were attached");
  }

  for (const sourceId of input.expected.requiredCitationSourceIds || []) {
    if (!citations.includes(sourceId)) {
      failures.push(`missing required citation source: ${sourceId}`);
    }
  }

  for (const sourceId of citations) {
    if (!retrieved.has(sourceId)) {
      failures.push(`citation source was not retrieved: ${sourceId}`);
    }
  }
}

function validateWorkspaceIsolation(
  failures: string[],
  input: RagReliabilityCaseInput
): void {
  if (!input.expected.requireWorkspaceIsolation) return;
  if (!input.workspaceId) {
    failures.push("workspace isolation required but workspaceId is missing");
    return;
  }

  const sourceWorkspaceIds = input.sourceWorkspaceIds || {};
  const idsToCheck = Array.from(
    new Set([...input.retrievedSourceIds, ...(input.citations || [])])
  );

  for (const sourceId of idsToCheck) {
    const sourceWorkspaceId = sourceWorkspaceIds[sourceId];
    if (!sourceWorkspaceId) {
      failures.push(`missing workspace owner for source: ${sourceId}`);
    } else if (sourceWorkspaceId !== input.workspaceId) {
      failures.push(
        `source ${sourceId} belongs to ${sourceWorkspaceId}, expected ${input.workspaceId}`
      );
    }
  }
}

export function evaluateReliabilityCase(
  input: RagReliabilityCaseInput
): RagReliabilityCaseReport {
  const scores = scoreCase(input);
  const failures: string[] = [];
  const minScores = input.expected.minScores || {};

  validateOutcome(failures, input);
  validateAnswerTerms(failures, input);
  validateCitations(failures, input);
  validateWorkspaceIsolation(failures, input);

  assertMinScore(
    failures,
    scores,
    "contextPrecisionAtK",
    minScores.contextPrecisionAtK
  );
  assertMinScore(
    failures,
    scores,
    "contextRecallAtK",
    minScores.contextRecallAtK
  );
  assertMinScore(
    failures,
    scores,
    "answerRelevancy",
    minScores.answerRelevancy
  );
  assertMinScore(failures, scores, "faithfulness", minScores.faithfulness);

  return {
    id: input.id,
    scores,
    failures,
  };
}

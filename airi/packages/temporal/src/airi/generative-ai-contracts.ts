import type { AiriConversationDeferredCommand } from "./contracts";

export const AIRI_SCENARIO_GENERATIVE_AI_WORKFLOW_CONTRACT_VERSION = 1;
export const AIRI_SCENARIO_GENERATIVE_AI_BEGIN_ACTIVITY =
  "airi.scenarioGenerativeAI.begin";
export const AIRI_SCENARIO_GENERATIVE_AI_IMPORT_SOURCE_ACTIVITY =
  "airi.scenarioGenerativeAI.importSource";
export const AIRI_SCENARIO_GENERATIVE_AI_ACCEPT_VIDEO_ACTIVITY =
  "airi.scenarioGenerativeAI.acceptVideo";
export const AIRI_SCENARIO_GENERATIVE_AI_ACCEPT_IMAGE_ACTIVITY =
  "airi.scenarioGenerativeAI.acceptImage";
export const AIRI_SCENARIO_GENERATIVE_AI_START_VIDEO_ACTIVITY =
  "airi.scenarioGenerativeAI.startVideo";
export const AIRI_SCENARIO_GENERATIVE_AI_REPORT_RESULT_ACTIVITY =
  "airi.scenarioGenerativeAI.reportResult";
export const AIRI_SCENARIO_GENERATIVE_AI_VIDEO_COMPLETION_SIGNAL =
  "airi.scenarioGenerativeAI.videoCompletion";
export const AIRI_SCENARIO_GENERATIVE_AI_RESULT_PROCESSED_SIGNAL =
  "generative_ai_result_processed";

const MAX_ID_LENGTH = 128;
const MAX_WORKFLOW_ID_LENGTH = 512;
const MAX_RESULT_CODE_LENGTH = 100;
const REVISION_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const RESULT_CODE_PATTERN = /^[a-z0-9_]+$/;
const PRE_ASSET_FAILURE_CODES = new Set([
  "execution_unavailable",
  "source_import_failed",
  "generation_preparation_failed",
]);

const WORKFLOW_INPUT_FIELDS = new Set([
  "version",
  "kind",
  "workflowId",
  "workspaceId",
  "conversationId",
  "executionId",
  "scenarioId",
  "scenarioRevisionFingerprint",
  "actionNodeId",
  "reporting",
]);
const WORKFLOW_COMMAND_FIELDS = new Set(
  [...WORKFLOW_INPUT_FIELDS].filter((field) => field !== "reporting"),
);
const RESULT_EVENT_FIELDS = new Set([
  "kind",
  "workspaceId",
  "conversationId",
  "messageId",
  "executionId",
  "scenarioWorkflowId",
  "videoWorkflowId",
  "assetId",
  "terminal",
]);
const RESULT_TERMINAL_FIELDS = new Set(["state", "code", "attemptToken"]);
const PROCESSED_ACK_FIELDS = new Set(["contractVersion", "executionId"]);
const REPORTING_CARRYOVER_FIELDS = new Set(["resultEvent", "reportAttempt"]);

export type AiriScenarioGenerativeAIWorkflowInput =
  AiriConversationDeferredCommand & {
    reporting?: {
      resultEvent: AiriScenarioGenerativeAIResultEvent;
      reportAttempt: number;
    };
  };

export type AiriScenarioGenerativeAITerminal = {
  state: "complete" | "failed" | "unsafe" | "timeout";
  code: string;
  attemptToken: string | null;
};

export type AiriScenarioGenerativeAIResultEvent = {
  kind: "generative_ai_result";
  workspaceId: string;
  conversationId: string;
  messageId: string;
  executionId: string;
  scenarioWorkflowId: string;
  videoWorkflowId: string | null;
  assetId: string | null;
  terminal: AiriScenarioGenerativeAITerminal;
};

export type AiriScenarioGenerativeAIProcessedAck = {
  contractVersion: 1;
  executionId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactFields(
  value: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
  owner: string,
): void {
  const fields = Object.keys(value);
  if (
    fields.length !== allowedFields.size ||
    fields.some((field) => !allowedFields.has(field))
  ) {
    throw new Error(`${owner} fields are not allowlisted`);
  }
}

function exactString(
  value: unknown,
  field: string,
  maxLength = MAX_ID_LENGTH,
): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.length > maxLength
  ) {
    throw new Error(
      `${field} must be non-empty, trimmed, and at most ${maxLength} characters`,
    );
  }
  return value;
}

function nullableExactString(
  value: unknown,
  field: string,
  maxLength = MAX_ID_LENGTH,
): string | null {
  return value === null ? null : exactString(value, field, maxLength);
}

export function normalizeAiriScenarioGenerativeAIWorkflowInput(
  value: unknown,
): AiriScenarioGenerativeAIWorkflowInput {
  if (!isRecord(value)) {
    throw new Error("Scenario Generative AI workflow input must be an object");
  }
  const allowedFields =
    value.reporting === undefined
      ? WORKFLOW_COMMAND_FIELDS
      : WORKFLOW_INPUT_FIELDS;
  assertExactFields(value, allowedFields, "Workflow input");
  if (value.version !== 1) {
    throw new Error("Workflow input version must be 1");
  }
  if (value.kind !== "start_generative_ai_scenario") {
    throw new Error("Workflow input kind is invalid");
  }
  const scenarioRevisionFingerprint = exactString(
    value.scenarioRevisionFingerprint,
    "scenarioRevisionFingerprint",
    64,
  );
  if (!REVISION_FINGERPRINT_PATTERN.test(scenarioRevisionFingerprint)) {
    throw new Error(
      "scenarioRevisionFingerprint must be a 64-character lowercase hex digest",
    );
  }
  const command: AiriConversationDeferredCommand = {
    version: 1,
    kind: "start_generative_ai_scenario",
    workflowId: exactString(
      value.workflowId,
      "workflowId",
      MAX_WORKFLOW_ID_LENGTH,
    ),
    workspaceId: exactString(value.workspaceId, "workspaceId"),
    conversationId: exactString(value.conversationId, "conversationId"),
    executionId: exactString(value.executionId, "executionId"),
    scenarioId: exactString(value.scenarioId, "scenarioId"),
    scenarioRevisionFingerprint,
    actionNodeId: exactString(value.actionNodeId, "actionNodeId"),
  };
  if (value.reporting === undefined) return command;
  if (!isRecord(value.reporting)) {
    throw new Error("Workflow input reporting carryover must be an object");
  }
  assertExactFields(
    value.reporting,
    REPORTING_CARRYOVER_FIELDS,
    "Reporting carryover",
  );
  if (
    !Number.isSafeInteger(value.reporting.reportAttempt) ||
    (value.reporting.reportAttempt as number) < 0 ||
    (value.reporting.reportAttempt as number) > 1_000_000
  ) {
    throw new Error(
      "Reporting carryover reportAttempt must be a bounded non-negative integer",
    );
  }
  const resultEvent = normalizeAiriScenarioGenerativeAIResultEvent(
    value.reporting.resultEvent,
  );
  if (
    resultEvent.workspaceId !== command.workspaceId ||
    resultEvent.conversationId !== command.conversationId ||
    resultEvent.executionId !== command.executionId ||
    resultEvent.scenarioWorkflowId !== command.workflowId
  ) {
    throw new Error(
      "Reporting carryover result event does not match the workflow identity",
    );
  }
  return {
    ...command,
    reporting: {
      resultEvent,
      reportAttempt: value.reporting.reportAttempt as number,
    },
  };
}

function normalizeTerminal(value: unknown): AiriScenarioGenerativeAITerminal {
  if (!isRecord(value)) {
    throw new Error("Generative AI result terminal must be an object");
  }
  assertExactFields(value, RESULT_TERMINAL_FIELDS, "Result terminal");
  if (
    value.state !== "complete" &&
    value.state !== "failed" &&
    value.state !== "unsafe" &&
    value.state !== "timeout"
  ) {
    throw new Error("Result terminal state is invalid");
  }
  const code = exactString(value.code, "terminal.code", MAX_RESULT_CODE_LENGTH);
  if (!RESULT_CODE_PATTERN.test(code)) {
    throw new Error("terminal.code must be a lowercase safe token");
  }
  return {
    state: value.state,
    code,
    attemptToken: nullableExactString(
      value.attemptToken,
      "terminal.attemptToken",
    ),
  };
}

export function normalizeAiriScenarioGenerativeAIResultEvent(
  value: unknown,
): AiriScenarioGenerativeAIResultEvent {
  if (!isRecord(value)) {
    throw new Error("Generative AI result event must be an object");
  }
  assertExactFields(value, RESULT_EVENT_FIELDS, "Result event");
  if (value.kind !== "generative_ai_result") {
    throw new Error("Result event kind is invalid");
  }
  const executionId = exactString(value.executionId, "executionId");
  const messageId = exactString(value.messageId, "messageId");
  if (messageId !== executionId) {
    throw new Error("Result event messageId must equal executionId");
  }
  const videoWorkflowId = nullableExactString(
    value.videoWorkflowId,
    "videoWorkflowId",
    MAX_WORKFLOW_ID_LENGTH,
  );
  const assetId = nullableExactString(value.assetId, "assetId");
  const terminal = normalizeTerminal(value.terminal);
  const identityPresence = [
    videoWorkflowId !== null,
    assetId !== null,
    terminal.attemptToken !== null,
  ];
  if (identityPresence.some(Boolean) && !identityPresence.every(Boolean)) {
    throw new Error(
      "Result event video identity must be either fully present or fully null",
    );
  }
  if (
    !identityPresence.some(Boolean) &&
    (terminal.state !== "failed" || !PRE_ASSET_FAILURE_CODES.has(terminal.code))
  ) {
    throw new Error(
      "A null video identity is allowed only for an allowlisted pre-asset failure",
    );
  }
  return {
    kind: "generative_ai_result",
    workspaceId: exactString(value.workspaceId, "workspaceId"),
    conversationId: exactString(value.conversationId, "conversationId"),
    messageId,
    executionId,
    scenarioWorkflowId: exactString(
      value.scenarioWorkflowId,
      "scenarioWorkflowId",
      MAX_WORKFLOW_ID_LENGTH,
    ),
    videoWorkflowId,
    assetId,
    terminal,
  };
}

export function normalizeAiriScenarioGenerativeAIProcessedAck(
  value: unknown,
): AiriScenarioGenerativeAIProcessedAck {
  if (!isRecord(value)) {
    throw new Error(
      "Scenario Generative AI processed acknowledgment must be an object",
    );
  }
  assertExactFields(value, PROCESSED_ACK_FIELDS, "Processed acknowledgment");
  if (value.contractVersion !== 1) {
    throw new Error("Processed acknowledgment contractVersion must be 1");
  }
  return {
    contractVersion: 1,
    executionId: exactString(value.executionId, "executionId"),
  };
}

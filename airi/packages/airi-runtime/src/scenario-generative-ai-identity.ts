import { createHash } from "node:crypto";

import {
  isGenerativeAIActionMode,
  type GenerativeAIActionMode,
  type GenerativeAIResultDeliveryKind,
} from "@icecore/scenario-contracts";

export type { GenerativeAIResultDeliveryKind };

/**
 * UUIDv5(DNS, "airi.scenario-generative-execution.v1"). This fixed namespace
 * keeps execution IDs stable without introducing a runtime configuration value.
 */
export const GENERATIVE_AI_EXECUTION_NAMESPACE_UUID =
  "516efdaa-b5c2-5f26-9d4d-0f7a5be5a7a6";

export type GenerativeAIExecutionIdentityInput = {
  workspaceId: string;
  conversationId: string;
  scenarioId: string;
  actionNodeId: string;
  inputMessageId: string;
  mode: GenerativeAIActionMode;
};

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

/**
 * JSON-compatible graph snapshot. Array order is intentionally preserved: the
 * activated-graph producer owns semantic node and edge ordering.
 */
export type CanonicalScenarioGraph = {
  version: number;
  nodes: readonly CanonicalJsonValue[];
  edges: readonly CanonicalJsonValue[];
};

function assertDurableGenerativeAIExecutionId(executionId: string): void {
  if (
    typeof executionId !== "string" ||
    executionId.length === 0 ||
    executionId.trim() !== executionId
  ) {
    throw new TypeError(
      "Generative AI execution ID must be a non-empty, trimmed string",
    );
  }
}

export function buildGenerativeAIScenarioWorkflowId(
  executionId: string,
): string {
  assertDurableGenerativeAIExecutionId(executionId);
  return `scenario-generation:${executionId}`;
}

export function buildGenerativeAIResultDeliveryIdentity(
  executionId: string,
  kind: GenerativeAIResultDeliveryKind,
): string {
  assertDurableGenerativeAIExecutionId(executionId);
  return `generative-result:${executionId}:${
    kind === "success_video"
      ? "video"
      : kind === "success_image"
        ? "image"
        : "failure"
  }`;
}

export function buildGenerativeAIResultDeliveryClaimToken(
  executionId: string,
  kind: GenerativeAIResultDeliveryKind,
): string {
  assertDurableGenerativeAIExecutionId(executionId);
  return `generative-result-claim:${executionId}:${kind}`;
}

function uuidBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new TypeError("UUID namespace must contain 32 hexadecimal digits");
  }
  return Buffer.from(hex, "hex");
}

function encodeLengthPrefixedUtf8(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 0xffffffff) {
    throw new RangeError("Identity field is too large to encode");
  }

  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function assertGenerativeAIIdentityInput(
  input: GenerativeAIExecutionIdentityInput,
): void {
  const fields = [
    input.workspaceId,
    input.conversationId,
    input.scenarioId,
    input.actionNodeId,
    input.inputMessageId,
  ];
  if (fields.some((value) => typeof value !== "string")) {
    throw new TypeError(
      "Generative AI execution identity fields must be strings",
    );
  }
  if (!isGenerativeAIActionMode(input.mode)) {
    throw new TypeError("Generative AI execution mode is unsupported");
  }
}

export function buildGenerativeAIExecutionId(
  input: GenerativeAIExecutionIdentityInput,
): string {
  assertGenerativeAIIdentityInput(input);
  const fields = [
    input.workspaceId,
    input.conversationId,
    input.scenarioId,
    input.actionNodeId,
    input.inputMessageId,
    input.mode,
  ];
  const name = Buffer.concat(fields.map(encodeLengthPrefixedUtf8));
  const bytes = createHash("sha1")
    .update(uuidBytes(GENERATIVE_AI_EXECUTION_NAMESPACE_UUID))
    .update(name)
    .digest()
    .subarray(0, 16);

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

function canonicalizeJson(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        "Scenario revision graph cannot contain non-finite numbers",
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(
      "Scenario revision graph must contain JSON-compatible values",
    );
  }
  if (ancestors.has(value)) {
    throw new TypeError(
      "Scenario revision graph cannot contain circular values",
    );
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new TypeError(
            "Scenario revision graph cannot contain sparse arrays",
          );
        }
        items.push(canonicalizeJson(value[index], ancestors));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        "Scenario revision graph must contain plain JSON objects",
      );
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalizeJson(record[key], ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function buildScenarioRevisionFingerprint(
  graph: CanonicalScenarioGraph,
): string {
  if (
    !graph ||
    typeof graph !== "object" ||
    !Number.isFinite(graph.version) ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges)
  ) {
    throw new TypeError(
      "Scenario revision graph must include version, nodes, and edges",
    );
  }

  const snapshot = canonicalizeJson(
    { version: graph.version, nodes: graph.nodes, edges: graph.edges },
    new WeakSet(),
  );
  return createHash("sha256").update(snapshot, "utf8").digest("hex");
}

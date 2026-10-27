import { hasExactKeys, isPlainRecord } from "../lib/value-utils";

export type RequestsRealtimeSubscriptionClientFrameV1 = {
  type: "subscribe" | "unsubscribe";
  schemaVersion: 1;
  workspaceId: string;
  grantId: string;
  channels: string[];
};

export type RequestsRealtimeSubscriptionServerFrameV1 = {
  type: "subscribed" | "unsubscribed";
  schemaVersion: 1;
  connectionId: string;
  subscriptionEpoch: number;
  grantId: string;
  channels: string[];
};

export type RequestsRealtimeReadyServerFrameV1 = {
  type: "ready";
  schemaVersion: 1;
  connectionId: string;
  expiresAt: string;
  gatewayInstanceId: string;
};

export type RequestsRealtimePresenceStateV1 =
  | "hidden"
  | "warming"
  | "visible-warm"
  | "inactive";

export type RequestsRealtimePresenceClientFrameV1 = {
  type: "requests_presence";
  schemaVersion: 1;
  connectionId: string;
  subscriptionEpoch: number;
  grantId: string;
  presenceSequence: number;
  state: RequestsRealtimePresenceStateV1;
};

export type RequestsRealtimePresenceServerFrameV1 = {
  type: "requests_presence_ack";
  schemaVersion: 1;
  connectionId: string;
  subscriptionEpoch: number;
  grantId: string;
  presenceSequence: number;
  state: RequestsRealtimePresenceStateV1;
};

export type RequestsRealtimeCommitAckV1 =
  | {
      schemaVersion: 1;
      kind: "preview";
      latencyTraceId: string;
      outcome: "displayed" | "unread-only" | "covered-no-visible-change";
      receiptToCommitMs: number;
    }
  | {
      schemaVersion: 1;
      kind: "canonical";
      canonicalTraceId: string;
      targetProjectionGeneration: string;
      appliedProjectionGeneration: string;
      appliedState: "row" | "removed";
      receiptToCommitMs: number;
    };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/;
const HEX_128_PATTERN = /^[0-9a-f]{32}$/;
const SOURCE_WATERMARK_PATTERN = /^[0-9a-f]{16}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REQUESTS_CONTROL_FRAME_MAX_BYTES = 4 * 1024;
const textEncoder = new TextEncoder();

function fail(contract: string): never {
  throw new Error(`Invalid ${contract}`);
}

function parseRecord(
  value: unknown,
  keys: readonly string[],
  contract: string,
): Record<string, unknown> {
  if (!isPlainRecord(value)) fail(contract);
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => !keys.includes(key))
  ) {
    fail(contract);
  }
  return value;
}

function parseString(value: unknown, contract: string): string {
  if (typeof value !== "string" || value.length === 0) fail(contract);
  return value;
}

function parseExactString(
  value: unknown,
  pattern: RegExp,
  contract: string,
): string {
  const parsed = parseString(value, contract);
  if (!pattern.test(parsed)) fail(contract);
  return parsed;
}

function parseIsoInstant(value: unknown, contract: string): string {
  const parsed = parseExactString(value, ISO_INSTANT_PATTERN, contract);
  const date = new Date(parsed);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== parsed)
    fail(contract);
  return parsed;
}

function parseSafePositiveInteger(value: unknown, contract: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(contract);
  return value as number;
}

function parseFiniteInteger(
  value: unknown,
  min: number,
  max: number,
  contract: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    fail(contract);
  }
  return value as number;
}

function bytesOf(value: unknown, contract: string): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return fail(contract);
  }
  if (typeof serialized !== "string") fail(contract);
  return textEncoder.encode(serialized).byteLength;
}

function assertBoundedSerialized(
  value: unknown,
  maxBytes: number,
  contract: string,
): void {
  if (bytesOf(value, contract) > maxBytes) fail(contract);
}

function parseRequestChannels(
  value: unknown,
  workspaceId: string,
  contract: string,
): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 51)
    fail(contract);
  const workspaceChannel = `workspace:${workspaceId}`;
  const channels = value.map((entry) => parseString(entry, contract));
  if (channels[0] !== workspaceChannel) fail(contract);
  const conversationIds = channels.slice(1).map((channel) => {
    const prefix = `conversation:${workspaceId}:`;
    if (!channel.startsWith(prefix)) fail(contract);
    return parseExactString(
      channel.slice(prefix.length),
      OBJECT_ID_PATTERN,
      contract,
    );
  });
  if (
    conversationIds.some(
      (entry, index) => index > 0 && conversationIds[index - 1]! >= entry,
    )
  ) {
    fail(contract);
  }
  return channels;
}

export function parseProjectionGeneration(value: unknown): string {
  return parseExactString(
    value,
    POSITIVE_DECIMAL_PATTERN,
    "projection generation",
  );
}

export function parseSourceWatermark(value: unknown): string {
  return parseExactString(value, SOURCE_WATERMARK_PATTERN, "source watermark");
}

export function compareSourceWatermarks(left: string, right: string): number {
  return parseSourceWatermark(left) < parseSourceWatermark(right)
    ? -1
    : parseSourceWatermark(left) > parseSourceWatermark(right)
      ? 1
      : 0;
}

export function compareProjectionGenerations(
  left: string,
  right: string,
): number {
  const parsedLeft = parseProjectionGeneration(left);
  const parsedRight = parseProjectionGeneration(right);
  return parsedLeft.length === parsedRight.length
    ? parsedLeft < parsedRight
      ? -1
      : parsedLeft > parsedRight
        ? 1
        : 0
    : parsedLeft.length - parsedRight.length;
}

export function parseRequestsRealtimeSubscriptionClientFrameV1(
  value: unknown,
): RequestsRealtimeSubscriptionClientFrameV1 {
  const frame = parseRecord(
    value,
    ["type", "schemaVersion", "workspaceId", "grantId", "channels"],
    "Requests subscription frame",
  );
  assertBoundedSerialized(
    value,
    REQUESTS_CONTROL_FRAME_MAX_BYTES,
    "Requests subscription frame",
  );
  if (frame.type !== "subscribe" && frame.type !== "unsubscribe")
    fail("Requests subscription frame");
  if (frame.schemaVersion !== 1) fail("Requests subscription frame");
  const workspaceId = parseExactString(
    frame.workspaceId,
    UUID_PATTERN,
    "Requests subscription workspace ID",
  );
  return {
    type: frame.type,
    schemaVersion: 1,
    workspaceId,
    grantId: parseExactString(
      frame.grantId,
      HEX_128_PATTERN,
      "Requests subscription grant ID",
    ),
    channels: parseRequestChannels(
      frame.channels,
      workspaceId,
      "Requests subscription channels",
    ),
  };
}

export function parseRequestsRealtimeSubscriptionServerFrameV1(
  value: unknown,
): RequestsRealtimeSubscriptionServerFrameV1 {
  const frame = parseRecord(
    value,
    [
      "type",
      "schemaVersion",
      "connectionId",
      "subscriptionEpoch",
      "grantId",
      "channels",
    ],
    "Requests subscription acknowledgement",
  );
  assertBoundedSerialized(
    value,
    REQUESTS_CONTROL_FRAME_MAX_BYTES,
    "Requests subscription acknowledgement",
  );
  if (
    (frame.type !== "subscribed" && frame.type !== "unsubscribed") ||
    frame.schemaVersion !== 1
  )
    fail("Requests subscription acknowledgement");
  const channels = frame.channels;
  if (!Array.isArray(channels) || channels.length < 1)
    fail("Requests subscription acknowledgement");
  const workspaceChannel = parseString(
    channels[0],
    "Requests subscription acknowledgement",
  );
  const workspacePrefix = "workspace:";
  if (!workspaceChannel.startsWith(workspacePrefix))
    fail("Requests subscription acknowledgement");
  const workspaceId = parseExactString(
    workspaceChannel.slice(workspacePrefix.length),
    UUID_PATTERN,
    "Requests subscription workspace ID",
  );
  return {
    type: frame.type,
    schemaVersion: 1,
    connectionId: parseString(frame.connectionId, "Requests connection ID"),
    subscriptionEpoch: parseSafePositiveInteger(
      frame.subscriptionEpoch,
      "Requests subscription epoch",
    ),
    grantId: parseExactString(
      frame.grantId,
      HEX_128_PATTERN,
      "Requests subscription grant ID",
    ),
    channels: parseRequestChannels(
      channels,
      workspaceId,
      "Requests subscription channels",
    ),
  };
}

export function parseRequestsRealtimeReadyServerFrameV1(
  value: unknown,
): RequestsRealtimeReadyServerFrameV1 {
  const frame = parseRecord(
    value,
    ["type", "schemaVersion", "connectionId", "expiresAt", "gatewayInstanceId"],
    "Requests ready frame",
  );
  const descriptors = Object.getOwnPropertyDescriptors(frame);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        !("value" in descriptor) ||
        typeof descriptor.get === "function" ||
        typeof descriptor.set === "function",
    )
  ) {
    fail("Requests ready frame");
  }
  assertBoundedSerialized(
    value,
    REQUESTS_CONTROL_FRAME_MAX_BYTES,
    "Requests ready frame",
  );
  if (frame.type !== "ready" || frame.schemaVersion !== 1)
    fail("Requests ready frame");
  return {
    type: "ready",
    schemaVersion: 1,
    connectionId: parseExactString(
      frame.connectionId,
      UUID_PATTERN,
      "Requests ready connection ID",
    ),
    expiresAt: parseIsoInstant(frame.expiresAt, "Requests ready expiry"),
    gatewayInstanceId: parseExactString(
      frame.gatewayInstanceId,
      HEX_128_PATTERN,
      "Requests gateway instance ID",
    ),
  };
}

function parsePresenceFrame(
  value: unknown,
  expectedType: "requests_presence" | "requests_presence_ack",
):
  | RequestsRealtimePresenceClientFrameV1
  | RequestsRealtimePresenceServerFrameV1 {
  const frame = parseRecord(
    value,
    [
      "type",
      "schemaVersion",
      "connectionId",
      "subscriptionEpoch",
      "grantId",
      "presenceSequence",
      "state",
    ],
    "Requests presence frame",
  );
  assertBoundedSerialized(
    value,
    REQUESTS_CONTROL_FRAME_MAX_BYTES,
    "Requests presence frame",
  );
  if (
    frame.type !== expectedType ||
    frame.schemaVersion !== 1 ||
    !(["hidden", "warming", "visible-warm", "inactive"] as const).includes(
      frame.state as never,
    )
  ) {
    fail("Requests presence frame");
  }
  return {
    type: expectedType,
    schemaVersion: 1,
    connectionId: parseString(
      frame.connectionId,
      "Requests presence connection ID",
    ),
    subscriptionEpoch: parseSafePositiveInteger(
      frame.subscriptionEpoch,
      "Requests presence subscription epoch",
    ),
    grantId: parseExactString(
      frame.grantId,
      HEX_128_PATTERN,
      "Requests presence grant ID",
    ),
    presenceSequence: parseSafePositiveInteger(
      frame.presenceSequence,
      "Requests presence sequence",
    ),
    state: frame.state as RequestsRealtimePresenceStateV1,
  } as
    | RequestsRealtimePresenceClientFrameV1
    | RequestsRealtimePresenceServerFrameV1;
}

export function parseRequestsRealtimePresenceClientFrameV1(
  value: unknown,
): RequestsRealtimePresenceClientFrameV1 {
  return parsePresenceFrame(
    value,
    "requests_presence",
  ) as RequestsRealtimePresenceClientFrameV1;
}

export function parseRequestsRealtimePresenceServerFrameV1(
  value: unknown,
): RequestsRealtimePresenceServerFrameV1 {
  return parsePresenceFrame(
    value,
    "requests_presence_ack",
  ) as RequestsRealtimePresenceServerFrameV1;
}

export function parseRequestsRealtimeCommitAckV1(
  value: unknown,
): RequestsRealtimeCommitAckV1 {
  if (!isPlainRecord(value)) fail("Requests commit acknowledgement");
  const previewKeys = [
    "schemaVersion",
    "kind",
    "latencyTraceId",
    "outcome",
    "receiptToCommitMs",
  ];
  const canonicalKeys = [
    "schemaVersion",
    "kind",
    "canonicalTraceId",
    "targetProjectionGeneration",
    "appliedProjectionGeneration",
    "appliedState",
    "receiptToCommitMs",
  ];
  if (!hasExactKeys(value, previewKeys) && !hasExactKeys(value, canonicalKeys))
    fail("Requests commit acknowledgement");
  assertBoundedSerialized(
    value,
    REQUESTS_CONTROL_FRAME_MAX_BYTES,
    "Requests commit acknowledgement",
  );
  if (hasExactKeys(value, previewKeys)) {
    const frame = parseRecord(
      value,
      [
        "schemaVersion",
        "kind",
        "latencyTraceId",
        "outcome",
        "receiptToCommitMs",
      ],
      "Requests preview commit acknowledgement",
    );
    if (
      frame.schemaVersion !== 1 ||
      frame.kind !== "preview" ||
      !(
        ["displayed", "unread-only", "covered-no-visible-change"] as const
      ).includes(frame.outcome as never)
    )
      fail("Requests preview commit acknowledgement");
    return {
      schemaVersion: 1,
      kind: "preview",
      latencyTraceId: parseExactString(
        frame.latencyTraceId,
        HEX_128_PATTERN,
        "Requests preview trace ID",
      ),
      outcome: frame.outcome as Extract<
        RequestsRealtimeCommitAckV1,
        { kind: "preview" }
      >["outcome"],
      receiptToCommitMs: parseFiniteInteger(
        frame.receiptToCommitMs,
        0,
        30_000,
        "Requests preview commit time",
      ),
    };
  }
  const frame = parseRecord(
    value,
    [
      "schemaVersion",
      "kind",
      "canonicalTraceId",
      "targetProjectionGeneration",
      "appliedProjectionGeneration",
      "appliedState",
      "receiptToCommitMs",
    ],
    "Requests canonical commit acknowledgement",
  );
  if (
    frame.schemaVersion !== 1 ||
    frame.kind !== "canonical" ||
    (frame.appliedState !== "row" && frame.appliedState !== "removed")
  )
    fail("Requests canonical commit acknowledgement");
  const targetProjectionGeneration = parseProjectionGeneration(
    frame.targetProjectionGeneration,
  );
  const appliedProjectionGeneration = parseProjectionGeneration(
    frame.appliedProjectionGeneration,
  );
  if (
    compareProjectionGenerations(
      appliedProjectionGeneration,
      targetProjectionGeneration,
    ) < 0
  )
    fail("Requests canonical commit acknowledgement");
  return {
    schemaVersion: 1,
    kind: "canonical",
    canonicalTraceId: parseExactString(
      frame.canonicalTraceId,
      HEX_128_PATTERN,
      "Requests canonical trace ID",
    ),
    targetProjectionGeneration,
    appliedProjectionGeneration,
    appliedState: frame.appliedState,
    receiptToCommitMs: parseFiniteInteger(
      frame.receiptToCommitMs,
      0,
      30_000,
      "Requests canonical commit time",
    ),
  };
}

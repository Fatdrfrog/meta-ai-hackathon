import type { WhatsAppFlowConfig } from "./scenario-channel-configs";

const MAX_SCREENS = 20;
/** Meta's maximum number of directed screen connections in routing_model. */
export const WHATSAPP_FLOW_ENDPOINT_MAX_ROUTING_EDGES = 10;
const MAX_BRANCHES = 10;
const MAX_TOPOLOGY_BYTES = 16_384;
const RESERVED_RECORD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type WhatsAppFlowEndpointTopology = {
  version: 1;
  initialScreenId: string;
  screens: readonly string[];
  routing: Readonly<Record<string, readonly string[]>>;
  branches: Readonly<
    Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>
  >;
};

/** Shared by the real data endpoint and the draft conversation preview. */
export function resolveWhatsAppFlowNextScreenId(
  currentScreen: string,
  formData: Record<string, unknown>,
  topology: Pick<WhatsAppFlowEndpointTopology, "screens" | "routing"> &
    Partial<Pick<WhatsAppFlowEndpointTopology, "branches">>
): string {
  const allowed = topology.routing[currentScreen] || [];
  if (allowed.length === 0) {
    return topology.screens[topology.screens.length - 1] || currentScreen;
  }
  if (allowed.length === 1) return allowed[0]!;
  const branches = topology.branches?.[currentScreen];
  if (branches) {
    for (const [fieldId, optionMap] of Object.entries(branches)) {
      const value = formData[fieldId];
      if (value === undefined || value === null) continue;
      const target = optionMap[String(value)];
      if (target && allowed.includes(target)) return target;
    }
  }
  const ordered = topology.screens.filter(id => allowed.includes(id));
  return ordered[0] || allowed[0]!;
}

export type WhatsAppFlowEndpointTopologyErrorCode =
  | "invalid_topology"
  | "routing_edge_limit_exceeded";

export class WhatsAppFlowEndpointTopologyError extends TypeError {
  readonly code: WhatsAppFlowEndpointTopologyErrorCode;

  constructor(code: WhatsAppFlowEndpointTopologyErrorCode, message: string) {
    super(`Invalid WhatsApp Flow endpoint topology: ${message}`);
    this.name = "WhatsAppFlowEndpointTopologyError";
    this.code = code;
  }
}

function fail(
  message: string,
  code: WhatsAppFlowEndpointTopologyErrorCode = "invalid_topology",
): never {
  throw new WhatsAppFlowEndpointTopologyError(code, message);
}

function asNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fail(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function asSafeRecordKey(value: unknown, path: string): string {
  const key = asNonEmptyString(value, path);
  if (RESERVED_RECORD_KEYS.has(key)) {
    return fail(`${path} contains a reserved key`);
  }
  return key;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function createRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function assertMaxOwnProperties(
  record: Record<string, unknown>,
  max: number,
  path: string,
): void {
  let count = 0;
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    count += 1;
    if (count > max) return fail(`${path} member limit exceeded`);
  }
}

function assertOnlyTopologyMembers(raw: Record<string, unknown>): void {
  const allowed = new Set([
    "version",
    "initialScreenId",
    "screens",
    "routing",
    "branches",
  ]);
  for (const key in raw) {
    if (Object.hasOwn(raw, key) && !allowed.has(key)) {
      return fail(`unknown topology member ${key}`);
    }
  }
}

function assertRawTopologyLimits(raw: Record<string, unknown>): void {
  let bytes = 0;
  const countString = (value: unknown, path: string): void => {
    if (typeof value !== "string") return fail(`${path} must be a string`);
    bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength + 1;
    if (bytes > MAX_TOPOLOGY_BYTES) return fail("raw byte limit exceeded");
  };

  countString(raw.initialScreenId, "initialScreenId");
  if (!Array.isArray(raw.screens)) return fail("screens must be an array");
  if (raw.screens.length > MAX_SCREENS) return fail("screen limit exceeded");
  for (let index = 0; index < raw.screens.length; index += 1) {
    countString(raw.screens[index], `screens[${index}]`);
  }

  const routing = asRecord(raw.routing, "routing");
  assertMaxOwnProperties(routing, MAX_SCREENS, "routing");
  for (const sourceId in routing) {
    if (!Object.hasOwn(routing, sourceId)) continue;
    countString(sourceId, `routing.${sourceId}`);
    const targets = routing[sourceId];
    if (!Array.isArray(targets))
      return fail(`routing.${sourceId} must be an array`);
    if (targets.length > WHATSAPP_FLOW_ENDPOINT_MAX_ROUTING_EDGES) {
      return fail("routing edge limit exceeded", "routing_edge_limit_exceeded");
    }
    for (let index = 0; index < targets.length; index += 1) {
      countString(targets[index], `routing.${sourceId}[${index}]`);
    }
  }

  const branches = asRecord(raw.branches ?? {}, "branches");
  assertMaxOwnProperties(branches, MAX_SCREENS, "branches");
  let branchCount = 0;
  for (const screenId in branches) {
    if (!Object.hasOwn(branches, screenId)) continue;
    countString(screenId, `branches.${screenId}`);
    const fields = asRecord(branches[screenId], `branches.${screenId}`);
    assertMaxOwnProperties(fields, MAX_BRANCHES, `branches.${screenId}`);
    for (const fieldId in fields) {
      if (!Object.hasOwn(fields, fieldId)) continue;
      countString(fieldId, `branches.${screenId}.${fieldId}`);
      const options = asRecord(
        fields[fieldId],
        `branches.${screenId}.${fieldId}`,
      );
      for (const optionId in options) {
        if (!Object.hasOwn(options, optionId)) continue;
        countString(optionId, `branches.${screenId}.${fieldId}.${optionId}`);
        countString(
          options[optionId],
          `branches.${screenId}.${fieldId}.${optionId}`,
        );
        branchCount += 1;
        if (branchCount > MAX_BRANCHES) return fail("branch limit exceeded");
      }
    }
  }
}

function assertTopologySize(topology: WhatsAppFlowEndpointTopology): void {
  const bytes = new TextEncoder().encode(JSON.stringify(topology)).byteLength;
  if (bytes > MAX_TOPOLOGY_BYTES) {
    fail("byte limit exceeded");
  }
}

function normalizeTopology(input: {
  initialScreenId: unknown;
  screens: unknown;
  routing: unknown;
  branches: unknown;
}): WhatsAppFlowEndpointTopology {
  if (!Array.isArray(input.screens) || input.screens.length < 2) {
    return fail("at least two screens are required");
  }
  if (input.screens.length > MAX_SCREENS) {
    return fail("screen limit exceeded");
  }

  const screens = input.screens.map((value, index) =>
    asSafeRecordKey(value, `screens[${index}]`),
  );
  const screenIds = new Set(screens);
  if (screenIds.size !== screens.length) {
    return fail("duplicate screen id");
  }
  const initialScreenId = asSafeRecordKey(
    input.initialScreenId,
    "initialScreenId",
  );
  if (initialScreenId !== screens[0]) {
    return fail("initialScreenId must be the first screen");
  }

  const rawRouting = asRecord(input.routing, "routing");
  assertMaxOwnProperties(rawRouting, MAX_SCREENS, "routing");
  const routing = createRecord<readonly string[]>();
  let edgeCount = 0;
  for (const screenId of screens) {
    if (!Object.hasOwn(rawRouting, screenId)) {
      return fail(`routing.${screenId} must be an array`);
    }
    const targets = rawRouting[screenId];
    if (!Array.isArray(targets)) {
      return fail(`routing.${screenId} must be an array`);
    }
    if (targets.length > WHATSAPP_FLOW_ENDPOINT_MAX_ROUTING_EDGES) {
      return fail("routing edge limit exceeded", "routing_edge_limit_exceeded");
    }
    const normalizedTargets = targets.map((target, index) => {
      const id = asNonEmptyString(target, `routing.${screenId}[${index}]`);
      if (!screenIds.has(id)) return fail(`unknown target ${id}`);
      if (id === screenId) return fail(`self target ${id} is not allowed`);
      return id;
    });
    if (new Set(normalizedTargets).size !== normalizedTargets.length) {
      return fail(`duplicate target in routing.${screenId}`);
    }
    routing[screenId] = normalizedTargets;
    edgeCount += normalizedTargets.length;
  }
  for (const screenId in rawRouting) {
    if (Object.hasOwn(rawRouting, screenId) && !screenIds.has(screenId)) {
      return fail("routing contains an unknown source");
    }
  }
  if (edgeCount > WHATSAPP_FLOW_ENDPOINT_MAX_ROUTING_EDGES) {
    return fail("routing edge limit exceeded", "routing_edge_limit_exceeded");
  }

  const rawBranches = asRecord(input.branches, "branches");
  assertMaxOwnProperties(rawBranches, MAX_SCREENS, "branches");
  const branches = createRecord<Record<string, Record<string, string>>>();
  let branchCount = 0;
  for (const screenId in rawBranches) {
    if (!Object.hasOwn(rawBranches, screenId)) continue;
    if (!screenIds.has(screenId))
      return fail(`unknown branch source ${screenId}`);
    const rawFields = rawBranches[screenId];
    const fields = asRecord(rawFields, `branches.${screenId}`);
    assertMaxOwnProperties(fields, MAX_BRANCHES, `branches.${screenId}`);
    const normalizedFields = createRecord<Record<string, string>>();
    for (const fieldId in fields) {
      if (!Object.hasOwn(fields, fieldId)) continue;
      asSafeRecordKey(fieldId, "branch field id");
      const rawOptions = fields[fieldId];
      const options = asRecord(rawOptions, `branches.${screenId}.${fieldId}`);
      const normalizedOptions = createRecord<string>();
      for (const optionId in options) {
        if (!Object.hasOwn(options, optionId)) continue;
        asSafeRecordKey(optionId, "branch option id");
        const rawTarget = options[optionId];
        const target = asNonEmptyString(
          rawTarget,
          `branches.${screenId}.${fieldId}.${optionId}`,
        );
        if (!routing[screenId]?.includes(target)) {
          return fail(
            `branch target ${target} is not allowed from ${screenId}`,
          );
        }
        branchCount += 1;
        if (branchCount > MAX_BRANCHES) {
          return fail("branch limit exceeded");
        }
        normalizedOptions[optionId] = target;
      }
      if (Object.keys(normalizedOptions).length > 0) {
        normalizedFields[fieldId] = normalizedOptions;
      }
    }
    if (Object.keys(normalizedFields).length > 0) {
      branches[screenId] = normalizedFields;
    }
  }
  const topology: WhatsAppFlowEndpointTopology = {
    version: 1,
    initialScreenId,
    screens,
    routing,
    branches,
  };
  assertTopologySize(topology);
  return topology;
}

/**
 * The sole routing owner for endpoint-enabled WhatsApp Flows. Callers must
 * provide the already sanitized persisted config so no consumer silently
 * applies a competing normalization policy.
 */
export function buildWhatsAppFlowEndpointTopology(
  config: WhatsAppFlowConfig,
): WhatsAppFlowEndpointTopology {
  if (config.flowNavigationMode !== "data_endpoint") {
    return fail("data_endpoint mode is required");
  }
  const screens = config.screens.map((screen, index) =>
    asSafeRecordKey(screen.id, `screens[${index}]`),
  );
  const routing = createRecord<unknown>();
  for (let index = 0; index < screens.length; index += 1) {
    const screenId = screens[index]!;
    const explicit = config.screenRoutes?.[screenId];
    if (index === screens.length - 1 && explicit && explicit.length > 0) {
      return fail("terminal screen cannot have explicit routes");
    }
    routing[screenId] =
      index === screens.length - 1
        ? []
        : explicit && explicit.length > 0
          ? explicit
          : [screens[index + 1]!];
  }
  return normalizeTopology({
    initialScreenId: screens[0],
    screens,
    routing,
    branches: config.flowBranchRules ?? {},
  });
}

/** Parse and strictly validate the untrusted decrypted airi1 topology. */
export function parseWhatsAppFlowEndpointTopology(
  value: unknown,
): WhatsAppFlowEndpointTopology {
  const raw = asRecord(value, "topology");
  assertOnlyTopologyMembers(raw);
  if (raw.version !== 1) return fail("version must be 1");
  assertRawTopologyLimits(raw);
  return normalizeTopology({
    initialScreenId: raw.initialScreenId,
    screens: raw.screens,
    routing: raw.routing,
    branches: raw.branches ?? {},
  });
}

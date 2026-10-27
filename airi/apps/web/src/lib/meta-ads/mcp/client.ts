import "server-only";

import { createHash } from "node:crypto";
import { serializeCanonicalJson } from "@icecore/shared/lib/canonical-json";
import {
  Client,
  InsufficientScopeError,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type AuthProvider,
  type CacheMode,
  type Tool,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";
import { classifyMetaAdsMcpToolSideEffect } from "./tool-classifier";

export const META_ADS_MCP_URL = "https://mcp.facebook.com/ads";

const CONNECT_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 20_000;
const WRITE_TIMEOUT_MS = 60_000;
const TEARDOWN_STEP_TIMEOUT_MS = 2_000;
const MAX_TOOLS = 10_000;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const CATALOG_SERIALIZATION_LIMITS = {
  maxBytes: MAX_CATALOG_BYTES,
  maxMembers: 500_000,
};
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_TITLE_LENGTH = 500;
// Meta's audience tools currently exceed 26k characters. Keep their complete
// contract while retaining both this per-tool cap and the 8 MiB catalog cap.
const MAX_DESCRIPTION_LENGTH = 64_000;
const MAX_PUBLIC_META_VALUE_LENGTH = 2_000;
const MAX_SCOPE_COUNT = 32;
const MAX_SCOPE_LENGTH = 200;
const READ_RETRY_DELAY_MS = 500;
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const PUBLIC_META_STRING_KEYS = new Set([
  "openai/outputTemplate",
  "openai/toolInvocation/invoked",
  "openai/toolInvocation/invoking",
  "ui/resourceUri",
]);

export type MetaAdsMcpClientErrorCode =
  | "provider_unauthorized"
  | "insufficient_scope"
  | "request_timeout"
  | "request_cancelled"
  | "connection_closed"
  | "protocol_error"
  | "invalid_catalog"
  | "transport_error";

export type MetaAdsMcpProtocolMetadata = {
  era: "legacy" | "modern";
  protocolVersion: string;
  serverName?: string;
  serverVersion?: string;
  capabilities: Record<string, unknown>;
};

export type MetaAdsMcpTool = {
  name: string;
  title?: string;
  description?: string;
  icons?: unknown;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  definitionSha256: string;
};

export type MetaAdsMcpCatalog = {
  tools: MetaAdsMcpTool[];
  catalogSha256: string;
  canonicalSizeBytes: number;
  protocol: MetaAdsMcpProtocolMetadata;
  unsupportedTaskToolCount?: number;
};

export class MetaAdsMcpClientError extends Error {
  readonly code: MetaAdsMcpClientErrorCode;
  readonly status?: number;
  readonly rpcCode?: number;
  readonly requiredScopes?: string[];

  constructor(
    code: MetaAdsMcpClientErrorCode,
    message: string,
    options?: {
      status?: number;
      rpcCode?: number;
      requiredScopes?: string[];
    }
  ) {
    super(message);
    this.name = "MetaAdsMcpClientError";
    this.code = code;
    this.status = options?.status;
    this.rpcCode = options?.rpcCode;
    this.requiredScopes = options?.requiredScopes;
  }
}

export class MetaAdsMcpToolResultError extends Error {
  readonly toolName: string;
  readonly result: unknown;

  constructor(toolName: string, message: string, result: unknown) {
    super(message);
    this.name = "MetaAdsMcpToolResultError";
    this.toolName = toolName;
    this.result = result;
  }
}

export type MetaAdsMcpSession = {
  closed: boolean;
};

type PrivateSessionState = {
  authProvider: AuthProvider;
  client: Client;
  transport: StreamableHTTPClientTransport;
  protocol?: MetaAdsMcpProtocolMetadata;
  toolsByName: Map<string, { exact: Tool; definitionSha256: string }>;
  closePromise?: Promise<void>;
};

const jsonSchemaValidator = new AjvJsonSchemaValidator();
const privateSessionState = new WeakMap<
  MetaAdsMcpSession,
  PrivateSessionState
>();

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(
    serializeCanonicalJson(value, CATALOG_SERIALIZATION_LIMITS)
  ) as T;
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function publicMeta(value: unknown): Record<string, unknown> | undefined {
  const record = asNullableRecord(value);
  if (!record) return undefined;
  const projection: Record<string, unknown> = {};
  for (const key of PUBLIC_META_STRING_KEYS) {
    const bounded = boundedString(record[key], MAX_PUBLIC_META_VALUE_LENGTH);
    if (bounded) projection[key] = bounded;
  }
  return Object.keys(projection).length > 0 ? projection : undefined;
}

function publicIcons(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  const icons = value.slice(0, 8).flatMap(item => {
    const icon = asNullableRecord(item);
    if (!icon) return [];
    const src = boundedString(icon.src, 2_000);
    if (!src) return [];
    return [
      {
        src,
        ...(boundedString(icon.mimeType, 200)
          ? { mimeType: boundedString(icon.mimeType, 200) }
          : {}),
        ...(boundedString(icon.sizes, 200)
          ? { sizes: boundedString(icon.sizes, 200) }
          : {}),
        ...(icon.theme === "light" || icon.theme === "dark"
          ? { theme: icon.theme }
          : {}),
      },
    ];
  });
  return icons.length > 0 ? icons : undefined;
}

function getPrivateState(session: MetaAdsMcpSession): PrivateSessionState {
  const state = privateSessionState.get(session);
  if (!state) {
    throw new MetaAdsMcpClientError(
      "connection_closed",
      "Meta Ads MCP session is unavailable"
    );
  }
  return state;
}

function ensureOpen(session: MetaAdsMcpSession): PrivateSessionState {
  if (session.closed) {
    throw new MetaAdsMcpClientError(
      "connection_closed",
      "Meta Ads MCP session is closed"
    );
  }
  return getPrivateState(session);
}

function requiredScopes(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const scopes = Array.from(
    new Set(
      value
        .split(/\s+/u)
        .map(scope => scope.trim().slice(0, MAX_SCOPE_LENGTH))
        .filter(Boolean)
    )
  ).slice(0, MAX_SCOPE_COUNT);
  return scopes.length > 0 ? scopes : undefined;
}

function mapClientError(
  error: unknown,
  operationSignal?: AbortSignal
): MetaAdsMcpClientError {
  if (operationSignal?.aborted) {
    const timedOut =
      operationSignal.reason instanceof DOMException &&
      operationSignal.reason.name === "TimeoutError";
    return new MetaAdsMcpClientError(
      timedOut ? "request_timeout" : "request_cancelled",
      timedOut
        ? "Meta Ads MCP request timed out"
        : "Meta Ads MCP request was cancelled"
    );
  }
  if (error instanceof MetaAdsMcpClientError) return error;
  if (UnauthorizedError.isInstance(error)) {
    return new MetaAdsMcpClientError(
      "provider_unauthorized",
      "Meta Ads MCP rejected the access token",
      { status: 401 }
    );
  }
  if (InsufficientScopeError.isInstance(error)) {
    return new MetaAdsMcpClientError(
      "insufficient_scope",
      "Meta Ads MCP requires additional permissions",
      {
        status: 403,
        requiredScopes: requiredScopes(error.requiredScope),
      }
    );
  }
  if (SdkHttpError.isInstance(error)) {
    if (error.status === 401) {
      return new MetaAdsMcpClientError(
        "provider_unauthorized",
        "Meta Ads MCP rejected the access token",
        { status: 401 }
      );
    }
    if (error.status === 403) {
      return new MetaAdsMcpClientError(
        "insufficient_scope",
        "Meta Ads MCP denied the required permission",
        { status: 403 }
      );
    }
    return new MetaAdsMcpClientError(
      "transport_error",
      "Meta Ads MCP returned an HTTP transport error",
      { status: error.status }
    );
  }
  if (ProtocolError.isInstance(error)) {
    return new MetaAdsMcpClientError(
      "protocol_error",
      "Meta Ads MCP returned a protocol error",
      { rpcCode: error.code }
    );
  }
  if (SdkError.isInstance(error)) {
    if (error.code === SdkErrorCode.RequestTimeout) {
      return new MetaAdsMcpClientError(
        "request_timeout",
        "Meta Ads MCP request timed out"
      );
    }
    if (
      error.code === SdkErrorCode.ConnectionClosed ||
      error.code === SdkErrorCode.NotConnected
    ) {
      return new MetaAdsMcpClientError(
        "connection_closed",
        "Meta Ads MCP connection closed"
      );
    }
    return new MetaAdsMcpClientError(
      "transport_error",
      "Meta Ads MCP client operation failed"
    );
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new MetaAdsMcpClientError(
      "request_timeout",
      "Meta Ads MCP request timed out"
    );
  }
  return new MetaAdsMcpClientError(
    "transport_error",
    "Meta Ads MCP transport operation failed"
  );
}

function deadlineSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw mapClientError(signal.reason, signal);
}

function hasKnownNetworkCause(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; depth < 4; depth += 1) {
    const record = asNullableRecord(cause);
    if (!record) return false;
    if (
      typeof record.code === "string" &&
      RETRYABLE_NETWORK_CODES.has(record.code)
    )
      return true;
    cause = record.cause;
  }
  return false;
}

function canRetryRead(
  error: MetaAdsMcpClientError,
  original: unknown
): boolean {
  if (error.code === "connection_closed") return true;
  if (error.code !== "transport_error") return false;
  return error.status === undefined
    ? hasKnownNetworkCause(original)
    : RETRYABLE_HTTP_STATUSES.has(error.status);
}

async function waitForReadRetry(signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, READ_RETRY_DELAY_MS);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(mapClientError(signal.reason, signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function settleTeardownStep(
  operation: () => Promise<unknown>
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settledOperation = Promise.resolve()
    .then(operation)
    .then(
      () => undefined,
      () => undefined
    );
  const deadline = new Promise<void>(resolve => {
    timeout = setTimeout(resolve, TEARDOWN_STEP_TIMEOUT_MS);
  });

  try {
    await Promise.race([settledOperation, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function invalidCatalog(message: string): MetaAdsMcpClientError {
  return new MetaAdsMcpClientError("invalid_catalog", message);
}

function projectTool(exact: Tool): MetaAdsMcpTool {
  const name = exact.name.trim();
  if (!name || name !== exact.name || name.length > MAX_TOOL_NAME_LENGTH) {
    throw invalidCatalog("Meta Ads MCP returned an invalid tool name");
  }
  const inputSchema = asNullableRecord(exact.inputSchema);
  if (!inputSchema || inputSchema.type !== "object") {
    throw invalidCatalog(
      `Meta Ads MCP tool ${name} has an invalid input schema`
    );
  }
  if (
    exact.outputSchema !== undefined &&
    !asNullableRecord(exact.outputSchema)
  ) {
    throw invalidCatalog(
      `Meta Ads MCP tool ${name} has an invalid output schema`
    );
  }
  if (
    exact.execution?.taskSupport !== undefined &&
    !["forbidden", "optional", "required"].includes(exact.execution.taskSupport)
  ) {
    throw invalidCatalog(
      `Meta Ads MCP tool ${name} has invalid task execution metadata`
    );
  }

  let exactCanonical: string;
  try {
    exactCanonical = serializeCanonicalJson(
      exact,
      CATALOG_SERIALIZATION_LIMITS
    );
  } catch {
    throw invalidCatalog(
      `Meta Ads MCP tool ${name} is not safe canonical JSON`
    );
  }

  const title = boundedString(exact.title, MAX_TITLE_LENGTH);
  // Provider descriptions contain required workflow steps. Keep them whole or
  // reject the catalog; a valid-looking partial contract can cause bad calls.
  const description = exact.description;
  if (
    description !== undefined &&
    description.length > MAX_DESCRIPTION_LENGTH
  ) {
    throw invalidCatalog(
      `Meta Ads MCP tool ${name} description exceeds ${MAX_DESCRIPTION_LENGTH} characters`
    );
  }
  const icons = publicIcons(exact.icons);
  const meta = publicMeta(exact._meta);
  return {
    name,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(icons ? { icons } : {}),
    inputSchema: canonicalClone(inputSchema),
    ...(exact.outputSchema
      ? { outputSchema: canonicalClone(exact.outputSchema) }
      : {}),
    ...(exact.annotations
      ? { annotations: canonicalClone(exact.annotations) }
      : {}),
    ...(exact.execution ? { execution: canonicalClone(exact.execution) } : {}),
    ...(meta ? { _meta: meta } : {}),
    definitionSha256: sha256(exactCanonical),
  };
}

function extractToolResultErrorMessage(
  toolName: string,
  result: Record<string, unknown>
): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const contentMessages = content.flatMap(item => {
    const block = asNullableRecord(item);
    const text = boundedString(block?.text, 500);
    return block?.type === "text" && text ? [text] : [];
  });
  if (contentMessages.length > 0)
    return contentMessages.join("\n").slice(0, 500);

  const structuredContent = asNullableRecord(result.structuredContent);
  const structuredError = asNullableRecord(structuredContent?.error);
  for (const candidate of [
    structuredContent?.message,
    structuredContent?.error,
    structuredError?.message,
    result.message,
  ]) {
    const message = boundedString(candidate, 500);
    if (message) return message;
  }
  return `Meta Ads MCP tool ${toolName} reported an execution error`;
}

function createPrivateSessionState(
  authProvider: AuthProvider
): PrivateSessionState {
  const transport = new StreamableHTTPClientTransport(
    new URL(META_ADS_MCP_URL),
    {
      authProvider,
      onInsufficientScope: "throw",
      maxStepUpRetries: 0,
      reconnectionOptions: {
        initialReconnectionDelay: 1_000,
        maxReconnectionDelay: 1_000,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 0,
      },
    }
  );
  const client = new Client(
    { name: "airi.chat", version: "1.0.0" },
    {
      versionNegotiation: {
        mode: "auto",
        probe: { timeoutMs: CONNECT_TIMEOUT_MS, maxRetries: 0 },
      },
      inputRequired: { autoFulfill: false },
      enforceStrictCapabilities: true,
      listMaxPages: 100,
      jsonSchemaValidator,
    }
  );
  return {
    authProvider,
    client,
    transport,
    toolsByName: new Map(),
  };
}

export function createMetaAdsMcpSession(
  accessToken: string
): MetaAdsMcpSession {
  const token = accessToken.trim();
  const session: MetaAdsMcpSession = { closed: false };
  privateSessionState.set(
    session,
    createPrivateSessionState({ token: async () => token })
  );
  return session;
}

export async function initializeMetaAdsMcpSession(
  session: MetaAdsMcpSession,
  options?: { signal?: AbortSignal }
): Promise<MetaAdsMcpProtocolMetadata> {
  if (options?.signal) throwIfAborted(options.signal);
  const state = ensureOpen(session);
  if (state.protocol) return canonicalClone(state.protocol);
  const signal = deadlineSignal(CONNECT_TIMEOUT_MS, options?.signal);
  try {
    throwIfAborted(signal);
    await state.client.connect(state.transport, {
      timeout: CONNECT_TIMEOUT_MS,
      signal,
    });
    throwIfAborted(signal);
    const era = state.client.getProtocolEra();
    const protocolVersion = state.client.getNegotiatedProtocolVersion();
    const server = state.client.getServerVersion();
    const capabilities = state.client.getServerCapabilities();
    if (!era || !protocolVersion || !capabilities || !capabilities.tools) {
      throw new MetaAdsMcpClientError(
        "protocol_error",
        "Meta Ads MCP did not negotiate the required tools capability"
      );
    }
    state.protocol = {
      era,
      protocolVersion,
      ...(boundedString(server?.name, MAX_TITLE_LENGTH)
        ? { serverName: boundedString(server?.name, MAX_TITLE_LENGTH) }
        : {}),
      ...(boundedString(server?.version, MAX_TITLE_LENGTH)
        ? { serverVersion: boundedString(server?.version, MAX_TITLE_LENGTH) }
        : {}),
      capabilities: canonicalClone(capabilities),
    };
    return canonicalClone(state.protocol);
  } catch (error) {
    throw mapClientError(error, signal);
  }
}

export async function listMetaAdsMcpTools(
  session: MetaAdsMcpSession,
  options?: { signal?: AbortSignal; cacheMode?: CacheMode }
): Promise<MetaAdsMcpCatalog> {
  const state = ensureOpen(session);
  if (!state.protocol) {
    throw new MetaAdsMcpClientError(
      "protocol_error",
      "Meta Ads MCP session must be initialized before listing tools"
    );
  }
  const signal = deadlineSignal(READ_TIMEOUT_MS, options?.signal);
  try {
    throwIfAborted(signal);
    const result = await state.client.listTools(undefined, {
      cacheMode: options?.cacheMode ?? "refresh",
      timeout: READ_TIMEOUT_MS,
      signal,
    });
    throwIfAborted(signal);
    if (result.tools.length === 0 || result.tools.length > MAX_TOOLS) {
      throw invalidCatalog(
        result.tools.length === 0
          ? "Meta Ads MCP returned an empty tool catalog"
          : `Meta Ads MCP returned more than ${MAX_TOOLS} tools`
      );
    }

    const nextToolsByName = new Map<
      string,
      { exact: Tool; definitionSha256: string }
    >();
    const discoveredNames = new Set<string>();
    let unsupportedTaskToolCount = 0;
    const discoveredTools = result.tools.map(exact => {
      const tool = projectTool(exact);
      if (discoveredNames.has(tool.name)) {
        throw invalidCatalog(
          `Meta Ads MCP returned duplicate tool name ${tool.name}`
        );
      }
      discoveredNames.add(tool.name);
      if (exact.execution?.taskSupport === "required") {
        unsupportedTaskToolCount += 1;
        return tool;
      }
      nextToolsByName.set(tool.name, {
        exact,
        definitionSha256: tool.definitionSha256,
      });
      return tool;
    });
    discoveredTools.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );

    let canonical: string;
    try {
      canonical = serializeCanonicalJson(
        { protocol: state.protocol, tools: discoveredTools },
        CATALOG_SERIALIZATION_LIMITS
      );
    } catch {
      throw invalidCatalog(
        "Meta Ads MCP tool catalog is not safe canonical JSON"
      );
    }
    const canonicalSizeBytes = Buffer.byteLength(canonical, "utf8");
    if (canonicalSizeBytes > MAX_CATALOG_BYTES) {
      throw invalidCatalog(
        `Meta Ads MCP tool catalog exceeds ${MAX_CATALOG_BYTES} bytes`
      );
    }
    const tools = discoveredTools.filter(
      tool => tool.execution?.taskSupport !== "required"
    );
    if (tools.length === 0) {
      throw invalidCatalog(
        "Meta Ads MCP returned no tools that support normal requests"
      );
    }
    state.toolsByName = nextToolsByName;
    return {
      tools,
      catalogSha256: sha256(canonical),
      canonicalSizeBytes,
      protocol: canonicalClone(state.protocol),
      ...(unsupportedTaskToolCount > 0 ? { unsupportedTaskToolCount } : {}),
    };
  } catch (error) {
    throw mapClientError(error, signal);
  }
}

export async function callMetaAdsMcpTool(params: {
  session: MetaAdsMcpSession;
  tool: MetaAdsMcpTool;
  arguments?: Record<string, unknown>;
  sideEffect: "read" | "write";
  signal?: AbortSignal;
  onDispatch?: () => void;
  onRetry?: (event: {
    attempt: number;
    code: MetaAdsMcpClientErrorCode;
    status?: number;
  }) => void;
}): Promise<unknown> {
  const timeout =
    params.sideEffect === "write" ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS;
  const deadlineAt = Date.now() + timeout;
  const signal = deadlineSignal(timeout, params.signal);
  const retryAllowed =
    params.sideEffect === "read" &&
    classifyMetaAdsMcpToolSideEffect(params.tool.name) === "read";
  for (let attempt = 1; ; attempt += 1) {
    throwIfAborted(signal);
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0)
      throw new MetaAdsMcpClientError(
        "request_timeout",
        "Meta Ads MCP request timed out"
      );
    const state = ensureOpen(params.session);
    const privateTool = state.toolsByName.get(params.tool.name);
    if (
      !privateTool ||
      privateTool.definitionSha256 !== params.tool.definitionSha256
    ) {
      throw invalidCatalog(
        "Meta Ads MCP tool definition no longer matches the active catalog"
      );
    }
    try {
      if (privateTool.exact.outputSchema)
        jsonSchemaValidator.getValidator(privateTool.exact.outputSchema);
    } catch {
      throw invalidCatalog(
        `Meta Ads MCP tool ${params.tool.name} has an invalid output schema`
      );
    }
    try {
      throwIfAborted(signal);
      params.onDispatch?.();
      const result = await state.client.callTool(
        { name: params.tool.name, arguments: params.arguments ?? {} },
        { timeout: remainingMs, signal, toolDefinition: privateTool.exact }
      );
      throwIfAborted(signal);
      if (result.isError === true) {
        const record = asNullableRecord(result) ?? {};
        throw new MetaAdsMcpToolResultError(
          params.tool.name,
          extractToolResultErrorMessage(params.tool.name, record),
          result
        );
      }
      return result;
    } catch (error) {
      if (error instanceof MetaAdsMcpToolResultError) throw error;
      const mapped = mapClientError(error, signal);
      if (!retryAllowed || attempt >= 2 || !canRetryRead(mapped, error))
        throw mapped;
      params.onRetry?.({
        attempt: attempt + 1,
        code: mapped.code,
        ...(mapped.status !== undefined ? { status: mapped.status } : {}),
      });
      await waitForReadRetry(signal);
      if (
        mapped.code === "connection_closed" ||
        (mapped.status === undefined && hasKnownNetworkCause(error))
      ) {
        await Promise.all([
          settleTeardownStep(() => state.transport.terminateSession()),
          settleTeardownStep(() => state.client.close()),
        ]);
        throwIfAborted(signal);
        ensureOpen(params.session);
        privateSessionState.set(
          params.session,
          createPrivateSessionState(state.authProvider)
        );
        await initializeMetaAdsMcpSession(params.session, { signal });
        await listMetaAdsMcpTools(params.session, {
          signal,
          cacheMode: "refresh",
        });
      }
    }
  }
}

export async function closeMetaAdsMcpSession(
  session: MetaAdsMcpSession
): Promise<void> {
  const state = privateSessionState.get(session);
  if (!state || session.closed) return;
  if (state.closePromise) return state.closePromise;

  state.closePromise = (async () => {
    try {
      await settleTeardownStep(() => state.transport.terminateSession());
    } finally {
      try {
        await settleTeardownStep(() => state.client.close());
      } finally {
        session.closed = true;
        state.toolsByName.clear();
        privateSessionState.delete(session);
      }
    }
  })();
  return state.closePromise;
}

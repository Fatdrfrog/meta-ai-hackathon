const ELEVENLABS_API_BASE_URL = "https://api.elevenlabs.io/v1";
const DEFAULT_TIMEOUT_MS = 45_000;

export type ElevenLabsErrorKind =
  | "config"
  | "network"
  | "timeout"
  | "auth"
  | "rate_limit"
  | "invalid_request"
  | "server"
  | "unknown";

export type ElevenLabsErrorInfo = {
  kind: ElevenLabsErrorKind;
  transient: boolean;
  status?: number;
  message: string;
};

export class ElevenLabsError extends Error {
  readonly info: ElevenLabsErrorInfo;

  constructor(info: ElevenLabsErrorInfo) {
    super(info.message);
    this.name = "ElevenLabsError";
    this.info = info;
  }
}

export type ElevenLabsConversationTokenResult = {
  token: string;
  agentId: string;
  latencyMs: number;
  expiresAt?: string;
};

export type ElevenLabsScribeTokenResult = {
  token: string;
  latencyMs: number;
  expiresAt?: string;
};

function getTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.ELEVENLABS_TIMEOUT_MS || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

async function fetchWithTimeout<T>(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  consumeResponse: (response: Response) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    const result = await consumeResponse(response);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    controller.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeElevenLabsError(
  error: unknown,
  fallbackMessage: string
): ElevenLabsError {
  if (error instanceof ElevenLabsError) {
    return error;
  }

  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name?: string }).name === "AbortError"
  ) {
    return new ElevenLabsError({
      kind: "timeout",
      transient: true,
      message: "ElevenLabs request timed out",
    });
  }

  const message = error instanceof Error ? error.message : fallbackMessage;
  return new ElevenLabsError({
    kind: "unknown",
    transient: true,
    message,
  });
}

function classifyHttpFailure(status: number, message: string): ElevenLabsError {
  if (status === 401 || status === 403) {
    return new ElevenLabsError({
      kind: "auth",
      transient: false,
      status,
      message: message || "ElevenLabs authentication failed",
    });
  }
  if (status === 408) {
    return new ElevenLabsError({
      kind: "timeout",
      transient: true,
      status,
      message: message || "ElevenLabs request timed out",
    });
  }
  if (status === 429) {
    return new ElevenLabsError({
      kind: "rate_limit",
      transient: true,
      status,
      message: message || "ElevenLabs rate limit reached",
    });
  }
  if (status >= 400 && status < 500) {
    return new ElevenLabsError({
      kind: "invalid_request",
      transient: false,
      status,
      message: message || "Invalid request sent to ElevenLabs",
    });
  }
  if (status >= 500) {
    return new ElevenLabsError({
      kind: "server",
      transient: true,
      status,
      message: message || "ElevenLabs server error",
    });
  }

  return new ElevenLabsError({
    kind: "unknown",
    transient: true,
    status,
    message: message || "Unexpected ElevenLabs error",
  });
}

function getErrorMessageFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const raw = payload as Record<string, unknown>;
  if (typeof raw.detail === "string") return raw.detail;
  if (typeof raw.error === "string") return raw.error;
  if (typeof raw.message === "string") return raw.message;
  if (
    raw.error &&
    typeof raw.error === "object" &&
    typeof (raw.error as Record<string, unknown>).message === "string"
  ) {
    return String((raw.error as Record<string, unknown>).message);
  }
  return "";
}

export async function createConversationToken(
  agentId: string,
  customerApiKey: string
): Promise<ElevenLabsConversationTokenResult> {
  const apiKey = customerApiKey?.trim() || "";
  if (!apiKey) {
    throw new ElevenLabsError({
      kind: "config",
      transient: false,
      message: "A customer ElevenLabs API key is required",
    });
  }

  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    throw new ElevenLabsError({
      kind: "invalid_request",
      transient: false,
      message: "Agent ID is required",
    });
  }

  const requestStarted = Date.now();
  const timeoutMs = getTimeoutMs();

  try {
    const { response, payload } = await fetchWithTimeout(
      `${ELEVENLABS_API_BASE_URL}/convai/conversation/token?agent_id=${encodeURIComponent(
        normalizedAgentId
      )}`,
      {
        method: "GET",
        headers: {
          "xi-api-key": apiKey,
        },
      },
      timeoutMs,
      async response => ({
        response,
        payload: await response.json().catch(() => null),
      })
    );
    if (!response.ok) {
      throw classifyHttpFailure(
        response.status,
        getErrorMessageFromPayload(payload)
      );
    }

    const rawToken =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).token ||
          (payload as Record<string, unknown>).conversation_token
        : undefined;
    const token =
      typeof rawToken === "string" && rawToken.trim().length > 0
        ? rawToken.trim()
        : "";

    if (!token) {
      throw new ElevenLabsError({
        kind: "unknown",
        transient: true,
        message: "ElevenLabs returned an empty conversation token",
      });
    }

    const expiresRaw =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).expires_at ||
          (payload as Record<string, unknown>).expiresAt
        : undefined;
    const expiresAt =
      typeof expiresRaw === "string" && expiresRaw.trim()
        ? expiresRaw.trim()
        : undefined;
    const latencyMs = Date.now() - requestStarted;

    console.info("[ElevenLabs Agents] conversation_token_created", {
      provider: "elevenlabs",
      agentId: normalizedAgentId,
      latencyMs,
      hasExpiresAt: Boolean(expiresAt),
    });

    return {
      token,
      agentId: normalizedAgentId,
      latencyMs,
      expiresAt,
    };
  } catch (error) {
    const normalized = normalizeElevenLabsError(
      error,
      "Unknown ElevenLabs conversation token error"
    );

    console.warn("[ElevenLabs Agents] conversation_token_failed", {
      provider: "elevenlabs",
      agentId: normalizedAgentId,
      kind: normalized.info.kind,
      transient: normalized.info.transient,
      status: normalized.info.status,
      latencyMs: Date.now() - requestStarted,
    });

    throw normalized;
  }
}

export async function createScribeRealtimeToken(
  customerApiKey: string
): Promise<ElevenLabsScribeTokenResult> {
  const apiKey = customerApiKey?.trim() || "";
  if (!apiKey) {
    throw new ElevenLabsError({
      kind: "config",
      transient: false,
      message: "A customer ElevenLabs API key is required",
    });
  }

  const requestStarted = Date.now();
  const timeoutMs = getTimeoutMs();

  try {
    const { response, payload } = await fetchWithTimeout(
      `${ELEVENLABS_API_BASE_URL}/single-use-token/realtime_scribe`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
        },
      },
      timeoutMs,
      async response => ({
        response,
        payload: await response.json().catch(() => null),
      })
    );

    if (!response.ok) {
      throw classifyHttpFailure(
        response.status,
        getErrorMessageFromPayload(payload)
      );
    }

    const raw = payload && typeof payload === "object" ? payload : {};
    const rawToken =
      (raw as Record<string, unknown>).token ||
      (raw as Record<string, unknown>).single_use_token;
    const token =
      typeof rawToken === "string" && rawToken.trim().length > 0
        ? rawToken.trim()
        : "";
    if (!token) {
      throw new ElevenLabsError({
        kind: "unknown",
        transient: true,
        message: "ElevenLabs returned an empty Scribe token",
      });
    }

    const expiresRaw =
      (raw as Record<string, unknown>).expires_at ||
      (raw as Record<string, unknown>).expiresAt;
    const expiresAt =
      typeof expiresRaw === "string" && expiresRaw.trim()
        ? expiresRaw.trim()
        : undefined;

    return {
      token,
      latencyMs: Date.now() - requestStarted,
      expiresAt,
    };
  } catch (error) {
    throw normalizeElevenLabsError(
      error,
      "Unknown ElevenLabs Scribe token error"
    );
  }
}

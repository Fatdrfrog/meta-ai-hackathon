import type {
  MessageDTO,
  SendMessageRequest,
  SendMessageResponse,
} from "@icecore/shared/types/message";
import type { WidgetConversationSummary } from "@icecore/shared/types/widget-config";
import {
  generateUUID,
  getVisitorId,
  getVisitorToken,
  STORAGE_KEYS,
} from "./storage";

/**
 * Retry configuration
 */
interface RetryConfig {
  maxRetries: number;
  baseDelay: number; // milliseconds
  maxDelay: number; // milliseconds
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10000,
};

export class WidgetRealtimeTokenError extends Error {
  status: number;
  retryable: boolean;
  code?: string;

  constructor(
    message: string,
    status: number,
    retryable: boolean,
    code?: string,
  ) {
    super(message);
    this.name = "WidgetRealtimeTokenError";
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

/**
 * The conversation does not exist or belongs to another visitor identity.
 */
export class WidgetConversationNotFoundError extends Error {
  constructor(message = "Conversation not found") {
    super(message);
    this.name = "WidgetConversationNotFoundError";
  }
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay with jitter
 */
function calculateBackoff(attempt: number, config: RetryConfig): number {
  const exponentialDelay = Math.min(
    config.baseDelay * Math.pow(2, attempt),
    config.maxDelay,
  );
  // Add jitter (random 0-20%)
  const jitter = exponentialDelay * 0.2 * Math.random();
  return exponentialDelay + jitter;
}

/**
 * Retry a fetch request with exponential backoff
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // Don't retry on 4xx errors (client errors)
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      ) {
        return response;
      }

      // Retry on 5xx errors or 429 (rate limit)
      if (response.ok || attempt === config.maxRetries) {
        return response;
      }

      // Calculate delay before next retry
      const delay = calculateBackoff(attempt, config);
      console.log(
        `Airi.chat Widget: Request failed (attempt ${attempt + 1}/${config.maxRetries + 1}), retrying in ${delay}ms...`,
      );
      await sleep(delay);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Network error");

      if (attempt === config.maxRetries) {
        throw lastError;
      }

      const delay = calculateBackoff(attempt, config);
      console.log(
        `Airi.chat Widget: Network error (attempt ${attempt + 1}/${config.maxRetries + 1}), retrying in ${delay}ms...`,
      );
      await sleep(delay);
    }
  }

  throw lastError || new Error("Failed after retries");
}

export class WidgetAPI {
  private apiUrl: string;
  private retryConfig: RetryConfig;

  constructor(
    apiUrl: string = "https://www.airi.chat/api/widget",
    retryConfig?: Partial<RetryConfig>,
  ) {
    this.apiUrl = apiUrl;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  }

  /**
   * Build request headers with visitor token for session persistence
   */
  private getRequestHeaders(): HeadersInit {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    const visitorToken = getVisitorToken();
    if (visitorToken) {
      headers["X-Visitor-Token"] = visitorToken;
    }

    return headers;
  }

  private getPlatformApiUrl(): string {
    return this.apiUrl.replace(/\/widget\/?$/, "");
  }

  async getRealtimeToken(params: {
    workspaceId: string;
    conversationId: string;
  }): Promise<{ token: string; url: string; expiresAt?: string }> {
    const visitorToken = getVisitorToken();
    if (!visitorToken) {
      throw new WidgetRealtimeTokenError(
        "Realtime token requires an active visitor session",
        401,
        false,
        "widget_visitor_token_missing",
      );
    }

    const response = await fetchWithRetry(
      `${this.getPlatformApiUrl()}/realtime/token`,
      {
        method: "POST",
        headers: this.getRequestHeaders(),
        credentials: "omit",
        body: JSON.stringify({
          source: "widget",
          workspaceId: params.workspaceId,
          conversationId: params.conversationId,
        }),
      },
      this.retryConfig,
    );

    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      token?: string;
      url?: string;
      expiresAt?: string;
    };

    if (!response.ok || !data.token || !data.url) {
      const status = response.status || 500;
      throw new WidgetRealtimeTokenError(
        data.error || "Failed to create realtime token",
        status,
        status >= 500 || status === 429,
        data.code,
      );
    }

    return {
      token: data.token,
      url: data.url,
      expiresAt: data.expiresAt,
    };
  }

  /**
   * Send a message (creates conversation if needed)
   */
  async sendMessage(request: SendMessageRequest): Promise<SendMessageResponse> {
    // Serialize once so a lost response cannot turn a retry into another send.
    const messageRequest: SendMessageRequest = {
      ...request,
      clientMessageId: request.clientMessageId ?? generateUUID(),
      metadata: {
        ...request.metadata,
        customerId: request.metadata?.customerId || getVisitorId(),
      },
    };
    const response = await fetchWithRetry(
      `${this.apiUrl}/conversations`,
      {
        method: "POST",
        headers: this.getRequestHeaders(),
        credentials: "omit",
        body: JSON.stringify(messageRequest),
      },
      this.retryConfig,
    );

    const data: SendMessageResponse = await response.json();

    if (response.status === 404 && messageRequest.conversationId) {
      throw new WidgetConversationNotFoundError(data.error);
    }
    if (!response.ok || !data.success) {
      throw new Error(data.error || "Failed to send message");
    }

    // Store visitor token if provided
    const visitorToken = response.headers.get("X-Visitor-Token");
    if (visitorToken) {
      try {
        if (typeof localStorage !== "undefined" && localStorage) {
          localStorage.setItem(STORAGE_KEYS.VISITOR_TOKEN, visitorToken);
        }
      } catch (error) {
        console.warn("Airi.chat Widget: Failed to store visitor token", error);
      }
    }

    return data;
  }

  /**
   * Load conversation history
   */
  async loadMessages(
    conversationId: string,
    clientKey: string,
    visitorId: string,
  ): Promise<MessageDTO[]> {
    // Build URL with query params (handle both relative and absolute URLs)
    const baseUrl = `${this.apiUrl}/conversations/${conversationId}/messages`;
    const urlWithParams = `${baseUrl}?client_key=${encodeURIComponent(clientKey)}`;

    const response = await fetchWithRetry(
      urlWithParams,
      {
        method: "GET",
        // The server returns history only to the visitor that owns it.
        headers: { ...this.getRequestHeaders(), "X-Visitor-Id": visitorId },
        credentials: "omit",
      },
      this.retryConfig,
    );

    const data = await response.json();

    if (response.status === 404) {
      throw new WidgetConversationNotFoundError(data.error);
    }
    if (!response.ok || !data.success) {
      throw new Error(data.error || "Failed to load messages");
    }

    return data.messages || [];
  }

  /**
   * Load all conversations for a visitor across URLs
   */
  async loadConversationHistory(
    clientKey: string,
    visitorId: string,
  ): Promise<{
    success: boolean;
    conversations: WidgetConversationSummary[];
    error?: string;
  }> {
    const urlWithParams = `${this.apiUrl}/conversations/history?client_key=${encodeURIComponent(clientKey)}&visitor_id=${encodeURIComponent(visitorId)}`;

    const response = await fetchWithRetry(
      urlWithParams,
      {
        method: "GET",
        headers: this.getRequestHeaders(),
        credentials: "omit",
      },
      this.retryConfig,
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || "Failed to load conversation history");
    }

    return data;
  }

  /**
   * Upload file (image)
   * Returns public URL for display in chat
   */
  async uploadFile(
    file: File,
    clientKey: string,
    onProgress?: (progress: number) => void,
  ): Promise<{
    success: boolean;
    url?: string;
    mediaType?:
      | "image"
      | "video"
      | "audio"
      | "document"
      | "sticker"
      | "voice"
      | "file";
    mimeType?: string;
    fileName?: string;
    fileSize?: number;
    error?: string;
  }> {
    const formData = new FormData();
    formData.append("file", file);
    const safeParseJson = (value: string) => {
      try {
        return JSON.parse(value || "{}");
      } catch {
        return {};
      }
    };

    try {
      const initiation = await fetchWithRetry(`${this.apiUrl}/upload`, {
        method: "POST",
        headers: { ...this.getRequestHeaders(), "x-client-key": clientKey },
        body: JSON.stringify({ action: "initiate", uploadId: generateUUID(), fileName: file.name, mimeType: file.type, fileSize: file.size }),
      });
      const upload = await initiation.json() as { uploadToken?: string; error?: string };
      if (!initiation.ok || !upload.uploadToken) throw new Error(upload.error || "Upload could not be started");
      formData.append("uploadToken", upload.uploadToken);
      // Create XMLHttpRequest to track upload progress
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();

        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable && onProgress) {
            const progress = (e.loaded / e.total) * 100;
            onProgress(Math.round(progress));
          }
        });

        xhr.addEventListener("load", () => {
          const data = safeParseJson(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(
              data as {
                success: boolean;
                url?: string;
                mediaType?:
                  | "image"
                  | "video"
                  | "audio"
                  | "document"
                  | "sticker"
                  | "voice"
                  | "file";
                mimeType?: string;
                fileName?: string;
                fileSize?: number;
                error?: string;
              },
            );
          } else {
            reject(
              new Error(
                typeof (data as { error?: unknown }).error === "string"
                  ? (data as { error: string }).error
                  : `Upload failed (${xhr.status})`,
              ),
            );
          }
        });

        xhr.addEventListener("error", () => {
          reject(new Error("Network error during upload"));
        });

        xhr.addEventListener("timeout", () => {
          reject(new Error("Upload timed out"));
        });

        xhr.open("POST", `${this.apiUrl}/upload`);
        xhr.timeout = 45000;
        xhr.setRequestHeader("x-client-key", clientKey);
        // Include visitor token for session persistence
        const visitorToken = getVisitorToken();
        if (visitorToken) {
          xhr.setRequestHeader("X-Visitor-Token", visitorToken);
        }
        xhr.send(formData);
      });
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Upload failed",
      };
    }
  }
}

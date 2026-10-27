import type { AiriChatSourceRef } from "@/lib/airi-chats/source-types";

export type AiriChatRunStatus = "running" | "complete" | "error";

/**
 * A durable run's own state (server: models/airi-chat-run.ts). The run
 * goes on when the client disconnects; only an explicit cancel stops it.
 */
export type AiriChatRunLifecycleStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type AiriChatRunResource = {
  id: string;
  label: string;
  kind:
    | "history"
    | "selected_source"
    | "knowledge_base"
    | "customer_chat"
    | "connector"
    | "creative_asset"
    | "model";
  count?: number;
  status?: AiriChatRunStatus;
  detail?: string | null;
};

export type AiriChatResourceReceipt = {
  selectedSources: AiriChatSourceRef[];
  selectedSourceLabels: string[];
  resources: AiriChatRunResource[];
  sourceIds: string[];
  retrievalPath: "snippet" | "kb" | "blended" | "none";
  provider: string | null;
  model: string | null;
  retryable?: boolean;
  errorCode?: string | null;
  /** Safe error code or class name of a failed step; never a message. */
  errorClass?: string;
  errorProvider?: string;
  errorHttpStatus?: number;
  durationMs: number;
};

export type AiriChatThinkingTrace = {
  stages: Array<{
    id: string;
    label: string;
    status: AiriChatRunStatus;
    detail?: string | null;
    /** Wall time of a finished stage, when the server measured it. */
    durationMs?: number;
    at: string;
  }>;
  resources: AiriChatRunResource[];
};

export type AiriChatRunEvent =
  | {
      /**
       * First event of a durable run stream (new or resumed): the run to
       * resume with GET .../runs/[runId]/stream or stop with POST
       * .../runs/[runId]/cancel.
       */
      type: "run";
      runId: string;
      threadId: string;
      clientTurnId: string;
      status: AiriChatRunLifecycleStatus;
      at: string;
    }
  | {
      type: "thread";
      thread: {
        id: string;
        title: string;
        source: string;
        pinnedAt?: string | null;
        updatedAt: string;
      };
      at: string;
    }
  | {
      type: "user_message";
      message: {
        id: string;
        threadId: string;
        role: "user";
        content: string;
        metadata?: Record<string, unknown> | null;
        createdAt: string;
      };
      at: string;
    }
  | {
      type: "stage";
      id: string;
      label: string;
      status: AiriChatRunStatus;
      detail?: string | null;
      durationMs?: number;
      at: string;
    }
  | {
      type: "resources";
      id: string;
      label: string;
      status: AiriChatRunStatus;
      resources: AiriChatRunResource[];
      at: string;
    }
  | {
      type: "model_attempt";
      id: string;
      label: string;
      status: AiriChatRunStatus;
      model?: string | null;
      attempt?: number;
      fallbackIndex?: number;
      retryable?: boolean;
      detail?: string | null;
      at: string;
    }
  | {
      /**
       * Streamed answer preview. `text` is the FULL answer accumulated so far,
       * not an increment; a provider fallback restarts it with shorter text.
       * The final assistant_message replaces it. Clients that do not know
       * this event ignore it.
       */
      type: "assistant_delta";
      threadId: string;
      text: string;
      at: string;
    }
  | {
      type: "assistant_message";
      message: {
        id: string;
        threadId: string;
        role: "assistant";
        content: string;
        metadata?: Record<string, unknown> | null;
        createdAt: string;
      };
      at: string;
    }
  | {
      type: "done";
      thread: {
        id: string;
        title: string;
        source: string;
        pinnedAt?: string | null;
        updatedAt: string;
      };
      /** How a durable run ended; absent on the request-bound path. */
      status?: Exclude<AiriChatRunLifecycleStatus, "running">;
      at: string;
    }
  | {
      type: "error";
      /** Safe to show; never a raw provider or runtime message. */
      message: string;
      /** Stable machine-readable reason, e.g. "selected_source_unavailable". */
      code?: string;
      status?: number;
      persisted?: boolean;
      at: string;
    };

export type AiriChatRunProgressEmitter = (
  event: AiriChatRunEvent
) => void | Promise<void>;

export function createAiriChatRunEventAt(): string {
  return new Date().toISOString();
}

function isTerminalAiriChatRunEvent(event: AiriChatRunEvent): boolean {
  switch (event.type) {
    case "error":
    case "assistant_message":
    case "done":
      return true;
    case "run":
    case "thread":
    case "user_message":
    case "stage":
    case "model_attempt":
    case "resources":
    case "assistant_delta":
      return false;
    default: {
      // An event type from a newer server is never terminal.
      const exhaustive: never = event;
      void exhaustive;
      return false;
    }
  }
}

export function isAiriChatRunTerminal(events: AiriChatRunEvent[]): boolean {
  return events.some(isTerminalAiriChatRunEvent);
}

export function retainTerminalAiriChatRunEvents(
  events: AiriChatRunEvent[]
): AiriChatRunEvent[] {
  return isAiriChatRunTerminal(events) ? events : [];
}

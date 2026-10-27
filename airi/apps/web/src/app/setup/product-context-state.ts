import type { IndexedUrlPublicSource } from "@/lib/kb/indexed-url-public-contract";
import {
  hasVerifiedWhatsAppHistory,
  isWhatsAppHistorySyncActive,
} from "@/lib/whatsapp/history-sync/status";
import type { WhatsAppHistorySyncState } from "@icecore/whatsapp/historySyncState";

export type ProductContextPhase =
  | "loading"
  | "idle"
  | "starting"
  | "polling"
  | "ready"
  | "background"
  | "error";

export type ProductTrainingHandoffState = {
  mutationPending: boolean;
  started: boolean;
  ready: boolean;
  background: boolean;
};

export type ConnectedSources = { instagram: boolean; whatsapp: boolean };

export type ProductContextCounts = {
  total: number;
  indexed: number;
  pending: number;
  failed: number;
};

export type ProductContextSnapshot = {
  sources: IndexedUrlPublicSource[];
  counts: ProductContextCounts;
  connected: ConnectedSources;
  whatsappStatusKnown: boolean;
  whatsappHistoryEligible: boolean;
  whatsappHistoryRequested: boolean;
  whatsappHistorySync?: WhatsAppHistorySyncState | null;
  whatsappHistoryCanRequest?: boolean;
};

export type ProductContextStartErrorCode =
  | "training_start_failed"
  | "whatsapp_history_failed"
  | "indexed_url_limit_exceeded"
  | "invalid_training_source";

export type ProductContextErrorCode =
  | "training_progress_unavailable"
  | ProductContextStartErrorCode;

export type ProductContextState = ProductContextSnapshot & {
  phase: ProductContextPhase;
  /** A start was accepted, or its uncertain response may hide persisted work. */
  acceptedRun: boolean;
  awaitingCrawlProgress: boolean;
  errorCode: ProductContextErrorCode | null;
};

export type ProductContextReadiness = {
  ready: boolean;
  source: "none" | "website" | "instagram" | "whatsapp" | "mixed";
};

export type ProductContextAction =
  | { type: "reset" }
  | { type: "load_succeeded"; snapshot: ProductContextSnapshot }
  | { type: "load_failed"; code: "training_progress_unavailable" }
  | { type: "start_requested" }
  | { type: "start_accepted"; awaitingCrawlProgress: boolean }
  | {
      type: "start_failed";
      code: ProductContextStartErrorCode;
    }
  | { type: "poll_succeeded"; snapshot: ProductContextSnapshot }
  | { type: "poll_failed"; code: "training_progress_unavailable" }
  | { type: "observation_expired" }
  | { type: "ready" };

export function createInitialProductContextState(): ProductContextState {
  return {
    phase: "loading",
    acceptedRun: false,
    awaitingCrawlProgress: false,
    errorCode: null,
    sources: [],
    counts: { total: 0, indexed: 0, pending: 0, failed: 0 },
    connected: { instagram: false, whatsapp: false },
    whatsappStatusKnown: false,
    whatsappHistoryEligible: false,
    whatsappHistoryRequested: false,
  };
}

function phaseAfterPoll(
  state: ProductContextState,
  snapshot: ProductContextSnapshot
): ProductContextPhase {
  if (
    snapshot.counts.pending > 0 ||
    isWhatsAppHistorySyncActive(snapshot.whatsappHistorySync)
  )
    return "polling";
  if (snapshot.counts.total === 0 && state.awaitingCrawlProgress)
    return "polling";
  return "idle";
}

export function productContextReducer(
  state: ProductContextState,
  action: ProductContextAction
): ProductContextState {
  switch (action.type) {
    case "reset":
      return createInitialProductContextState();
    case "load_succeeded":
      return {
        ...state,
        ...action.snapshot,
        phase: "idle",
        errorCode: null,
      };
    case "load_failed":
      return { ...state, phase: "error", errorCode: action.code };
    case "start_requested":
      return { ...state, phase: "starting", errorCode: null };
    case "start_accepted":
      return {
        ...state,
        phase: "polling",
        acceptedRun: true,
        awaitingCrawlProgress: action.awaitingCrawlProgress,
        errorCode: null,
      };
    case "start_failed":
      return { ...state, phase: "error", errorCode: action.code };
    case "poll_succeeded":
      return {
        ...state,
        ...action.snapshot,
        phase: phaseAfterPoll(state, action.snapshot),
        errorCode: null,
      };
    case "poll_failed":
      return { ...state, phase: "error", errorCode: action.code };
    case "observation_expired":
      return state.phase === "polling"
        ? { ...state, phase: "background" }
        : state;
    case "ready":
      return { ...state, phase: "ready", errorCode: null };
  }
}

function isInstagramUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "instagram.com" || hostname.endsWith(".instagram.com");
  } catch {
    return false;
  }
}

export function deriveProductContextReadiness(
  params: Pick<
    ProductContextSnapshot,
    | "sources"
    | "connected"
    | "whatsappStatusKnown"
    | "whatsappHistoryEligible"
    | "whatsappHistoryRequested"
    | "whatsappHistorySync"
  >
): ProductContextReadiness {
  let websiteReady = false;
  let instagramReady = false;

  for (const source of params.sources) {
    if (source.index_status !== "indexed") continue;
    if (isInstagramUrl(source.url)) {
      instagramReady = true;
    } else {
      websiteReady = true;
    }
  }

  const whatsappReady =
    params.connected.whatsapp &&
    params.whatsappStatusKnown &&
    (!params.whatsappHistoryEligible ||
      hasVerifiedWhatsAppHistory(params.whatsappHistorySync));
  const readySources = [websiteReady, instagramReady, whatsappReady].filter(
    Boolean
  ).length;

  if (readySources === 0) return { ready: false, source: "none" };
  if (readySources > 1) return { ready: true, source: "mixed" };
  if (websiteReady) return { ready: true, source: "website" };
  if (instagramReady) return { ready: true, source: "instagram" };
  return { ready: true, source: "whatsapp" };
}

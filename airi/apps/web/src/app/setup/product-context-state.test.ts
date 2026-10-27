import type { IndexedUrlPublicSource } from "@/lib/kb/indexed-url-public-contract";
import {
  createInitialProductContextState,
  deriveProductContextReadiness,
  productContextReducer,
  type ProductContextSnapshot,
  type ProductContextState,
} from "./product-context-state";

const emptySnapshot: ProductContextSnapshot = {
  sources: [],
  counts: { total: 0, indexed: 0, pending: 0, failed: 0 },
  connected: { instagram: false, whatsapp: false },
  whatsappStatusKnown: false,
  whatsappHistoryEligible: false,
  whatsappHistoryRequested: false,
};

const initialState: ProductContextState = {
  ...emptySnapshot,
  phase: "loading",
  acceptedRun: false,
  awaitingCrawlProgress: false,
  errorCode: null,
};

function source(
  overrides: Partial<IndexedUrlPublicSource> = {}
): IndexedUrlPublicSource {
  return {
    id: "source-1",
    url: "https://example.com",
    title: null,
    index_status: "pending",
    failure_code: null,
    error_message: null,
    ...overrides,
  };
}

describe("productContextReducer", () => {
  it("resets to a fresh loading state", () => {
    const dirtyState: ProductContextState = {
      ...initialState,
      phase: "ready",
      acceptedRun: true,
      sources: [source({ index_status: "indexed" })],
      counts: { total: 1, indexed: 1, pending: 0, failed: 0 },
      connected: { instagram: true, whatsapp: true },
      whatsappStatusKnown: true,
      whatsappHistoryRequested: true,
    };

    const reset = productContextReducer(dirtyState, { type: "reset" });
    const separatelyCreated = createInitialProductContextState();

    expect(reset).toEqual(separatelyCreated);
    expect(reset.sources).not.toBe(separatelyCreated.sources);
    expect(reset.counts).not.toBe(separatelyCreated.counts);
  });

  it("moves through the bounded foreground and background lifecycle", () => {
    const pendingSnapshot: ProductContextSnapshot = {
      ...emptySnapshot,
      sources: [source()],
      counts: { total: 1, indexed: 0, pending: 1, failed: 0 },
    };
    const readySnapshot: ProductContextSnapshot = {
      ...pendingSnapshot,
      sources: [source({ index_status: "indexed" })],
      counts: { total: 1, indexed: 1, pending: 0, failed: 0 },
    };

    const idle = productContextReducer(initialState, {
      type: "load_succeeded",
      snapshot: emptySnapshot,
    });
    expect(idle.phase).toBe("idle");

    const starting = productContextReducer(idle, { type: "start_requested" });
    expect(starting.phase).toBe("starting");

    const polling = productContextReducer(starting, {
      type: "start_accepted",
      awaitingCrawlProgress: true,
    });
    expect(polling).toMatchObject({ phase: "polling", acceptedRun: true });

    const pending = productContextReducer(polling, {
      type: "poll_succeeded",
      snapshot: pendingSnapshot,
    });
    expect(pending.phase).toBe("polling");

    const background = productContextReducer(pending, {
      type: "observation_expired",
    });
    expect(background.phase).toBe("background");

    const resumed = productContextReducer(background, {
      type: "poll_succeeded",
      snapshot: pendingSnapshot,
    });
    expect(resumed.phase).toBe("polling");

    const refreshed = productContextReducer(resumed, {
      type: "poll_succeeded",
      snapshot: readySnapshot,
    });
    const ready = productContextReducer(refreshed, { type: "ready" });
    expect(ready.phase).toBe("ready");
    expect(productContextReducer(ready, { type: "observation_expired" })).toBe(
      ready
    );
  });

  it("preserves the last successful rows and counts when refresh fails", () => {
    const snapshot: ProductContextSnapshot = {
      ...emptySnapshot,
      sources: [source()],
      counts: { total: 1, indexed: 0, pending: 1, failed: 0 },
    };
    const loaded = productContextReducer(initialState, {
      type: "load_succeeded",
      snapshot,
    });

    const failed = productContextReducer(loaded, {
      type: "poll_failed",
      code: "training_progress_unavailable",
    });

    expect(failed).toMatchObject({
      phase: "error",
      errorCode: "training_progress_unavailable",
      sources: snapshot.sources,
      counts: snapshot.counts,
    });
  });

  it("stops polling when every observed row has terminally failed", () => {
    const polling = productContextReducer(
      productContextReducer(initialState, { type: "start_requested" }),
      { type: "start_accepted", awaitingCrawlProgress: true }
    );
    const failedSource = source({
      index_status: "failed",
      failure_code: "generic",
      error_message: "Indexing failed.",
    });

    const terminal = productContextReducer(polling, {
      type: "poll_succeeded",
      snapshot: {
        ...emptySnapshot,
        sources: [failedSource],
        counts: { total: 1, indexed: 0, pending: 0, failed: 1 },
      },
    });

    expect(terminal).toMatchObject({
      phase: "idle",
      acceptedRun: true,
      errorCode: null,
      sources: [failedSource],
    });
  });

  it("uses stable error codes for initial and start failures", () => {
    expect(
      productContextReducer(initialState, {
        type: "load_failed",
        code: "training_progress_unavailable",
      })
    ).toMatchObject({
      phase: "error",
      errorCode: "training_progress_unavailable",
    });

    expect(
      productContextReducer(
        productContextReducer(initialState, { type: "start_requested" }),
        { type: "start_failed", code: "training_start_failed" }
      )
    ).toMatchObject({
      phase: "error",
      errorCode: "training_start_failed",
      acceptedRun: false,
    });
  });

  it("represents a WhatsApp-only start failure with its safe code", () => {
    expect(
      productContextReducer(
        productContextReducer(initialState, { type: "start_requested" }),
        { type: "start_failed", code: "whatsapp_history_failed" }
      )
    ).toMatchObject({
      phase: "error",
      errorCode: "whatsapp_history_failed",
      acceptedRun: false,
    });
  });

  it("preserves an accepted sibling branch when the crawl hits its source limit", () => {
    const accepted = productContextReducer(
      productContextReducer(initialState, { type: "start_requested" }),
      { type: "start_accepted", awaitingCrawlProgress: true }
    );

    expect(
      productContextReducer(accepted, {
        type: "start_failed",
        code: "indexed_url_limit_exceeded",
      })
    ).toMatchObject({
      phase: "error",
      errorCode: "indexed_url_limit_exceeded",
      acceptedRun: true,
    });
  });
});

describe("deriveProductContextReadiness", () => {
  it("does not treat a selected connected Instagram account as ready", () => {
    expect(
      deriveProductContextReadiness({
        sources: [],
        connected: { instagram: true, whatsapp: false },
        whatsappStatusKnown: false,
        whatsappHistoryEligible: false,
        whatsappHistoryRequested: false,
      })
    ).toEqual({ ready: false, source: "none" });
  });

  it("treats indexed website knowledge as ready", () => {
    expect(
      deriveProductContextReadiness({
        sources: [source({ index_status: "indexed" })],
        connected: { instagram: false, whatsapp: false },
        whatsappStatusKnown: false,
        whatsappHistoryEligible: false,
        whatsappHistoryRequested: false,
      })
    ).toEqual({ ready: true, source: "website" });
  });

  it("recognizes an indexed Instagram row without using connection state alone", () => {
    expect(
      deriveProductContextReadiness({
        sources: [
          source({
            url: "https://www.instagram.com/example-brand",
            index_status: "indexed",
          }),
        ],
        connected: { instagram: true, whatsapp: false },
        whatsappStatusKnown: false,
        whatsappHistoryEligible: false,
        whatsappHistoryRequested: false,
      })
    ).toEqual({ ready: true, source: "instagram" });
  });

  it.each([
    {
      name: "verified saved coexistence history",
      whatsappHistoryEligible: true,
      whatsappHistoryRequested: true,
      whatsappStatusKnown: true,
      whatsappHistorySync: {
        counts_verified: true,
        synchronized_count_total: 3,
      },
    },
    {
      name: "selected non-coexistence Cloud WhatsApp",
      whatsappHistoryEligible: false,
      whatsappHistoryRequested: false,
      whatsappStatusKnown: true,
    },
  ])("treats $name as ready", readiness => {
    expect(
      deriveProductContextReadiness({
        sources: [],
        connected: { instagram: false, whatsapp: true },
        whatsappStatusKnown: readiness.whatsappStatusKnown,
        whatsappHistoryEligible: readiness.whatsappHistoryEligible,
        whatsappHistoryRequested: readiness.whatsappHistoryRequested,
        whatsappHistorySync: readiness.whatsappHistorySync,
      })
    ).toEqual({ ready: true, source: "whatsapp" });
  });

  it("keeps accepted coexistence history pending until messages are verified", () => {
    expect(
      deriveProductContextReadiness({
        sources: [],
        connected: { instagram: false, whatsapp: true },
        whatsappStatusKnown: true,
        whatsappHistoryEligible: true,
        whatsappHistoryRequested: true,
      })
    ).toEqual({ ready: false, source: "none" });
  });

  it("reports mixed readiness when indexed knowledge and WhatsApp are usable", () => {
    expect(
      deriveProductContextReadiness({
        sources: [source({ index_status: "indexed" })],
        connected: { instagram: false, whatsapp: true },
        whatsappStatusKnown: true,
        whatsappHistoryEligible: false,
        whatsappHistoryRequested: false,
      })
    ).toEqual({ ready: true, source: "mixed" });
  });

  it("does not treat unknown WhatsApp status as confirmed non-coexistence", () => {
    expect(
      deriveProductContextReadiness({
        sources: [],
        connected: { instagram: false, whatsapp: true },
        whatsappStatusKnown: false,
        whatsappHistoryEligible: false,
        whatsappHistoryRequested: false,
      })
    ).toEqual({ ready: false, source: "none" });
  });

  it("derives known non-coexistence WhatsApp readiness from durable state instead of selection", () => {
    expect(
      deriveProductContextReadiness({
        sources: [],
        connected: { instagram: false, whatsapp: true },
        whatsappStatusKnown: true,
        whatsappHistoryEligible: false,
        whatsappHistoryRequested: false,
      })
    ).toEqual({ ready: true, source: "whatsapp" });
  });
});

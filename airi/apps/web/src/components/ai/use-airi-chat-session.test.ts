import {
  createAiriClientTurnId,
  mergeAiriChatNewestPage,
  toAiriChatMessagePage,
  type AiriChatMessage,
} from "./use-airi-chat-session";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function message(id: string): AiriChatMessage {
  return {
    id,
    threadId: "thread-1",
    role: "user",
    content: id,
    metadata: null,
    createdAt: "2026-10-11T09:00:00.000Z",
  };
}

describe("createAiriClientTurnId", () => {
  const originalCrypto = globalThis.crypto;

  afterEach(() => {
    Object.defineProperty(globalThis, "crypto", {
      value: originalCrypto,
      configurable: true,
    });
  });

  it("returns a v4 uuid the request schema accepts", () => {
    expect(createAiriClientTurnId()).toMatch(UUID);
  });

  it("builds a v4 uuid where randomUUID is missing", () => {
    Object.defineProperty(globalThis, "crypto", {
      value: {
        getRandomValues: (bytes: Uint8Array) => bytes.fill(0xff),
      },
      configurable: true,
    });
    expect(createAiriClientTurnId()).toMatch(UUID);

    Object.defineProperty(globalThis, "crypto", {
      value: undefined,
      configurable: true,
    });
    const first = createAiriClientTurnId();
    expect(first).toMatch(UUID);
    expect(createAiriClientTurnId()).not.toBe(first);
  });
});

describe("toAiriChatMessagePage", () => {
  it("reads a page and drops a malformed active run", () => {
    expect(
      toAiriChatMessagePage({
        messages: [message("m1")],
        hasMore: true,
        activeRun: { runId: "run-1", status: "running", startedAt: "now" },
      })
    ).toEqual({
      messages: [message("m1")],
      hasMore: true,
      activeRun: { runId: "run-1", status: "running", startedAt: "now" },
    });
    expect(toAiriChatMessagePage({ activeRun: { status: "running" } })).toEqual(
      { messages: [], hasMore: false, activeRun: null }
    );
  });
});

describe("mergeAiriChatNewestPage", () => {
  it("keeps older pages loaded before a fresh newest page", () => {
    const current = {
      messages: ["m1", "m2", "m3", "m4"].map(message),
      hasMore: false,
      activeRun: null,
    };
    const fresh = {
      messages: ["m3", "m4", "m5"].map(message),
      hasMore: true,
      activeRun: null,
    };
    expect(mergeAiriChatNewestPage(current, fresh)).toEqual({
      messages: ["m1", "m2", "m3", "m4", "m5"].map(message),
      hasMore: false,
      activeRun: null,
    });
  });

  it("takes the fresh page when it no longer connects to what was loaded", () => {
    const current = {
      messages: ["m1", "m2"].map(message),
      hasMore: false,
      activeRun: null,
    };
    const fresh = {
      messages: ["m7", "m8"].map(message),
      hasMore: true,
      activeRun: null,
    };
    expect(mergeAiriChatNewestPage(current, fresh)).toBe(fresh);
    expect(mergeAiriChatNewestPage(undefined, fresh)).toBe(fresh);
  });
});

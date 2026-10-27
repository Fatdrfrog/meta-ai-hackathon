const mockFindOne = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockUpdateOne = jest.fn();
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/airi-turn-context", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => {
      const query = {
        select: () => query,
        lean: async () => mockFindOne(...args),
      };
      return query;
    },
    findOneAndUpdate: (...args: unknown[]) => {
      const query = {
        select: () => query,
        lean: async () => mockFindOneAndUpdate(...args),
      };
      return query;
    },
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}));

import {
  claimAiriTurnPreparation,
  completeAiriTurnPreparation,
  failAiriTurnPreparation,
  recordAiriConversationTurnDisposition,
} from "./airi-turn-execution";
import type {
  AiriConversationTurnProcessResult,
  AiriConversationTurnSignal,
} from "@icecore/temporal";

const turn = {
  workspaceId: "ws",
  conversationId: "conv",
  messageId: "message",
  turnContextId: "context",
  enqueuedAt: "2026-09-09T00:00:00Z",
} as AiriConversationTurnSignal;
const result: AiriConversationTurnProcessResult = {
  messageId: "message",
  completedAt: "2026-09-09T00:00:00Z",
  outcome: {
    responseStatus: 200,
    executionStatus: "completed",
    skippedConcurrent: false,
  },
  pendingDelivery: {
    deliveryKey: "delivery",
    reservedMessageId: "reserved",
    context: {},
  },
};
const claim = {
  status: "claimed" as const,
  turnContextId: "context",
  attemptToken: "attempt",
  workspaceId: "ws",
  conversationId: "conv",
  messageId: "message",
};

beforeEach(() => {
  jest.resetAllMocks();
  mockUpdateOne.mockResolvedValue({ matchedCount: 1 });
});

it("claims before runtime and keeps unresolved preparation out of TTL expiry", async () => {
  mockFindOneAndUpdate.mockImplementationOnce((_filter, update) => ({
    turnPreparation: update.$set.turnPreparation,
  }));
  const owned = await claimAiriTurnPreparation(turn);
  expect(owned).toMatchObject({ status: "claimed", turnContextId: "context" });
  expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "ws",
      conversationId: "conv",
      messageId: "message",
    }),
    expect.objectContaining({
      $set: expect.objectContaining({
        expiresAt: null,
        turnPreparation: expect.objectContaining({ status: "preparing" }),
      }),
    }),
    expect.any(Object)
  );
});

it("returns an immutable prepared checkpoint on replay without taking ownership", async () => {
  mockFindOneAndUpdate.mockResolvedValueOnce(null);
  mockFindOne.mockResolvedValueOnce({
    turnPreparation: { status: "prepared", result },
  });
  expect(await claimAiriTurnPreparation(turn)).toEqual({
    status: "prepared",
    result,
  });
});

it.each(["completed", "terminal", "superseded", "outcome_unknown"])(
  "lets a %s disposition block an earlier prepared delivery checkpoint",
  async status => {
    mockFindOneAndUpdate.mockResolvedValueOnce(null);
    mockFindOne.mockResolvedValueOnce({
      turnPreparation: { status: "prepared", result },
      turnDisposition: { status },
    });
    expect(await claimAiriTurnPreparation(turn)).toEqual({
      status: status === "outcome_unknown" ? "outcome_unknown" : "terminal",
    });
  }
);

it("does not reuse a malformed checkpoint for another message", async () => {
  mockFindOneAndUpdate.mockResolvedValueOnce(null);
  mockFindOne.mockResolvedValueOnce({
    turnPreparation: {
      status: "prepared",
      result: { ...result, messageId: "other-message" },
    },
  });
  expect(await claimAiriTurnPreparation(turn)).toEqual({
    status: "outcome_unknown",
  });
});

it("keeps failed HTTP results terminal and replays their failure checkpoint", async () => {
  const failed = {
    ...result,
    outcome: {
      ...result.outcome,
      executionStatus: "failed" as const,
      responseStatus: 503,
    },
  };
  await completeAiriTurnPreparation(claim, failed);
  expect(mockUpdateOne.mock.calls[0]?.[1].$set["turnPreparation.status"]).toBe(
    "terminal"
  );
  mockFindOneAndUpdate.mockResolvedValueOnce(null);
  mockFindOne.mockResolvedValueOnce({
    turnPreparation: { status: "terminal", result: failed },
  });
  expect(await claimAiriTurnPreparation(turn)).toEqual({
    status: "prepared",
    result: failed,
  });
});

it.each(["preparing", "outcome_unknown"])(
  "never reacquires a %s owner",
  async status => {
    mockFindOneAndUpdate.mockResolvedValueOnce(null);
    mockFindOne.mockResolvedValueOnce({
      turnPreparation: { status, attemptToken: "original" },
    });
    expect(await claimAiriTurnPreparation(turn)).toEqual({
      status: "outcome_unknown",
    });
  }
);

it.each(["superseded", "terminal", "completed"])(
  "does not start a turn with a %s receipt",
  async status => {
    mockFindOneAndUpdate.mockImplementationOnce((filter, update) => {
      const blockedStatuses = filter["turnDisposition.status"]?.$nin || [];
      return blockedStatuses.includes(status)
        ? null
        : { turnPreparation: update.$set.turnPreparation };
    });
    mockFindOne.mockResolvedValueOnce({
      turnPreparation: { status: "retryable" },
      turnDisposition: { status },
    });
    expect(await claimAiriTurnPreparation(turn)).toEqual({
      status: "terminal",
    });
  }
);

it("checkpoints the full prepared result using the exact attempt token", async () => {
  await completeAiriTurnPreparation(claim, result);
  expect(mockUpdateOne).toHaveBeenCalledWith(
    expect.objectContaining({
      "turnPreparation.attemptToken": "attempt",
      "turnPreparation.status": "preparing",
    }),
    expect.objectContaining({
      $set: expect.objectContaining({
        "turnPreparation.status": "prepared",
        "turnPreparation.result": result,
      }),
    })
  );
});

it("does not let a stale attempt overwrite a newer owner", async () => {
  mockUpdateOne.mockResolvedValueOnce({ matchedCount: 0 });
  await expect(completeAiriTurnPreparation(claim, result)).rejects.toThrow(
    "ownership"
  );
});

it("allows a known preflight failure to retry but preserves ambiguous failures", async () => {
  await failAiriTurnPreparation(claim, "read failed", true);
  expect(mockUpdateOne.mock.calls[0]?.[1].$set["turnPreparation.status"]).toBe(
    "retryable"
  );
  await failAiriTurnPreparation(claim, "runtime failed", false);
  expect(mockUpdateOne.mock.calls[1]?.[1].$set["turnPreparation.status"]).toBe(
    "outcome_unknown"
  );
});

it("creates a stable contextless legacy owner without creating an ingress queue item", async () => {
  mockFindOneAndUpdate.mockImplementation((_filter, update) => ({
    turnPreparation: update.$set.turnPreparation,
  }));
  const legacy = {
    ...turn,
    turnContextId: undefined,
    autoReplyPayload: { secret: "must-not-persist" },
  } as unknown as AiriConversationTurnSignal;
  const first = await claimAiriTurnPreparation(legacy);
  const second = await claimAiriTurnPreparation({
    ...legacy,
    enqueuedAt: "2026-09-10T00:00:00Z",
  });
  expect(first).toMatchObject({
    turnContextId:
      "airi-execution:ccf444d03dc21b7c8ccdfc284b2b644d6a11be3ac3c9c70d221e8c3bfd6d6f6a",
  });
  expect((first as typeof claim).turnContextId).toBe(
    (second as typeof claim).turnContextId
  );
  const insert = mockFindOneAndUpdate.mock.calls[0]?.[1].$setOnInsert;
  expect(insert).not.toHaveProperty("ingressKind");
  expect(JSON.stringify(insert)).not.toContain("must-not-persist");
});

it("persists only the whitelisted disposition reference and keeps unknown work", async () => {
  const receipt = {
    turn: {
      ...turn,
      autoReplyPayload: { token: "private" },
      textPreview: "private",
    },
    status: "outcome_unknown" as const,
    stage: "prepare" as const,
    attempt: 1,
    updatedAt: "2026-09-09T00:00:00Z",
    error: "timeout",
    nextAttemptAt: null,
  };
  await recordAiriConversationTurnDisposition(receipt);
  const update = mockUpdateOne.mock.calls[0]?.[1];
  expect(update.$set.expiresAt).toBeNull();
  expect(update.$set.turnDisposition.turn).not.toHaveProperty(
    "autoReplyPayload"
  );
  expect(update.$set.turnDisposition.turn).not.toHaveProperty("textPreview");
  expect(mockUpdateOne.mock.calls[0]?.[0].$or).toContainEqual({
    "turnDisposition.updatedAt": { $lte: receipt.updatedAt },
  });
});

it("gives a contextless recovery its own preparation owner and disposition", async () => {
  const owners = new Map<string, Record<string, unknown>>();
  mockFindOneAndUpdate.mockImplementation((filter, update) => {
    const owner = owners.get(filter.turnContextId);
    if (owner) return null;
    const created = { turnPreparation: update.$set.turnPreparation };
    owners.set(filter.turnContextId, created);
    return created;
  });
  mockFindOne.mockImplementation(filter => owners.get(filter.turnContextId));
  mockUpdateOne.mockImplementation((filter, update) => {
    const owner = owners.get(filter.turnContextId);
    if (!owner) return { matchedCount: 0 };
    if (update.$set.turnDisposition)
      owner.turnDisposition = update.$set.turnDisposition;
    return { matchedCount: 1 };
  });
  const legacy = { ...turn, turnContextId: undefined };
  const original = await claimAiriTurnPreparation(legacy);
  const disposition = {
    status: "completed" as const,
    stage: "prepare" as const,
    attempt: 0,
    updatedAt: "2026-09-09T00:00:00Z",
    error: null,
    nextAttemptAt: null,
  };
  await recordAiriConversationTurnDisposition({ ...disposition, turn: legacy });
  const recovered = { ...legacy, messageRecoveryRevision: "a".repeat(64) };
  const recovery = await claimAiriTurnPreparation(recovered);
  expect(recovery.status).toBe("claimed");
  expect((recovery as typeof claim).turnContextId).not.toBe(
    (original as typeof claim).turnContextId
  );
  await recordAiriConversationTurnDisposition({
    ...disposition,
    turn: recovered,
  });
  expect(mockUpdateOne.mock.calls[1]?.[0].turnContextId).toBe(
    (recovery as typeof claim).turnContextId
  );
  expect(
    await claimAiriTurnPreparation({
      ...recovered,
      enqueuedAt: "2026-09-10T00:00:00Z",
    })
  ).toEqual({ status: "terminal" });
  expect(owners.size).toBe(2);
});

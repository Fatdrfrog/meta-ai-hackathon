const mockFindOneAndUpdate = jest.fn();
const mockUpdateOne = jest.fn();

jest.mock("@/models/airi-turn-context", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}));

import {
  claimAiriIngress,
  finishAiriIngressClaim,
  getAiriIngressRetryDate,
} from "./airi-ingress-lease";

const now = new Date("2026-09-09T08:00:00.000Z");

describe("Airi ingress leases", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("atomically claims only available leases within the owner's due and attempt policy", async () => {
    const filter = {
      triggerEventKind: "timer_replan",
      ingressStatus: "pending",
      ingressNextRetryAt: { $lte: now },
      ingressAttempts: { $lt: 5 },
      workspaceId: "workspace-1",
    };
    mockFindOneAndUpdate.mockImplementation((_filter, update) => ({
      toObject: () => ({
        _id: "ingress-1",
        ingressKey: "timer-replan-ingress:1",
        ingressAttempts: 2,
        ingressLeaseToken: update.$set.ingressLeaseToken,
        workspaceId: "workspace-1",
      }),
    }));

    const claimed = await claimAiriIngress({
      filter,
      now,
      sort: { ingressNextRetryAt: 1, _id: 1 },
      hint: "airi_timer_replan_ingress_queue",
    });

    expect(claimed).toEqual({
      _id: "ingress-1",
      ingressKey: "timer-replan-ingress:1",
      ingressAttempts: 2,
      ingressLeaseToken: expect.any(String),
      workspaceId: "workspace-1",
    });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      {
        ...filter,
        $or: [
          { ingressLeaseExpiresAt: { $exists: false } },
          { ingressLeaseExpiresAt: null },
          { ingressLeaseExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          ingressLeaseToken: claimed?.ingressLeaseToken,
          ingressLeaseExpiresAt: new Date("2026-09-09T08:05:00.000Z"),
          ingressAttemptedAt: now,
        },
        $inc: { ingressAttempts: 1 },
      },
      {
        new: true,
        sort: { ingressNextRetryAt: 1, _id: 1 },
        hint: "airi_timer_replan_ingress_queue",
      }
    );
  });

  it("preserves an owner's alternative eligibility rules without imposing an attempt cap", async () => {
    const filter = {
      ingressStatus: "pending",
      $or: [
        { ingressNextRetryAt: { $lte: now } },
        { ingressNextRetryAt: { $exists: false } },
      ],
    };
    mockFindOneAndUpdate.mockResolvedValue(null);

    await expect(claimAiriIngress({ filter, now })).resolves.toBeNull();

    const query = mockFindOneAndUpdate.mock.calls[0][0];
    expect(query).toEqual({
      $and: [
        filter,
        {
          $or: [
            { ingressLeaseExpiresAt: { $exists: false } },
            { ingressLeaseExpiresAt: null },
            { ingressLeaseExpiresAt: { $lte: now } },
          ],
        },
      ],
    });
    expect(mockFindOneAndUpdate.mock.calls[0][2]).toEqual({ new: true });
  });

  it("uses independent ownership tokens and rejects a result owned by another claimant", async () => {
    const tokens: string[] = [];
    mockFindOneAndUpdate.mockImplementation((_filter, update) => {
      tokens.push(update.$set.ingressLeaseToken);
      return {
        _id: "ingress-1",
        ingressKey: "airi-ingress:1",
        ingressAttempts: 1,
        ingressLeaseToken: "other-claimant",
      };
    });

    const results = await Promise.all([
      claimAiriIngress({ filter: { ingressStatus: "pending" }, now }),
      claimAiriIngress({ filter: { ingressStatus: "pending" }, now }),
    ]);

    expect(results).toEqual([null, null]);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it.each([
    [{ matchedCount: 1, modifiedCount: 1 }, true],
    [{ matchedCount: 0, modifiedCount: 0 }, false],
    [{ matchedCount: 1, modifiedCount: 0 }, false],
  ])(
    "finishes only a pending row still owned by the lease token: %j",
    async (result, expected) => {
      mockUpdateOne.mockResolvedValue(result);
      const update = {
        $set: { ingressStatus: "signaled" },
        $unset: { ingressLeaseToken: "", ingressLeaseExpiresAt: "" },
      };

      await expect(
        finishAiriIngressClaim({
          claimed: { _id: "ingress-1", ingressLeaseToken: "owner-1" },
          update,
        })
      ).resolves.toBe(expected);
      expect(mockUpdateOne).toHaveBeenCalledWith(
        {
          _id: "ingress-1",
          ingressStatus: "pending",
          ingressLeaseToken: "owner-1",
        },
        update
      );
    }
  );

  it.each([
    [0, "2026-09-09T08:00:30.000Z"],
    [1, "2026-09-09T08:00:30.000Z"],
    [2, "2026-09-09T08:02:00.000Z"],
    [3, "2026-09-09T08:10:00.000Z"],
    [4, "2026-09-09T08:30:00.000Z"],
    [100, "2026-09-09T08:30:00.000Z"],
  ])("schedules attempt %i with capped backoff", (attempt, expected) => {
    expect(getAiriIngressRetryDate(now, attempt).toISOString()).toBe(expected);
    expect(now.toISOString()).toBe("2026-09-09T08:00:00.000Z");
  });
});

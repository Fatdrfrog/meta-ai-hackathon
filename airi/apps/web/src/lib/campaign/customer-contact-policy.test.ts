jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
const mockConsent = jest.fn();
const mockCustomer = jest.fn();
const mockCustomerAggregate = jest.fn();
const mockPolicyRead = jest.fn();
const mockConversations = jest.fn();
const mockReservationFind = jest.fn();
type ReservationRow = {
  version: number;
  contacts: { key: string; at: Date }[];
};
const mockRows = new Map<string, ReservationRow>();
let mockRevision = 0;
const mockCommit = jest.fn();
const mockSessions: ReturnType<typeof createMockSession>[] = [];
const noWriteResult = {
  acknowledged: true,
  matchedCount: 0,
  modifiedCount: 0,
  upsertedCount: 0,
  upsertedId: null,
};

// Stage writes per session, publish only at commit, and retry an outdated
// snapshot as the driver's withTransaction does after a write conflict.
function createMockSession() {
  const session = {
    rows: new Map<string, ReservationRow>(),
    withTransaction: jest.fn(async (operation: () => Promise<unknown>) => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const revision = mockRevision;
        session.rows = structuredClone(mockRows);
        const result = await operation();
        if (revision !== mockRevision) continue;
        mockRows.clear();
        for (const [identity, row] of session.rows) mockRows.set(identity, row);
        mockRevision++;
        await mockCommit();
        return result;
      }
      throw new Error("Test transaction contention limit exceeded");
    }),
    endSession: jest.fn(async () => undefined),
  };
  return session;
}
jest.mock("./marketing-opt-in", () => ({
  filterKnownMarketingOptOutRecipients: (...a: unknown[]) => mockConsent(...a),
}));
jest.mock("@/models/customer-contact-policy", () => ({
  __esModule: true,
  default: { findOne: () => ({ lean: () => mockPolicyRead() }) },
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    find: (...args: unknown[]) => ({
      select: () => ({ lean: () => mockConversations(...args) }),
    }),
  },
}));
jest.mock("@/models/customer", () => ({
  __esModule: true,
  default: {
    aggregate: (...args: unknown[]) => mockCustomerAggregate(...args),
  },
}));
jest.mock("@/models/customer-contact-reservation", () => ({
  __esModule: true,
  default: {
    startSession: jest.fn(async () => {
      const session = createMockSession();
      mockSessions.push(session);
      return session;
    }),
    find: (...args: unknown[]) => ({
      select: () => ({ lean: () => mockReservationFind(...args) }),
    }),
    findOne: (scope: { identity: string }) => {
      let rows = mockRows;
      const query = {
        session: (session: ReturnType<typeof createMockSession>) => {
          rows = session.rows;
          return query;
        },
        lean: async () => structuredClone(rows.get(scope.identity)),
      };
      return query;
    },
    updateOne: jest.fn(
      async (
        scope: { identity: string; version?: number },
        update: {
          $setOnInsert?: ReservationRow;
          $set?: { contacts: { key: string; at: Date }[] };
        },
        options?: { session?: ReturnType<typeof createMockSession> }
      ) => {
        const rows = options?.session?.rows || mockRows;
        if (update.$setOnInsert) {
          if (rows.has(scope.identity))
            return { modifiedCount: 0, upsertedCount: 0 };
          rows.set(scope.identity, structuredClone(update.$setOnInsert));
          return { modifiedCount: 0, upsertedCount: 1 };
        }
        const row = rows.get(scope.identity);
        if (!row || row.version !== scope.version) return { modifiedCount: 0 };
        rows.set(scope.identity, {
          version: row.version + 1,
          contacts: update.$set!.contacts,
        });
        return { modifiedCount: 1 };
      }
    ),
    // A committed write outside any transaction: open snapshots must retry.
    updateMany: jest.fn(
      async (
        filter: { identity: { $in: string[] }; "contacts.key": string },
        update: { $pull: { contacts: { key: string } }; $inc: object }
      ) => {
        let modifiedCount = 0;
        for (const identity of filter.identity.$in) {
          const row = mockRows.get(identity);
          if (
            !row?.contacts.some(
              contact => contact.key === filter["contacts.key"]
            )
          )
            continue;
          mockRows.set(identity, {
            version: row.version + 1,
            contacts: row.contacts.filter(
              contact => contact.key !== update.$pull.contacts.key
            ),
          });
          modifiedCount++;
        }
        if (modifiedCount) mockRevision++;
        return { modifiedCount };
      }
    ),
  },
}));
import CustomerContactReservation from "@/models/customer-contact-reservation";
import {
  evaluateContactWindow,
  partitionRecentlyContactedRecipients,
  releaseCampaignContactSlot,
  releaseCustomerMarketingContact,
  reserveCustomerMarketingContact,
} from "./customer-contact-policy";

// Counts keep the contact-window assertions short.
async function previewContactCounts(
  input: Parameters<typeof partitionRecentlyContactedRecipients>[0]
) {
  const result = await partitionRecentlyContactedRecipients(input);
  return {
    blockedRecipientCount: result.recentlyContacted.length,
    eligibleRecipientCount: result.allowed.length,
    nextEligibleAt: result.nextEligibleAt,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const flushAsyncReads = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  mockRows.clear();
  mockRevision = 0;
  mockSessions.length = 0;
  mockCommit.mockReset();
  jest.clearAllMocks();
  mockConsent.mockResolvedValue({
    skippedOptIn: 0,
    marketingOptInWarningCount: 0,
  });
  mockCustomer.mockResolvedValue(null);
  mockPolicyRead.mockResolvedValue(null);
  mockConversations.mockResolvedValue([]);
  mockCustomerAggregate.mockImplementation(async pipeline => {
    const customer = await mockCustomer();
    const phones = pipeline[0].$match.$or[0][
      "profileSummary.contactPoints.phones"
    ].$in as string[];
    return customer
      ? phones.map(phone => ({ _id: phone, customerId: customer._id }))
      : [];
  });
  mockReservationFind.mockImplementation(async scope =>
    [...mockRows.entries()]
      .filter(([identity]) => scope.identity.$in.includes(identity))
      .map(([identity, row]) => ({ identity, ...structuredClone(row) }))
  );
});

test("cooldown eligibility includes the weekly limit and admits its exact boundary", () => {
  const policy = { minIntervalHours: 24, maxPerWeek: 3 };
  const contacts = ["07", "08", "10", "11"].map(day => ({
    key: day,
    at: new Date(`2026-09-${day}T09:00:00Z`),
  }));
  expect(
    evaluateContactWindow(
      contacts,
      null,
      policy,
      new Date("2026-09-12T10:00:00Z")
    )
  ).toMatchObject({
    allowed: false,
    nextEligibleAt: new Date("2026-09-15T09:00:00Z"),
  });
  expect(
    evaluateContactWindow(
      contacts,
      null,
      policy,
      new Date("2026-09-15T09:00:00Z")
    )
  ).toMatchObject({ allowed: true, nextEligibleAt: null });
  expect(
    evaluateContactWindow([], null, { ...policy, maxPerWeek: 0 }, new Date())
  ).toMatchObject({ allowed: false, nextEligibleAt: null });
});

test("read-only retry preview shares phone and customer caps without consuming reservations", async () => {
  mockCustomer.mockResolvedValue({ _id: "customer" });
  const now = new Date("2026-09-15T10:55:29.411Z");
  await reserveCustomerMarketingContact({
    workspaceId: "w",
    phone: "77010000001",
    deliveryKey: "original-campaign",
    now,
  });
  const before = structuredClone([...mockRows.entries()]);
  const recipients = [{ phone: "+7 701 000 00 01" }, { phone: "77010000002" }];
  expect(
    await previewContactCounts({
      workspaceId: "w",
      recipients,
      now: new Date("2026-09-15T13:43:03Z"),
    })
  ).toEqual({
    blockedRecipientCount: 2,
    eligibleRecipientCount: 0,
    nextEligibleAt: "2026-09-16T10:55:29.411Z",
  });
  expect([...mockRows.entries()]).toEqual(before);
  expect(
    await previewContactCounts({
      workspaceId: "w",
      recipients,
      now: new Date("2026-09-16T10:55:29.411Z"),
    })
  ).toEqual({
    blockedRecipientCount: 0,
    eligibleRecipientCount: 2,
    nextEligibleAt: null,
  });
});

test("batch preview uses the latest blocked recipient time and bounded workspace-scoped reads", async () => {
  const now = new Date("2026-09-15T10:00:00Z");
  const recipients = Array.from({ length: 205 }, (_, index) => ({
    phone: `7701${String(index).padStart(7, "0")}`,
  }));
  await reserveCustomerMarketingContact({
    workspaceId: "w",
    ...recipients[0]!,
    deliveryKey: "a",
    now,
  });
  await reserveCustomerMarketingContact({
    workspaceId: "w",
    ...recipients[1]!,
    deliveryKey: "b",
    now: new Date("2026-09-15T11:00:00Z"),
  });
  mockCustomerAggregate.mockClear();
  expect(
    await previewContactCounts({
      workspaceId: "w",
      recipients,
      now,
    })
  ).toEqual({
    blockedRecipientCount: 2,
    eligibleRecipientCount: 203,
    nextEligibleAt: "2026-09-16T11:00:00.000Z",
  });
  expect(mockCustomerAggregate).toHaveBeenCalledTimes(3);
  expect(mockReservationFind).toHaveBeenCalledTimes(3);
  for (const [scope] of mockReservationFind.mock.calls) {
    expect(scope.workspaceId).toBe("w");
    expect(scope.identity.$in.length).toBeLessThanOrEqual(200);
  }
  const pipeline = mockCustomerAggregate.mock.calls[0]![0];
  expect(pipeline[0].$match).toMatchObject({
    workspaceId: "w",
    status: "active",
  });
  expect(pipeline[1]).toEqual({ $sort: { _id: 1 } });
  expect(pipeline.at(-1)).toEqual({
    $group: { _id: "$matchingPhones", customerId: { $first: "$_id" } },
  });
});

test("preview runs at most four chunks together and combines out-of-order results without reserving", async () => {
  const now = new Date("2026-09-15T10:00:00Z");
  const recipients = Array.from({ length: 505 }, (_, index) => ({
    phone: `7701${String(index).padStart(7, "0")}`,
  }));
  for (const index of [0, 400]) {
    await reserveCustomerMarketingContact({
      workspaceId: "w",
      ...recipients[index]!,
      deliveryKey: `original-${index}`,
      now: new Date(now.getTime() + index * 60_000),
    });
  }
  const before = structuredClone([...mockRows.entries()]);
  jest.mocked(CustomerContactReservation.updateOne).mockClear();
  const gates = Array.from({ length: 6 }, () => deferred<[]>());
  let started = 0;
  let active = 0;
  let peakActive = 0;
  mockCustomerAggregate.mockImplementation(() => {
    active++;
    peakActive = Math.max(peakActive, active);
    return gates[started++]!.promise.finally(() => active--);
  });
  const preview = previewContactCounts({
    workspaceId: "w",
    recipients,
    now,
  });
  try {
    await flushAsyncReads();
    expect(started).toBe(4);
    expect(mockReservationFind).not.toHaveBeenCalled();
    for (const index of [3, 1, 2]) gates[index]!.resolve([]);
    await flushAsyncReads();
    expect(mockReservationFind).toHaveBeenCalledTimes(3);
    expect(started).toBe(4);
    gates[0]!.resolve([]);
    await flushAsyncReads();
    expect(started).toBe(6);
    for (const index of [5, 4]) gates[index]!.resolve([]);
    await expect(preview).resolves.toEqual({
      blockedRecipientCount: 2,
      eligibleRecipientCount: 503,
      nextEligibleAt: "2026-09-16T16:40:00.000Z",
    });
    expect(peakActive).toBe(4);
    expect(mockPolicyRead).toHaveBeenCalledTimes(3); // Two sends and one preview.
    expect([...mockRows.entries()]).toEqual(before);
    expect(CustomerContactReservation.updateOne).not.toHaveBeenCalled();
  } finally {
    for (const gate of gates) gate.resolve([]);
    await preview;
  }
});

test.each(["identity", "reservation"] as const)(
  "a failed %s read stops later preview waves without reserving",
  async read => {
    const gates = Array.from({ length: 10 }, () => deferred<[]>());
    const readMock =
      read === "identity" ? mockCustomerAggregate : mockReservationFind;
    let started = 0;
    readMock.mockImplementation(() => gates[started++]!.promise);
    const failure = new Error(`${read} read unavailable`);
    const preview = previewContactCounts({
      workspaceId: "w",
      recipients: Array.from({ length: 905 }, (_, index) => ({
        phone: `7701${String(index).padStart(7, "0")}`,
      })),
    }).catch(error => error);
    try {
      await flushAsyncReads();
      expect(started).toBe(4);
      gates[1]!.reject(failure);
      for (const index of [0, 2, 3]) gates[index]!.resolve([]);
      await expect(preview).resolves.toBe(failure);
      await flushAsyncReads();
      expect(started).toBe(4);
      expect(CustomerContactReservation.updateOne).not.toHaveBeenCalled();
      expect(mockRows.size).toBe(0);
    } finally {
      for (const gate of gates) gate.resolve([]);
      await preview;
    }
  }
);

test("conversation customer takes precedence and phone aliases choose the first customer deterministically", async () => {
  mockCustomer.mockResolvedValue({ _id: "a-customer" });
  const now = new Date("2026-09-15T10:00:00Z");
  await reserveCustomerMarketingContact({
    workspaceId: "w",
    phone: "77010000001",
    deliveryKey: "original",
    now,
  });
  mockCustomerAggregate.mockResolvedValue([
    { _id: "77010000002", customerId: "z-customer" },
    { _id: "+77010000002", customerId: "a-customer" },
  ]);
  mockConversations.mockResolvedValue([
    { _id: "conversation", customerId: "a-customer" },
  ]);
  expect(
    await previewContactCounts({
      workspaceId: "w",
      recipients: [
        { phone: "77010000002" },
        { phone: "77010000003", conversationId: "conversation" },
      ],
      now,
    })
  ).toMatchObject({ blockedRecipientCount: 2, eligibleRecipientCount: 0 });
  expect(mockConversations).toHaveBeenCalledWith({
    workspaceId: "w",
    _id: { $in: ["conversation"] },
  });
  const aliases =
    mockCustomerAggregate.mock.calls.at(-1)![0][0].$match.$or[0][
      "profileSummary.contactPoints.phones"
    ].$in;
  expect(aliases).toEqual(["77010000002", "+77010000002"]);
});

test("partition keeps input order and the caller's recipients and reads nothing for an empty list", async () => {
  await reserveCustomerMarketingContact({
    workspaceId: "w",
    phone: "77010000002",
    deliveryKey: "earlier-campaign",
    now: new Date("2026-09-15T10:00:00Z"),
  });
  const recipients = [
    { phone: "77010000001", row: 1 },
    { phone: "77010000002", row: 2 },
    { phone: "77010000003", row: 3 },
  ];
  const result = await partitionRecentlyContactedRecipients({
    workspaceId: "w",
    recipients,
    now: new Date("2026-09-15T12:00:00Z"),
  });
  expect(result.allowed).toEqual([recipients[0], recipients[2]]);
  expect(result.allowed[0]).toBe(recipients[0]);
  expect(result.recentlyContacted).toEqual([recipients[1]]);
  expect(result.nextEligibleAt).toBe("2026-09-16T10:00:00.000Z");

  mockCustomerAggregate.mockClear();
  mockReservationFind.mockClear();
  await expect(
    partitionRecentlyContactedRecipients({ workspaceId: "w", recipients: [] })
  ).resolves.toEqual({
    allowed: [],
    recentlyContacted: [],
    nextEligibleAt: null,
  });
  expect(mockCustomerAggregate).not.toHaveBeenCalled();
  expect(mockReservationFind).not.toHaveBeenCalled();
});

test("competing campaigns share a rolling window; retry identity does not consume another slot", () => {
  const now = new Date("2026-09-12T10:00:00Z");
  const policy = { minIntervalHours: 24, maxPerWeek: 3 };
  const recent = [{ key: "campaign-a", at: new Date("2026-09-12T09:00:00Z") }];
  expect(evaluateContactWindow(recent, "journey-b", policy, now).allowed).toBe(
    false
  );
  expect(
    evaluateContactWindow(recent, "campaign-a", policy, now)
  ).toMatchObject({ allowed: true, duplicate: true });
  const week = ["07", "08", "10"].map(day => ({
    key: day,
    at: new Date(`2026-09-${day}T09:00:00Z`),
  }));
  expect(evaluateContactWindow(week, "journey", policy, now).allowed).toBe(
    false
  );
  expect(
    evaluateContactWindow(
      [{ key: "old", at: new Date("2026-09-11T10:00:00Z") }],
      "new",
      policy,
      now
    ).allowed
  ).toBe(true);
});

test("concurrent campaign reservations admit only one different delivery", async () => {
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      reserveCustomerMarketingContact({
        workspaceId: "w",
        phone: "77010000001",
        deliveryKey: `campaign-${i}`,
        now: new Date("2026-09-12T10:00:00Z"),
      })
    )
  );
  expect(results.filter(result => result === null)).toHaveLength(1);
  expect([...mockRows.values()][0]?.contacts).toHaveLength(1);
});
test("a retry retains its slot and a customer's other phone shares the cap", async () => {
  mockCustomer.mockResolvedValue({ _id: "customer" });
  const input = {
    workspaceId: "w",
    phone: "77010000001",
    deliveryKey: "campaign",
    now: new Date("2026-09-12T10:00:00Z"),
  };
  expect(await reserveCustomerMarketingContact(input)).toBeNull();
  expect(await reserveCustomerMarketingContact(input)).toBeNull();
  expect(
    await reserveCustomerMarketingContact({
      ...input,
      phone: "77010000002",
      deliveryKey: "journey",
    })
  ).toBe("contact_frequency_limit");
});
test("a customer's rejected second phone consumes no slot or later cooldown", async () => {
  mockCustomer.mockResolvedValue({ _id: "customer" });
  const input = {
    workspaceId: "w",
    phone: "77010000001",
    deliveryKey: "accepted",
    now: new Date("2026-09-18T10:00:00Z"),
  };
  expect(await reserveCustomerMarketingContact(input)).toBeNull();
  const before = structuredClone([...mockRows.entries()]);
  expect(
    await reserveCustomerMarketingContact({
      ...input,
      phone: "77010000002",
      deliveryKey: "rejected",
      now: new Date("2026-09-18T11:00:00Z"),
    })
  ).toBe("contact_frequency_limit");
  expect([...mockRows.entries()]).toEqual(before);
  await expect(
    previewContactCounts({
      workspaceId: "w",
      recipients: [{ phone: "77010000002" }],
      now: new Date("2026-09-19T10:01:00Z"),
    })
  ).resolves.toEqual({
    blockedRecipientCount: 0,
    eligibleRecipientCount: 1,
    nextEligibleAt: null,
  });
});

test("phone and customer contacts commit together with majority durability", async () => {
  mockCustomer.mockResolvedValue({ _id: "customer" });
  await expect(
    reserveCustomerMarketingContact({
      workspaceId: "w",
      phone: "77010000001",
      deliveryKey: "campaign",
    })
  ).resolves.toBeNull();
  expect(mockRows.size).toBe(2);
  expect(mockSessions).toHaveLength(1);
  const session = mockSessions[0]!;
  expect(session.withTransaction).toHaveBeenCalledWith(expect.any(Function), {
    readPreference: "primary",
    readConcern: { level: "snapshot" },
    writeConcern: { w: "majority" },
  });
  const writes = jest.mocked(CustomerContactReservation.updateOne).mock.calls;
  for (let index = 0; index < writes.length; index++)
    expect(CustomerContactReservation.updateOne).toHaveBeenNthCalledWith(
      index + 1,
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ session })
    );
  expect(session.endSession).toHaveBeenCalledTimes(1);
});

test("a second identity write failure aborts all contacts without changing accepted slots", async () => {
  mockCustomer.mockResolvedValue({ _id: "customer" });
  const input = {
    workspaceId: "w",
    phone: "77010000001",
    deliveryKey: "accepted",
    now: new Date("2026-09-18T10:00:00Z"),
  };
  await reserveCustomerMarketingContact(input);
  const before = structuredClone([...mockRows.entries()]);
  const update = jest.mocked(CustomerContactReservation.updateOne);
  const write = update.getMockImplementation()!;
  const failure = new Error("Connection lost during second identity write");
  update.mockImplementationOnce(write).mockRejectedValueOnce(failure);
  await expect(
    reserveCustomerMarketingContact({
      ...input,
      phone: "77010000002",
      deliveryKey: "never-sent",
      now: new Date("2026-09-19T10:00:00Z"),
    })
  ).rejects.toBe(failure);
  expect([...mockRows.entries()]).toEqual(before);
  expect(mockSessions.at(-1)!.endSession).toHaveBeenCalledTimes(1);
});

test.each(["duplicate insert", "CAS conflict"] as const)(
  "%s aborts the complete attempt before retrying the same delivery",
  async conflict => {
    mockCustomer.mockResolvedValue({ _id: "customer" });
    const input = {
      workspaceId: "w",
      phone: "77010000001",
      deliveryKey: "campaign",
      now: new Date("2026-09-18T10:00:00Z"),
    };
    const previous = {
      key: "previously-accepted",
      at: new Date("2026-09-17T10:00:00Z"),
    };
    if (conflict === "CAS conflict")
      await reserveCustomerMarketingContact({
        ...input,
        deliveryKey: previous.key,
        now: previous.at,
      });
    const update = jest.mocked(CustomerContactReservation.updateOne);
    const write = update.getMockImplementation()!;
    update.mockImplementationOnce(write);
    if (conflict === "duplicate insert")
      update.mockRejectedValueOnce(
        Object.assign(new Error("E11000"), { code: 11000 })
      );
    else update.mockResolvedValueOnce(noWriteResult);
    await expect(reserveCustomerMarketingContact(input)).resolves.toBeNull();
    expect(mockSessions.at(-1)!.withTransaction).toHaveBeenCalledTimes(2);
    expect(mockRows.size).toBe(2);
    for (const row of mockRows.values()) {
      expect(row.version).toBe(conflict === "CAS conflict" ? 2 : 1);
      expect(row.contacts).toEqual([
        ...(conflict === "CAS conflict" ? [previous] : []),
        { key: input.deliveryKey, at: input.now },
      ]);
    }
    const before = structuredClone([...mockRows.entries()]);
    await expect(reserveCustomerMarketingContact(input)).resolves.toBeNull();
    expect([...mockRows.entries()]).toEqual(before);
  }
);

test("exhausted contention returns busy without leaving a partial reservation", async () => {
  mockCustomer.mockResolvedValue({ _id: "customer" });
  const update = jest.mocked(CustomerContactReservation.updateOne);
  const write = update.getMockImplementation()!;
  for (let attempt = 0; attempt < 5; attempt++)
    update
      .mockImplementationOnce(write)
      .mockResolvedValueOnce(noWriteResult);
  await expect(
    reserveCustomerMarketingContact({
      workspaceId: "w",
      phone: "77010000001",
      deliveryKey: "busy",
    })
  ).resolves.toBe("contact_reservation_busy");
  expect(mockSessions[0]!.withTransaction).toHaveBeenCalledTimes(5);
  expect(mockRows.size).toBe(0);
});

test("uncertain commit fails closed and retains committed contacts for an idempotent retry", async () => {
  mockCustomer.mockResolvedValue({ _id: "customer" });
  const failure = new Error("UnknownTransactionCommitResult");
  mockCommit.mockRejectedValueOnce(failure);
  const input = {
    workspaceId: "w",
    phone: "77010000001",
    deliveryKey: "uncertain",
  };
  await expect(reserveCustomerMarketingContact(input)).rejects.toBe(failure);
  expect(mockRows.size).toBe(2);
  const before = structuredClone([...mockRows.entries()]);
  expect(mockSessions[0]!.withTransaction).toHaveBeenCalledTimes(1);
  expect(mockSessions[0]!.endSession).toHaveBeenCalledTimes(1);
  await expect(reserveCustomerMarketingContact(input)).resolves.toBeNull();
  expect([...mockRows.entries()]).toEqual(before);
});

test("concurrent different phones for one customer admit one delivery without orphan contacts", async () => {
  mockCustomer.mockResolvedValue({ _id: "customer" });
  const results = await Promise.all(
    ["77010000001", "77010000002"].map((phone, index) =>
      reserveCustomerMarketingContact({
        workspaceId: "w",
        phone,
        deliveryKey: `campaign-${index}`,
      })
    )
  );
  expect(results.sort()).toEqual(["contact_frequency_limit", null].sort());
  expect(mockRows.size).toBe(2);
  expect(
    new Set(
      [...mockRows.values()].flatMap(row =>
        row.contacts.map(contact => contact.key)
      )
    ).size
  ).toBe(1);
});
test.each(["identity", "policy"] as const)(
  "reservation reads start together and wait for %s before writing",
  async pendingRead => {
    const identity = deferred<[]>();
    const policy = deferred<null>();
    mockCustomerAggregate.mockReturnValue(identity.promise);
    mockPolicyRead.mockReturnValue(policy.promise);
    const reservation = reserveCustomerMarketingContact({
      workspaceId: "w",
      phone: "77010000001",
      deliveryKey: "campaign",
    });
    try {
      await flushAsyncReads();
      expect(mockCustomerAggregate).toHaveBeenCalledTimes(1);
      expect(mockPolicyRead).toHaveBeenCalledTimes(1);
      expect(CustomerContactReservation.updateOne).not.toHaveBeenCalled();
      if (pendingRead === "identity") policy.resolve(null);
      else identity.resolve([]);
      await flushAsyncReads();
      expect(CustomerContactReservation.updateOne).not.toHaveBeenCalled();
      identity.resolve([]);
      policy.resolve(null);
      await expect(reservation).resolves.toBeNull();
      expect([...mockRows.values()][0]?.contacts).toHaveLength(1);
    } finally {
      identity.resolve([]);
      policy.resolve(null);
      await reservation;
    }
  }
);

test.each(["identity", "policy"] as const)(
  "a failed %s prerequisite prevents all reservation writes",
  async failedRead => {
    const identity = deferred<[]>();
    const policy = deferred<null>();
    mockCustomerAggregate.mockReturnValue(identity.promise);
    mockPolicyRead.mockReturnValue(policy.promise);
    const failure = new Error(`${failedRead} read unavailable`);
    const reservation = reserveCustomerMarketingContact({
      workspaceId: "w",
      phone: "77010000001",
      deliveryKey: "campaign",
    }).catch(error => error);
    try {
      await flushAsyncReads();
      expect(mockCustomerAggregate).toHaveBeenCalledTimes(1);
      expect(mockPolicyRead).toHaveBeenCalledTimes(1);
      if (failedRead === "identity") identity.reject(failure);
      else policy.reject(failure);
      await expect(reservation).resolves.toBe(failure);
      identity.resolve([]);
      policy.resolve(null);
      await flushAsyncReads();
      expect(CustomerContactReservation.updateOne).not.toHaveBeenCalled();
      expect(mockRows.size).toBe(0);
    } finally {
      identity.resolve([]);
      policy.resolve(null);
      await reservation;
    }
  }
);

test("new automatic journeys require positive consent and withdrawals always stop", async () => {
  mockConsent.mockResolvedValueOnce({
    skippedOptIn: 0,
    marketingOptInWarningCount: 1,
  });
  expect(
    await reserveCustomerMarketingContact({
      workspaceId: "w",
      phone: "77010000001",
      deliveryKey: "journey",
      requireConsent: true,
    })
  ).toBe("marketing_consent_required");
  mockConsent.mockResolvedValueOnce({
    skippedOptIn: 1,
    marketingOptInWarningCount: 0,
  });
  expect(
    await reserveCustomerMarketingContact({
      workspaceId: "w",
      phone: "77010000001",
      deliveryKey: "campaign",
    })
  ).toBe("marketing_opt_out");
  expect(mockCustomerAggregate).not.toHaveBeenCalled();
  expect(mockConversations).not.toHaveBeenCalled();
  expect(mockPolicyRead).not.toHaveBeenCalled();
  expect(CustomerContactReservation.updateOne).not.toHaveBeenCalled();
  expect(mockRows.size).toBe(0);
});

test("a slot Meta did not deliver no longer blocks the retry campaign", async () => {
  mockCustomer.mockResolvedValue({ _id: "customer" });
  const sentAt = new Date("2026-09-15T10:55:00Z");
  const retryAt = new Date("2026-09-15T11:26:00Z");
  expect(
    await reserveCustomerMarketingContact({
      workspaceId: "w",
      phone: "77010000001",
      deliveryKey: "campaign:source:77010000001",
      now: sentAt,
    })
  ).toBeNull();
  expect(
    await reserveCustomerMarketingContact({
      workspaceId: "w",
      phone: "+7 701 000 00 01",
      deliveryKey: "campaign:retry:77010000001",
      now: retryAt,
    })
  ).toBe("contact_frequency_limit");

  // Both the phone and the customer identity hold the source slot.
  expect(
    await releaseCustomerMarketingContact({
      workspaceId: "w",
      phone: "+77010000001",
      deliveryKey: "campaign:source:77010000001",
    })
  ).toBe(2);
  expect(
    await reserveCustomerMarketingContact({
      workspaceId: "w",
      phone: "77010000001",
      deliveryKey: "campaign:retry:77010000001",
      now: retryAt,
    })
  ).toBeNull();
  expect(
    [...mockRows.values()].map(row => row.contacts.map(contact => contact.key))
  ).toEqual([["campaign:retry:77010000001"], ["campaign:retry:77010000001"]]);
});

test("releasing a slot leaves every other contact of that customer counted", async () => {
  mockPolicyRead.mockResolvedValue({ minIntervalHours: 1, maxPerWeek: 3 });
  for (const [deliveryKey, hour] of [
    ["first", "08"],
    ["second", "10"],
  ] as const)
    expect(
      await reserveCustomerMarketingContact({
        workspaceId: "w",
        phone: "77010000001",
        deliveryKey,
        now: new Date(`2026-09-15T${hour}:00:00Z`),
      })
    ).toBeNull();

  expect(
    await releaseCustomerMarketingContact({
      workspaceId: "w",
      phone: "77010000001",
      deliveryKey: "first",
    })
  ).toBe(1);
  expect(
    await releaseCustomerMarketingContact({
      workspaceId: "w",
      phone: "77010000001",
      deliveryKey: "first",
    })
  ).toBe(0);
  expect(
    [...mockRows.values()].map(row => row.contacts.map(contact => contact.key))
  ).toEqual([["second"]]);
  expect(
    await reserveCustomerMarketingContact({
      workspaceId: "w",
      phone: "77010000001",
      deliveryKey: "third",
      now: new Date("2026-09-15T10:30:00Z"),
    })
  ).toBe("contact_frequency_limit");
});

test("a campaign status releases the bulk recipient key or its task key", async () => {
  mockPolicyRead.mockResolvedValue({ minIntervalHours: 1, maxPerWeek: 3 });
  for (const [deliveryKey, hour] of [
    ["campaign:campaign-1:77010000001", "08"],
    ["campaign-task:task-1", "10"],
  ] as const)
    expect(
      await reserveCustomerMarketingContact({
        workspaceId: "w",
        phone: "77010000001",
        deliveryKey,
        now: new Date(`2026-09-15T${hour}:00:00Z`),
      })
    ).toBeNull();

  expect(
    await releaseCampaignContactSlot({
      workspaceId: "w",
      campaignId: "campaign-1",
      phone: "+7 701 000 00 01",
    })
  ).toBe(1);
  expect(
    await releaseCampaignContactSlot({
      workspaceId: "w",
      campaignId: "campaign-2",
      taskId: "task-1",
      phone: "77010000001",
    })
  ).toBe(1);
  expect([...mockRows.values()].map(row => row.contacts)).toEqual([[]]);
  expect(
    await releaseCampaignContactSlot({
      workspaceId: "w",
      campaignId: "campaign-1",
      phone: "KZ.not-a-phone",
    })
  ).toBe(0);
});

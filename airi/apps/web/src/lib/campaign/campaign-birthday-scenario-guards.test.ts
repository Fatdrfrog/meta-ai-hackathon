const mockScenarioFind = jest.fn();
const mockStartSession = jest.fn();
const mockSettingsUpdateOne = jest.fn();
const mockSettingsCreateIndex = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args) },
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    find: (...args: unknown[]) => mockScenarioFind(...args),
    startSession: (...args: unknown[]) => mockStartSession(...args),
  },
}));

jest.mock("@/models/workspace-airi-settings", () => ({
  __esModule: true,
  default: {
    startSession: (...args: unknown[]) => mockStartSession(...args),
    updateOne: (...args: unknown[]) => mockSettingsUpdateOne(...args),
    collection: {
      createIndex: (...args: unknown[]) => mockSettingsCreateIndex(...args),
    },
  },
}));

import {
  BirthdayScenarioConflictError,
  findActiveBirthdayScenarioConflict,
  scenarioHasBirthdayBulkSchedule,
  withBirthdayScenarioWriteFence,
} from "./campaign-birthday-scenario-guards";
import type { ClientSession } from "mongoose";

function leanQuery<T>(value: T) {
  const query = {
    select: jest.fn(),
    session: jest.fn(),
    lean: jest.fn().mockResolvedValue(value),
  };
  query.select.mockReturnValue(query);
  query.session.mockReturnValue(query);
  return query;
}

function birthdayScenario(id = "scenario-1") {
  return {
    _id: id,
    workspaceId: "workspace-1",
    mode: "bulk_campaign",
    status: "active",
    nodes: [
      {
        id: "bulk-root",
        data: {
          kind: "bulk",
          bulkRootConfig: {
            recipientAudienceSource: "customer_birthdays",
            birthdayConfig: { version: 1, leapDayPolicy: "feb_28" },
            scheduleConfig: {
              version: 2,
              mode: "recurring",
              timezone: "UTC",
              recurrence: { kind: "daily", time: "09:00" },
            },
          },
        },
      },
      {
        id: "template-1",
        data: {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "birthday_offer",
          actionWhatsAppTemplateLanguage: "en",
        },
      },
    ],
    edges: [
      {
        source: "bulk-root",
        sourceHandle: "right-source",
        target: "template-1",
      },
    ],
  };
}

function telegramBirthdayScenario(
  id = "telegram-scenario",
  sourceId = "source-1"
) {
  const scenario = birthdayScenario(id);
  const bulkRootConfig = scenario.nodes[0]!.data
    .bulkRootConfig as (typeof scenario.nodes)[0]["data"]["bulkRootConfig"] & {
    telegramSubscriberSourceId?: string;
  };
  bulkRootConfig.telegramSubscriberSourceId = sourceId;
  scenario.nodes[1]!.data = {
    kind: "action",
    actionType: "reply",
    actionReplyChannel: "telegram",
    actionReplyMode: "fixed",
    actionReplyText: "Happy birthday {{name}}",
  } as unknown as (typeof scenario.nodes)[1]["data"];
  return scenario;
}

/** The builder keeps Scenario.mode "conversation" on a bulk-campaign root. */
function builderBirthdayScenario(id = "scenario-1") {
  const scenario = { ...birthdayScenario(id), mode: "conversation" };
  (
    scenario.nodes[0]!.data.bulkRootConfig as Record<string, unknown>
  ).workflowKind = "bulk_campaign";
  return scenario;
}

function telegramBuilderBirthdayScenario(
  id = "telegram-builder",
  sourceId = "source-1"
) {
  const scenario = {
    ...telegramBirthdayScenario(id, sourceId),
    mode: "conversation",
  };
  (
    scenario.nodes[0]!.data.bulkRootConfig as Record<string, unknown>
  ).workflowKind = "bulk_campaign";
  return scenario;
}

describe("campaign birthday scenario guards", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("detects birthday bulk schedules through the connected template", () => {
    expect(scenarioHasBirthdayBulkSchedule(birthdayScenario())).toBe(true);
    expect(scenarioHasBirthdayBulkSchedule(builderBirthdayScenario())).toBe(
      true
    );
    expect(
      scenarioHasBirthdayBulkSchedule(telegramBuilderBirthdayScenario())
    ).toBe(true);
  });

  it("ignores builder nodes that would not get a schedule", () => {
    const withoutWorkflowKind = {
      ...birthdayScenario(),
      mode: "conversation",
    };
    const weekly = builderBirthdayScenario();
    (
      weekly.nodes[0]!.data.bulkRootConfig as Record<string, unknown>
    ).scheduleConfig = {
      version: 2,
      mode: "recurring",
      timezone: "UTC",
      recurrence: { kind: "weekly", weekdays: ["monday"], time: "09:00" },
    };
    const birthdayLookingAction = {
      _id: "scenario-1",
      mode: "conversation",
      status: "active",
      nodes: [
        {
          id: "action-1",
          data: {
            kind: "action",
            channel: "whatsapp",
            audienceFilter: "birthday",
            targetingMode: "dynamic",
          },
        },
      ],
      edges: [],
    };

    for (const scenario of [
      withoutWorkflowKind,
      weekly,
      birthdayLookingAction,
    ]) {
      expect(scenarioHasBirthdayBulkSchedule(scenario)).toBe(false);
    }
  });

  it("queries legacy scenarios and builder scenarios with a birthday root", async () => {
    mockScenarioFind.mockReturnValue(leanQuery([]));

    await findActiveBirthdayScenarioConflict({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      scenario: builderBirthdayScenario("scenario-1"),
    });

    expect(mockScenarioFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      $or: [
        { mode: "bulk_campaign" },
        {
          nodes: {
            $elemMatch: {
              "data.kind": "bulk",
              "data.bulkRootConfig.workflowKind": "bulk_campaign",
              "data.bulkRootConfig.recipientAudienceSource":
                "customer_birthdays",
            },
          },
        },
      ],
      status: "active",
      deletedAt: null,
      _id: { $ne: "scenario-1" },
    });
  });

  it.each([
    ["builder", builderBirthdayScenario("scenario-2")],
    ["legacy", birthdayScenario("scenario-2")],
  ])(
    "blocks a builder birthday scenario when a %s one is already active",
    async (_label, activeScenario) => {
      mockScenarioFind.mockReturnValue(
        leanQuery([{ ...activeScenario, name: "Birthdays" }])
      );

      await expect(
        findActiveBirthdayScenarioConflict({
          workspaceId: "workspace-1",
          scenarioId: "scenario-1",
          scenario: builderBirthdayScenario("scenario-1"),
        })
      ).resolves.toEqual({ scenarioId: "scenario-2", name: "Birthdays" });
    }
  );

  it("blocks a legacy birthday scenario when a builder one is already active", async () => {
    mockScenarioFind.mockReturnValue(
      leanQuery([{ ...builderBirthdayScenario("scenario-2"), name: "Builder" }])
    );

    await expect(
      findActiveBirthdayScenarioConflict({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        scenario: birthdayScenario("scenario-1"),
      })
    ).resolves.toEqual({ scenarioId: "scenario-2", name: "Builder" });
  });

  it("treats two WhatsApp birthday roots in one builder scenario as a conflict", async () => {
    const scenario = builderBirthdayScenario("scenario-1");
    scenario.nodes.push(
      { ...scenario.nodes[0]!, id: "bulk-root-2" },
      { ...scenario.nodes[1]!, id: "template-2" }
    );
    scenario.edges.push({
      source: "bulk-root-2",
      sourceHandle: "right-source",
      target: "template-2",
    });

    await expect(
      findActiveBirthdayScenarioConflict({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        scenario: { ...scenario, name: "Two roots" },
      })
    ).resolves.toEqual({ scenarioId: "scenario-1", name: "Two roots" });
    expect(mockScenarioFind).not.toHaveBeenCalled();
  });

  it("finds an existing active birthday scenario conflict", async () => {
    mockScenarioFind.mockReturnValue(
      leanQuery([{ ...birthdayScenario("scenario-2"), name: "Birthdays" }])
    );

    await expect(
      findActiveBirthdayScenarioConflict({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        scenario: birthdayScenario("scenario-1"),
      })
    ).resolves.toEqual({
      scenarioId: "scenario-2",
      name: "Birthdays",
    });
  });

  it("does not query conflicts for draft or non-birthday scenarios", async () => {
    await expect(
      findActiveBirthdayScenarioConflict({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        scenario: { ...birthdayScenario("scenario-1"), status: "draft" },
      })
    ).resolves.toBeNull();

    expect(mockScenarioFind).not.toHaveBeenCalled();
  });

  it("allows WhatsApp and Telegram birthday campaigns to coexist", async () => {
    mockScenarioFind.mockReturnValue(
      leanQuery([telegramBirthdayScenario("telegram-scenario")])
    );

    await expect(
      findActiveBirthdayScenarioConflict({
        workspaceId: "workspace-1",
        scenarioId: "whatsapp-scenario",
        scenario: birthdayScenario("whatsapp-scenario"),
      })
    ).resolves.toBeNull();
  });

  it("conflicts only with a Telegram birthday campaign using the same bot", async () => {
    mockScenarioFind.mockReturnValue(
      leanQuery([
        telegramBirthdayScenario("other-bot", "source-2"),
        {
          ...telegramBirthdayScenario("same-bot", "source-1"),
          name: "Telegram birthdays",
        },
      ])
    );

    await expect(
      findActiveBirthdayScenarioConflict({
        workspaceId: "workspace-1",
        scenarioId: "incoming",
        scenario: telegramBirthdayScenario("incoming", "source-1"),
      })
    ).resolves.toEqual({
      scenarioId: "same-bot",
      name: "Telegram birthdays",
    });
  });

  it.each(["builder", "legacy"])(
    "blocks a Telegram builder when the same bot already has a %s birthday schedule",
    async kind => {
      const existing =
        kind === "builder"
          ? telegramBuilderBirthdayScenario("same-bot")
          : telegramBirthdayScenario("same-bot");
      mockScenarioFind.mockReturnValue(
        leanQuery([
          telegramBuilderBirthdayScenario("other-bot", "source-2"),
          { ...existing, name: "Telegram birthdays" },
        ])
      );
      await expect(
        findActiveBirthdayScenarioConflict({
          workspaceId: "workspace-1",
          scenarioId: "incoming",
          scenario: telegramBuilderBirthdayScenario("incoming"),
        })
      ).resolves.toEqual({
        scenarioId: "same-bot",
        name: "Telegram birthdays",
      });
    }
  );

  it.each([
    ["the same bot", "source-1", true],
    ["different bots", "source-2", false],
  ] as const)(
    "checks multiple Telegram birthday roots using %s",
    async (_label, secondSourceId, conflicts) => {
      const scenario = telegramBuilderBirthdayScenario("scenario-1");
      const second = telegramBuilderBirthdayScenario(
        "scenario-1",
        secondSourceId
      );
      scenario.nodes.push(
        { ...second.nodes[0]!, id: "bulk-root-2" },
        { ...second.nodes[1]!, id: "reply-2" }
      );
      scenario.edges.push({
        source: "bulk-root-2",
        sourceHandle: "right-source",
        target: "reply-2",
      });
      mockScenarioFind.mockReturnValue(leanQuery([]));
      const result = await findActiveBirthdayScenarioConflict({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        scenario,
      });
      expect(result).toEqual(
        conflicts ? { scenarioId: "scenario-1", name: null } : null
      );
      if (conflicts) expect(mockScenarioFind).not.toHaveBeenCalled();
    }
  );
});

describe("birthday scenario write fence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSettingsCreateIndex.mockResolvedValue("workspaceId_1");
    mockSettingsUpdateOne.mockResolvedValue({ matchedCount: 1 });
    mockScenarioFind.mockReturnValue(leanQuery([]));
  });

  function arrangeSession() {
    const session = {
      withTransaction: jest.fn(async callback => callback()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    mockStartSession.mockResolvedValue(session);
    return session;
  }

  it("holds a workspace write fence while reading conflicts and committing", async () => {
    const session = arrangeSession();
    const query = leanQuery([]);
    mockScenarioFind.mockReturnValue(query);
    const commit = jest.fn().mockResolvedValue("committed");

    await expect(
      withBirthdayScenarioWriteFence({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        scenario: builderBirthdayScenario(),
        commit,
      })
    ).resolves.toBe("committed");

    expect(mockSettingsUpdateOne).toHaveBeenCalledWith(
      { workspaceId: "workspace-1" },
      { $setOnInsert: { workspaceId: "workspace-1" } },
      { upsert: true, setDefaultsOnInsert: true, timestamps: false }
    );
    expect(mockSettingsUpdateOne).toHaveBeenCalledWith(
      { workspaceId: "workspace-1" },
      { $inc: { birthday_scenario_write_fence_version: 1 } },
      { session, timestamps: false }
    );
    expect(query.session).toHaveBeenCalledWith(session);
    expect(commit).toHaveBeenCalledWith(session);
    expect(mockSettingsUpdateOne.mock.invocationCallOrder.at(-1)).toBeLessThan(
      query.lean.mock.invocationCallOrder[0]!
    );
    expect(query.lean.mock.invocationCallOrder[0]).toBeLessThan(
      commit.mock.invocationCallOrder[0]!
    );
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  it("rechecks the winning activation after Mongo retries a concurrent transaction", async () => {
    const session = arrangeSession();
    const winner = builderBirthdayScenario("winner");
    session.withTransaction.mockImplementation(async callback => {
      await callback();
      // Mongo discards the first snapshot after a workspace write conflict.
      mockScenarioFind.mockReturnValue(leanQuery([winner]));
      return callback();
    });
    const commit = jest.fn().mockResolvedValue("uncommitted-first-attempt");

    await expect(
      withBirthdayScenarioWriteFence({
        workspaceId: "workspace-1",
        scenarioId: "loser",
        scenario: builderBirthdayScenario("loser"),
        commit,
      })
    ).rejects.toMatchObject({
      conflict: { scenarioId: "winner" },
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(mockScenarioFind).toHaveBeenCalledTimes(2);
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  it("serializes simultaneous activations so only one overlapping scenario commits", async () => {
    const active: ReturnType<typeof builderBirthdayScenario>[] = [];
    let fenceOwner: Promise<void> = Promise.resolve();
    const sessions: Array<{
      withTransaction: jest.Mock;
      endSession: jest.Mock;
      release?: () => void;
    }> = [];
    mockStartSession.mockImplementation(async () => {
      const session = {
        withTransaction: jest.fn(async callback => {
          try {
            return await callback();
          } finally {
            session.release?.();
          }
        }),
        endSession: jest.fn(),
        release: undefined as (() => void) | undefined,
      };
      sessions.push(session);
      return session;
    });
    mockSettingsUpdateOne.mockImplementation(
      async (_filter, _update, options) => {
        if (options.session) {
          const previous = fenceOwner;
          fenceOwner = new Promise<void>(resolve => {
            options.session.release = resolve;
          });
          await previous;
        }
        return { matchedCount: 1 };
      }
    );
    mockScenarioFind.mockImplementation(() => leanQuery([...active]));
    const activate = (id: string) => {
      const scenario = builderBirthdayScenario(id);
      return withBirthdayScenarioWriteFence({
        workspaceId: "workspace-1",
        scenarioId: id,
        scenario,
        commit: async (_session: ClientSession | undefined) => {
          active.push(scenario);
          return id;
        },
      });
    };

    const results = await Promise.allSettled([activate("a"), activate("b")]);
    expect(
      results.filter(result => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(active).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      BirthdayScenarioConflictError
    );
    expect(sessions).toHaveLength(2);
  });

  it("aborts the transaction and closes its session when commit fails", async () => {
    const session = arrangeSession();
    const failure = new Error("scenario revision changed");
    const commit = jest.fn().mockRejectedValue(failure);
    await expect(
      withBirthdayScenarioWriteFence({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        scenario: builderBirthdayScenario(),
        commit,
      })
    ).rejects.toBe(failure);
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  it("fails closed when its workspace owner cannot be written", async () => {
    const session = arrangeSession();
    mockSettingsUpdateOne
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const commit = jest.fn();
    await expect(
      withBirthdayScenarioWriteFence({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        scenario: builderBirthdayScenario(),
        commit,
      })
    ).rejects.toThrow("birthday workspace write fence");
    expect(commit).not.toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  it("leaves draft and nonbirthday writes on their existing commit path", async () => {
    const commit = jest.fn().mockResolvedValue("draft");
    await withBirthdayScenarioWriteFence({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      scenario: { ...builderBirthdayScenario(), status: "draft" },
      commit,
    });
    expect(commit).toHaveBeenCalledWith(undefined);
    expect(mockSettingsUpdateOne).not.toHaveBeenCalled();
    expect(mockStartSession).not.toHaveBeenCalled();
  });

  it("acknowledges a successful commit even if session cleanup fails", async () => {
    const session = arrangeSession();
    session.endSession.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(
      withBirthdayScenarioWriteFence({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        scenario: builderBirthdayScenario(),
        commit: async () => "committed",
      })
    ).resolves.toBe("committed");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "birthday.workspace_transaction_session_cleanup_failed",
      { workspaceId: "workspace-1", error: "cleanup failed" }
    );
  });

  it("preserves the transaction failure when session cleanup also fails", async () => {
    const session = arrangeSession();
    session.endSession.mockRejectedValueOnce(new Error("cleanup failed"));
    const failure = new Error("scenario commit failed");
    await expect(
      withBirthdayScenarioWriteFence({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        scenario: builderBirthdayScenario(),
        commit: async () => {
          throw failure;
        },
      })
    ).rejects.toBe(failure);
  });
});

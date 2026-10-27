import {
  CAMPAIGN_SCHEDULE_ACTION_WORKFLOW,
  CAMPAIGN_SCHEDULE_ACTION_WORKFLOW_CONTRACT_VERSION,
} from "@icecore/temporal";
import { Types } from "mongoose";

import {
  BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
  SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
  CAMPAIGN_BIRTHDAY_CONFIG_VERSION,
} from "@icecore/scenario-contracts";
import {
  buildTemporalScheduleOptionsForTest,
  reconcileCampaignScenarioSchedules,
  retireCampaignScenarioSchedules,
  resolveCampaignNodeScheduleDefinition,
} from "./campaign-node-schedules";

describe("campaign node schedules", () => {
  const scenario = {
    _id: "scenario-1",
    workspaceId: "workspace-1",
    mode: "bulk_campaign",
    status: "active",
    timezone: "Asia/Qyzylorda",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTemporalConfigured.mockReturnValue(true);
    mockCreateSchedule.mockResolvedValue(undefined);
  });

  function scheduleModel(records: Array<{ nodeId: string; status: string }>) {
    return {
      findOne: jest.fn(({ nodeId }: { nodeId?: unknown }) => ({
        lean: async () =>
          records.find(record => record.nodeId === nodeId) ?? null,
      })),
      find: jest.fn(() => ({
        lean: async () => records.filter(record => record.status !== "deleted"),
      })),
      findOneAndUpdate: jest.fn(
        (filter: Record<string, unknown>, update: Record<string, unknown>) => ({
          lean: async () => {
            const record = records.find(
              record => record.nodeId === filter.nodeId
            );
            if (record) Object.assign(record, update.$set);
            return record ?? null;
          },
        })
      ),
    };
  }

  const recurringNode = (id: string) => ({
    id,
    data: {
      channel: "whatsapp",
      scheduleConfig: {
        version: 2 as const,
        mode: "recurring" as const,
        timezone: "UTC",
        recurrence: { kind: "daily" as const, time: "09:30" },
      },
    },
  });

  it.each(["active", "draft"])(
    "rejects failed provider updates after reconciling other %s nodes",
    async status => {
      const model = scheduleModel([
        { nodeId: "failed", status: "active" },
        { nodeId: "healthy", status: "active" },
      ]);
      const failedUpdate = jest
        .fn()
        .mockRejectedValue(new Error("provider unavailable"));
      const healthyUpdate = jest.fn().mockResolvedValue(undefined);
      mockGetScheduleHandle.mockImplementation((id: string) => ({
        describe: async () => ({ state: { paused: false } }),
        update: id.endsWith(":failed") ? failedUpdate : healthyUpdate,
      }));

      await expect(
        reconcileCampaignScenarioSchedules(
          {
            ...scenario,
            status,
            nodes: [recurringNode("failed"), recurringNode("healthy")],
          },
          { model }
        )
      ).rejects.toMatchObject({
        name: "AggregateError",
        errors: [
          expect.objectContaining({
            message: expect.stringContaining("provider unavailable"),
          }),
        ],
      });
      expect(healthyUpdate).toHaveBeenCalledTimes(1);
      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: "failed" }),
        expect.objectContaining({
          $set: expect.objectContaining({
            status: "error",
            lastError: "provider unavailable",
          }),
        }),
        expect.any(Object)
      );
    }
  );

  it("rejects failed orphan deletion after a graph removes its scheduled node", async () => {
    const model = scheduleModel([{ nodeId: "orphan", status: "active" }]);
    mockGetScheduleHandle.mockReturnValue({
      describe: async () => ({ state: { paused: false } }),
      delete: async () => {
        throw new Error("delete unavailable");
      },
    });

    await expect(
      reconcileCampaignScenarioSchedules({ ...scenario, nodes: [] }, { model })
    ).rejects.toMatchObject({ name: "AggregateError" });
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "orphan" }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "error",
          lastError: "delete unavailable",
        }),
      }),
      expect.any(Object)
    );
  });

  it("retires persisted orphan schedules as well as nodes in the deleted graph", async () => {
    const model = scheduleModel([
      { nodeId: "current", status: "active" },
      { nodeId: "orphan", status: "error" },
    ]);
    const deleteSchedule = jest.fn().mockResolvedValue(undefined);
    mockGetScheduleHandle.mockReturnValue({
      describe: async () => ({ state: { paused: false } }),
      delete: deleteSchedule,
    });

    const result = await retireCampaignScenarioSchedules({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      nodes: [{ id: "current", data: {} }],
      model,
    });

    expect(result.map(item => item.scheduleId)).toEqual([
      "campaign-node:workspace-1:scenario-1:current",
      "campaign-node:workspace-1:scenario-1:orphan",
    ]);
    expect(deleteSchedule).toHaveBeenCalledTimes(2);
  });

  it("keeps failed unconfigured retirement discoverable for a later retry", async () => {
    const records = [{ nodeId: "scheduled", status: "active" }];
    const model = scheduleModel(records);
    mockIsTemporalConfigured.mockReturnValue(false);
    const input = {
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      model,
    };

    await expect(retireCampaignScenarioSchedules(input)).rejects.toMatchObject({
      name: "AggregateError",
    });
    expect(records[0].status).toBe("error");
    expect(mockGetScheduleHandle).not.toHaveBeenCalled();

    mockIsTemporalConfigured.mockReturnValue(true);
    mockGetScheduleHandle.mockReturnValue({
      describe: async () => ({ state: { paused: false } }),
      delete: async () => undefined,
    });
    await expect(retireCampaignScenarioSchedules(input)).resolves.toMatchObject(
      [{ ok: true, action: "deleted" }]
    );
    expect(records[0].status).toBe("deleted");
  });

  it("treats an already absent provider schedule as successful retirement", async () => {
    const model = scheduleModel([{ nodeId: "scheduled", status: "active" }]);
    mockGetScheduleHandle.mockReturnValue({
      describe: async () => {
        throw new Error("Schedule not found");
      },
    });
    await expect(
      retireCampaignScenarioSchedules({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        model,
      })
    ).resolves.toMatchObject([{ ok: true, action: "deleted" }]);
  });

  it("retires a scenario with no graph nodes and no records without a Temporal call", async () => {
    // Deleting any builder scenario retires from the stored records.
    const model = scheduleModel([]);

    await expect(
      retireCampaignScenarioSchedules({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        nodes: [],
        model,
      })
    ).resolves.toEqual([]);
    expect(model.find).toHaveBeenCalledTimes(1);
    expect(mockGetScheduleHandle).not.toHaveBeenCalled();
  });

  it("resolves v2 weekly configs into calendar schedule specs", () => {
    const desired = resolveCampaignNodeScheduleDefinition(
      {
        id: "node-1",
        data: {
          channel: "whatsapp",
          scheduleConfig: {
            version: 2,
            mode: "recurring",
            timezone: "Asia/Qyzylorda",
            recurrence: {
              kind: "weekly",
              weekdays: ["monday"],
              time: "15:30",
            },
          },
        },
      },
      scenario
    );

    expect(desired).toMatchObject({
      action: "upsert",
      scheduleId: "campaign-node:workspace-1:scenario-1:node-1",
      scheduleConfig: {
        mode: "recurring",
        recurrence: {
          kind: "weekly",
          weekdays: ["monday"],
          time: "15:30",
        },
      },
      scheduleSpec: {
        calendars: [
          {
            dayOfWeek: ["MONDAY"],
            hour: 15,
            minute: 30,
            second: 0,
          },
        ],
        timezone: "Asia/Qyzylorda",
      },
    });
    expect("cronExpression" in (desired as Record<string, unknown>)).toBe(
      false
    );
  });

  it("starts the schedule action workflow with durable policies", () => {
    const desired = resolveCampaignNodeScheduleDefinition(
      {
        id: "node-1",
        data: {
          channel: "email",
          scheduleConfig: {
            version: 2,
            mode: "recurring",
            timezone: "UTC",
            recurrence: {
              kind: "interval",
              every: 24,
              unit: "hours",
            },
          },
        },
      },
      { ...scenario, timezone: "UTC" }
    );

    expect(desired?.action).toBe("upsert");
    if (!desired || desired.action === "delete") {
      throw new Error("Expected an upsert schedule");
    }
    const options = buildTemporalScheduleOptionsForTest(desired);

    expect(options).toMatchObject({
      spec: {
        intervals: [{ every: 24 * 60 * 60 * 1000 }],
        timezone: "UTC",
      },
      action: {
        type: "startWorkflow",
        workflowType: CAMPAIGN_SCHEDULE_ACTION_WORKFLOW,
        args: [
          {
            contractVersion: CAMPAIGN_SCHEDULE_ACTION_WORKFLOW_CONTRACT_VERSION,
            workspaceId: "workspace-1",
            scenarioId: "scenario-1",
            nodeId: "node-1",
            scheduleId: "campaign-node:workspace-1:scenario-1:node-1",
          },
        ],
      },
      policies: {
        overlap: "BUFFER_ALL",
        catchupWindow: 24 * 60 * 60 * 1000,
        pauseOnFailure: true,
      },
    });
    expect(options.spec).not.toHaveProperty("cronExpressions");
  });

  it("resolves birthday bulk roots through the connected WhatsApp template", () => {
    const desired = resolveCampaignNodeScheduleDefinition(
      {
        id: "bulk-root",
        data: {
          kind: "bulk",
          bulkRootConfig: {
            recipientAudienceSource:
              SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
            birthdayConfig: {
              version: CAMPAIGN_BIRTHDAY_CONFIG_VERSION,
              leapDayPolicy: "feb_28",
            },
            scheduleConfig: {
              version: 2,
              mode: "recurring",
              timezone: "Asia/Qyzylorda",
              recurrence: {
                kind: "daily",
                time: "09:30",
              },
            },
          },
        },
      },
      {
        ...scenario,
        nodes: [
          {
            id: "bulk-root",
            data: {
              kind: "bulk",
              bulkRootConfig: {
                recipientAudienceSource:
                  SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
                birthdayConfig: {
                  version: CAMPAIGN_BIRTHDAY_CONFIG_VERSION,
                  leapDayPolicy: "feb_28",
                },
                scheduleConfig: {
                  version: 2,
                  mode: "recurring",
                  timezone: "Asia/Qyzylorda",
                  recurrence: {
                    kind: "daily",
                    time: "09:30",
                  },
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
              generatedTemplateDraft: {
                category: "MARKETING",
                components: [{ type: "BODY", text: "Happy birthday {{name}}" }],
              },
            },
          },
        ],
        edges: [
          {
            source: "bulk-root",
            sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
            target: "template-1",
          },
        ],
      }
    );

    expect(desired).toMatchObject({
      action: "upsert",
      nodeId: "bulk-root",
      scheduleConfig: {
        mode: "recurring",
        recurrence: {
          kind: "daily",
          time: "09:30",
        },
      },
      scheduleSpec: {
        calendars: [
          {
            hour: 9,
            minute: 30,
            second: 0,
          },
        ],
      },
    });
  });

  it("resolves birthday bulk roots through a connected fixed Telegram reply", () => {
    const birthdayConfig = {
      version: CAMPAIGN_BIRTHDAY_CONFIG_VERSION,
      leapDayPolicy: "feb_28" as const,
    };
    const scheduleConfig = {
      version: 2 as const,
      mode: "recurring" as const,
      timezone: "Asia/Qyzylorda",
      recurrence: { kind: "daily" as const, time: "10:15" },
    };
    const bulkRoot = {
      id: "bulk-root",
      data: {
        kind: "bulk",
        bulkRootConfig: {
          recipientAudienceSource:
            SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
          birthdayConfig,
          scheduleConfig,
          telegramSubscriberSourceId: "source-1",
          uploadedRecipients: [{ chatId: "123456", birthday: "23.07.1992" }],
        },
      },
    };
    const desired = resolveCampaignNodeScheduleDefinition(bulkRoot, {
      ...scenario,
      nodes: [
        bulkRoot,
        {
          id: "reply-1",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyChannel: "telegram",
            actionReplyMode: "fixed",
            actionReplyText: "Happy birthday {{name}}",
          },
        },
      ],
      edges: [
        {
          source: "bulk-root",
          sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
          target: "reply-1",
        },
      ],
    });

    expect(desired).toMatchObject({
      action: "upsert",
      nodeId: "bulk-root",
      scheduleConfig: {
        recurrence: { kind: "daily", time: "10:15" },
      },
    });
  });

  describe("builder scenarios", () => {
    // Production reads Scenario._id back as an ObjectId, and builder
    // campaigns keep Scenario.mode "conversation".
    const builderScenarioId = new Types.ObjectId();
    const builderScheduleId = (nodeId: string) =>
      `campaign-node:workspace-1:${builderScenarioId.toHexString()}:${nodeId}`;
    const dailyConfig = {
      version: 2,
      mode: "recurring",
      timezone: "Asia/Qyzylorda",
      recurrence: { kind: "daily", time: "09:30" },
    };
    const templateAction = {
      id: "template-1",
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "birthday_offer",
        actionWhatsAppTemplateLanguage: "en",
      },
    };
    const telegramReply = {
      id: "reply-1",
      data: {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "telegram",
        actionReplyMode: "fixed",
        actionReplyText: "Happy birthday {{name}}",
      },
    };

    function builderRoot(
      config: Record<string, unknown> = {},
      id = "bulk-root"
    ) {
      return {
        id,
        data: {
          kind: "bulk",
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            channels: ["whatsapp"],
            recipientAudienceSource:
              SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
            birthdayConfig: {
              version: CAMPAIGN_BIRTHDAY_CONFIG_VERSION,
              leapDayPolicy: "feb_28",
            },
            scheduleConfig: dailyConfig,
            ...config,
          },
        },
      };
    }

    function builderScenario(
      root: { id: string; data: Record<string, unknown> },
      target: { id: string; data: Record<string, unknown> } = templateAction,
      overrides: Record<string, unknown> = {}
    ) {
      return {
        _id: builderScenarioId,
        workspaceId: "workspace-1",
        mode: "conversation",
        status: "active",
        timezone: "UTC",
        nodes: [root, target],
        edges: [
          {
            source: root.id,
            sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
            target: target.id,
          },
        ],
        ...overrides,
      };
    }

    it("schedules an active daily WhatsApp birthday root", () => {
      const root = builderRoot();
      const desired = resolveCampaignNodeScheduleDefinition(
        root,
        builderScenario(root)
      );

      expect(desired).toMatchObject({
        action: "upsert",
        scenarioId: builderScenarioId.toHexString(),
        nodeId: "bulk-root",
        scheduleId: builderScheduleId("bulk-root"),
        scheduleConfig: dailyConfig,
        scheduleSpec: {
          calendars: [{ hour: 9, minute: 30, second: 0 }],
          timezone: "Asia/Qyzylorda",
        },
      });
    });

    it("pauses the birthday root schedule while the scenario is a draft", () => {
      const root = builderRoot();
      expect(
        resolveCampaignNodeScheduleDefinition(
          root,
          builderScenario(root, templateAction, { status: "draft" })
        )
      ).toMatchObject({ action: "pause", scheduleConfig: dailyConfig });
    });

    it.each([
      ["a trigger node", { id: "trigger-1", data: { kind: "trigger" } }],
      ["a template action", templateAction],
      ["a Telegram message action", telegramReply],
      [
        "a one-time uploaded-audience root",
        builderRoot({
          recipientAudienceSource: "uploaded",
          scheduleConfig: {
            version: 2,
            mode: "once",
            timezone: "UTC",
            startAt: "2099-01-01T09:00:00.000Z",
          },
        }),
      ],
      [
        "a recurring uploaded-audience root",
        builderRoot({ recipientAudienceSource: "uploaded" }),
      ],
      [
        "a follow-up workflow root",
        builderRoot({ workflowKind: "follow_up_workflow" }),
      ],
      [
        "a birthday root without a schedule config",
        builderRoot({ scheduleConfig: undefined }),
      ],
      [
        "a birthday root with a legacy schedule config",
        builderRoot({ scheduleConfig: { version: 1, mode: "recurring" } }),
      ],
      [
        "a birthday root with a weekly recurrence",
        builderRoot({
          scheduleConfig: {
            ...dailyConfig,
            recurrence: { kind: "weekly", weekdays: ["monday"], time: "09:30" },
          },
        }),
      ],
      [
        "a daily birthday root whose stored mode is not recurring",
        builderRoot({ scheduleConfig: { ...dailyConfig, mode: "repeating" } }),
      ],
    ])("deletes the schedule for %s", (_label, node) => {
      expect(
        resolveCampaignNodeScheduleDefinition(node, builderScenario(node))
      ).toEqual({
        action: "delete",
        workspaceId: "workspace-1",
        scenarioId: builderScenarioId.toHexString(),
        nodeId: node.id,
        scheduleId: builderScheduleId(node.id),
      });
    });

    it("schedules an active daily Telegram birthday root for its selected bot", () => {
      const root = builderRoot({
        channels: ["telegram"],
        telegramSubscriberSourceId: "source-1",
      });
      expect(
        resolveCampaignNodeScheduleDefinition(
          root,
          builderScenario(root, telegramReply)
        )
      ).toMatchObject({
        action: "upsert",
        nodeId: "bulk-root",
        scheduleConfig: dailyConfig,
        scheduleSpec: {
          calendars: [{ hour: 9, minute: 30, second: 0 }],
          timezone: "Asia/Qyzylorda",
        },
      });
    });

    it("pauses a Telegram birthday schedule when the scenario is a draft", () => {
      const root = builderRoot({
        channels: ["telegram"],
        telegramSubscriberSourceId: "source-1",
      });
      expect(
        resolveCampaignNodeScheduleDefinition(
          root,
          builderScenario(root, telegramReply, { status: "draft" })
        )
      ).toMatchObject({ action: "pause", nodeId: "bulk-root" });
    });

    it.each([
      ["missing bot", { telegramSubscriberSourceId: undefined }, telegramReply],
      [
        "wrong channel",
        { channels: ["whatsapp"], telegramSubscriberSourceId: "source-1" },
        telegramReply,
      ],
      [
        "AI reply",
        { telegramSubscriberSourceId: "source-1" },
        {
          ...telegramReply,
          data: { ...telegramReply.data, actionReplyMode: "ai" },
        },
      ],
    ])(
      "does not arm an invalid Telegram birthday root: %s",
      (_label, config, reply) => {
        const root = builderRoot({ channels: ["telegram"], ...config });
        expect(
          resolveCampaignNodeScheduleDefinition(
            root,
            builderScenario(root, reply)
          )
        ).toMatchObject({ action: "delete", nodeId: "bulk-root" });
      }
    );

    it("reconciles only the root and deletes stale records for other nodes", async () => {
      const model = scheduleModel([{ nodeId: "template-1", status: "active" }]);
      const deleteSchedule = jest.fn().mockResolvedValue(undefined);
      mockGetScheduleHandle.mockImplementation((id: string) => ({
        describe: async () => {
          if (id === builderScheduleId("bulk-root")) {
            throw new Error("Schedule not found");
          }
          return { state: { paused: false } };
        },
        delete: deleteSchedule,
      }));
      const root = builderRoot();

      const summary = await reconcileCampaignScenarioSchedules(
        builderScenario(root),
        { model }
      );

      expect(summary.reconciled).toEqual([
        expect.objectContaining({
          ok: true,
          action: "created",
          scheduleId: builderScheduleId("bulk-root"),
        }),
      ]);
      expect(summary.orphanedDeletes).toEqual([
        expect.objectContaining({
          ok: true,
          action: "deleted",
          scheduleId: builderScheduleId("template-1"),
        }),
      ]);
      expect(mockCreateSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ scheduleId: builderScheduleId("bulk-root") })
      );
      expect(mockGetScheduleHandle.mock.calls.map(([id]) => id)).toEqual([
        builderScheduleId("bulk-root"),
        builderScheduleId("template-1"),
      ]);
      expect(deleteSchedule).toHaveBeenCalledTimes(1);
    });
  });
});
const mockIsTemporalConfigured = jest.fn(() => true);
const mockGetScheduleHandle = jest.fn();
const mockCreateSchedule = jest.fn();

jest.mock("@/lib/temporal/client", () => ({
  isTemporalConfigured: () => mockIsTemporalConfigured(),
  getTemporalWebClientConfig: () => ({ taskQueue: "campaign-test-queue" }),
}));

jest.mock("@/lib/temporal/campaign-node-run-client", () => ({
  getTemporalScheduleClient: () => ({
    getHandle: (...args: unknown[]) => mockGetScheduleHandle(...args),
    create: (...args: unknown[]) => mockCreateSchedule(...args),
  }),
}));

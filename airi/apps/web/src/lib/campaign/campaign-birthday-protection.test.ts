const mockScenarioFind = jest.fn();

jest.mock("@/models/scenario", () => ({
  Scenario: {
    find: (...args: unknown[]) => mockScenarioFind(...args),
  },
}));

import { getBirthdayProtectionSummary } from "./campaign-birthday-protection";

function leanQuery<T>(value: T) {
  return {
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(value),
    }),
  };
}

function birthdayScenario() {
  return {
    _id: "scenario-1",
    name: "Birthday campaign",
    workspaceId: "workspace-1",
    mode: "bulk_campaign",
    status: "active",
    timezone: "UTC",
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
            uploadedRecipients: [
              { phone: "+15550000001", birthday: "2026-07-02" },
              { phone: "+15550000002", birthday: "2026-07-02" },
              { phone: "+15550000003", birthday: "2026-07-03" },
            ],
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
          actionWhatsAppTemplateComponents: [{ type: "BODY", text: "Hi" }],
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

function telegramBirthdayScenario() {
  const scenario = birthdayScenario();
  scenario._id = "telegram-scenario";
  const bulkRootConfig = scenario.nodes[0]!.data
    .bulkRootConfig as (typeof scenario.nodes)[0]["data"]["bulkRootConfig"] & {
    telegramSubscriberSourceId?: string;
  };
  bulkRootConfig.telegramSubscriberSourceId = "source-1";
  scenario.nodes[1]!.data = {
    kind: "action",
    actionType: "reply",
    actionReplyChannel: "telegram",
    actionReplyMode: "fixed",
    actionReplyText: "Happy birthday {{name}}",
  } as unknown as (typeof scenario.nodes)[1]["data"];
  return scenario;
}

describe("getBirthdayProtectionSummary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("protects today's uploaded birthday recipients from the regular send cap", async () => {
    mockScenarioFind.mockReturnValue(leanQuery([birthdayScenario()]));

    const summary = await getBirthdayProtectionSummary({
      workspaceId: "workspace-1",
      dailyLimit: 250,
      now: new Date("2026-07-02T09:00:00.000Z"),
    });

    expect(summary.active).toBe(true);
    expect(summary.protectedTodayCount).toBe(2);
    expect(summary.availableRecipientLimit).toBe(248);
    expect(summary.plan?.selectedRecipientCount).toBe(3);
  });

  it("caps the protected count at the daily recipient limit", async () => {
    mockScenarioFind.mockReturnValue(leanQuery([birthdayScenario()]));

    const summary = await getBirthdayProtectionSummary({
      workspaceId: "workspace-1",
      dailyLimit: 1,
      now: new Date("2026-07-02T09:00:00.000Z"),
    });

    expect(summary.protectedTodayCount).toBe(1);
    expect(summary.availableRecipientLimit).toBe(0);
  });

  it("protects recipients of an active builder birthday scenario", async () => {
    // The builder keeps Scenario.mode "conversation" on a campaign root.
    const scenario = { ...birthdayScenario(), mode: "conversation" };
    (
      scenario.nodes[0]!.data.bulkRootConfig as Record<string, unknown>
    ).workflowKind = "bulk_campaign";
    mockScenarioFind.mockReturnValue(leanQuery([scenario]));

    const summary = await getBirthdayProtectionSummary({
      workspaceId: "workspace-1",
      dailyLimit: 250,
      now: new Date("2026-07-02T09:00:00.000Z"),
    });

    expect(mockScenarioFind).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        $or: expect.arrayContaining([{ mode: "bulk_campaign" }]),
        status: "active",
        deletedAt: null,
      })
    );
    expect(summary).toMatchObject({
      active: true,
      scenarioId: "scenario-1",
      protectedTodayCount: 2,
      availableRecipientLimit: 248,
    });
  });

  it("counts only the daily root that a builder birthday scenario schedules", async () => {
    // A weekly birthday root is never scheduled, so its recipients placed
    // first must not decide today's protected count.
    const scenario = { ...birthdayScenario(), mode: "conversation" };
    const [dailyRoot, dailyTemplate] = scenario.nodes;
    const dailyConfig = dailyRoot!.data.bulkRootConfig as Record<
      string,
      unknown
    >;
    dailyConfig.workflowKind = "bulk_campaign";
    const weeklyRoot = {
      id: "weekly-root",
      data: {
        kind: "bulk",
        bulkRootConfig: {
          ...dailyConfig,
          scheduleConfig: {
            version: 2,
            mode: "recurring",
            timezone: "UTC",
            recurrence: { kind: "weekly", weekdays: ["monday"], time: "09:00" },
          },
          uploadedRecipients: [
            { phone: "+15550000011", birthday: "2026-07-02" },
            { phone: "+15550000012", birthday: "2026-07-02" },
            { phone: "+15550000013", birthday: "2026-07-02" },
            { phone: "+15550000014", birthday: "2026-07-02" },
          ],
        },
      },
    };
    scenario.nodes = [
      weeklyRoot,
      { ...dailyTemplate!, id: "weekly-template" },
      dailyRoot!,
      dailyTemplate!,
    ] as typeof scenario.nodes;
    scenario.edges = [
      {
        source: "weekly-root",
        sourceHandle: "right-source",
        target: "weekly-template",
      },
      ...scenario.edges,
    ];
    mockScenarioFind.mockReturnValue(leanQuery([scenario]));

    const summary = await getBirthdayProtectionSummary({
      workspaceId: "workspace-1",
      dailyLimit: 250,
      now: new Date("2026-07-02T09:00:00.000Z"),
    });

    expect(summary).toMatchObject({
      active: true,
      protectedTodayCount: 2,
      availableRecipientLimit: 248,
    });
  });

  it("does not reserve WhatsApp capacity for Telegram birthday campaigns", async () => {
    mockScenarioFind.mockReturnValue(leanQuery([telegramBirthdayScenario()]));

    const summary = await getBirthdayProtectionSummary({
      workspaceId: "workspace-1",
      dailyLimit: 250,
      now: new Date("2026-07-02T09:00:00.000Z"),
    });

    expect(summary).toEqual({
      active: false,
      protectedTodayCount: 0,
      availableRecipientLimit: 250,
      dailyLimit: 250,
    });
  });
});

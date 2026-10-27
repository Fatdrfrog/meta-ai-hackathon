const mockScenarioFindOne = jest.fn();
jest.mock("@/lib/customers/service", () => ({
  ensureCustomerForConversation: jest.fn().mockResolvedValue(null),
}));
jest.mock("@/models/conversation", () => ({ Conversation: {} }));
jest.mock("@/models/scenario", () => ({
  Scenario: { findOne: (...args: unknown[]) => mockScenarioFindOne(...args) },
}));
import {
  buildConversionAttribution,
  getConversionAttributionReport,
  getScenarioConversionReport,
} from "./conversion-attribution";
import { ensureCustomerForConversation } from "@/lib/customers/service";
import { Types } from "mongoose";

it("preserves the linked Mongo customer ID if customer linking fails", async () => {
  const customerId = new Types.ObjectId();
  jest
    .mocked(ensureCustomerForConversation)
    .mockRejectedValueOnce(new Error("offline"));
  const metadata = await buildConversionAttribution({
    conversation: { customerId, workspaceId: "workspace" } as never,
    conversationId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    convertedAt: new Date().toISOString(),
  });
  expect(metadata.customerId).toBe(String(customerId));
});
describe("conversion attribution database report", () => {
  it("does not start a report after cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Stopped", "AbortError"));
    const rpc = jest.fn();
    await expect(
      getConversionAttributionReport({
        supabase: { rpc } as never,
        workspaceId: "workspace",
        start: "2026-09-01",
        end: "2026-09-10",
        signal: controller.signal,
      })
    ).rejects.toThrow("Stopped");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("stops waiting for an in-flight financial report when cancelled", async () => {
    const controller = new AbortController();
    const query = {
      abortSignal: jest.fn().mockReturnThis(),
      then: new Promise(() => {}).then.bind(new Promise(() => {})),
    };
    const report = getConversionAttributionReport({
      supabase: { rpc: () => query } as never,
      workspaceId: "workspace",
      start: "2026-09-01",
      end: "2026-09-10",
      signal: controller.signal,
    });
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(report).rejects.toThrow("Stopped");
    expect(query.abortSignal).toHaveBeenCalledWith(controller.signal);
  });
  it("passes the scoped interval to the database and preserves currency groups", async () => {
    const data = {
      rows: [
        {
          adId: null,
          campaignId: null,
          campaignName: null,
          currency: "USD",
          sales: 2,
          refunds: 1,
          grossRevenue: 200,
          refundedRevenue: 50,
          netRevenue: 150,
          payingCustomers: 1,
          paidConversations: 2,
        },
        {
          adId: "ad",
          campaignId: "campaign",
          campaignName: "Campaign",
          currency: "KZT",
          sales: 1,
          refunds: 0,
          grossRevenue: 10000,
          refundedRevenue: 0,
          netRevenue: 10000,
          payingCustomers: 0,
          paidConversations: 1,
        },
      ],
      recentDeliveries: [],
      truncated: false,
    };
    const rpc = jest.fn().mockResolvedValue({ data, error: null });
    expect(
      await getConversionAttributionReport({
        supabase: { rpc } as never,
        workspaceId: "workspace",
        sourceId: "source",
        start: "2026-09-01T00:00:00Z",
        end: "2026-09-10T00:00:00Z",
      })
    ).toEqual(data);
    expect(rpc).toHaveBeenCalledWith("get_conversion_attribution_report", {
      p_workspace_id: "workspace",
      p_source_id: "source",
      p_start: "2026-09-01T00:00:00Z",
      p_end: "2026-09-10T00:00:00Z",
    });
  });
  it("fails visibly on database errors", async () => {
    await expect(
      getConversionAttributionReport({
        supabase: {
          rpc: jest.fn().mockResolvedValue({ error: { message: "offline" } }),
        } as never,
        workspaceId: "workspace",
        start: "2026-09-01",
        end: "2026-09-10",
      })
    ).rejects.toThrow();
  });
});

describe("scenario attribution after human handoff", () => {
  const scenarioId = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const newerScenarioId = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const anchorAt = "2026-09-11T10:00:00.000Z";
  const startedAt = "2026-09-11T09:00:00.000Z";
  const completedAt = "2026-09-11T10:00:01.000Z";
  const started = { scenarioId, scenarioName: "Consultation", startedAt };
  const completed = {
    scenarioId,
    scenarioName: "Consultation",
    completedAt,
    lastActionNodeId: "revenue-handoff",
    lastMessageId: "handoff-message",
  };
  let state: Record<string, unknown>;
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-11T12:00:00Z"));
    mockScenarioFindOne.mockReset();
    mockScenarioFindOne.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: scenarioId,
          workspaceId: "workspace",
          presetId: "revenue-playbook-ad_consultation",
          segmentKey: "lead_generation",
        }),
      }),
    });
    state = {
      lockedScenarioId: null,
      startedScenarios: [started],
      completedScenarios: [completed],
    };
  });
  afterEach(() => jest.useRealTimers());
  const build = (overrides: Record<string, unknown> = {}) =>
    buildConversionAttribution({
      conversation: {
        _id: "conversation",
        workspaceId: "workspace",
        airi_scenario_state: state,
      } as never,
      conversationId: "conversation",
      convertedAt: anchorAt,
      ...overrides,
    });

  it("attributes receipt time inside the scenario before terminal handoff clears its lock", async () => {
    const result = await build({
      paymentSuggestion: {
        messageId: "receipt",
        kind: "receipt",
        amount: 10000,
        currency: "KZT",
        occurredAt: anchorAt,
      },
    });
    expect(result).toMatchObject({
      scenarioId,
      scenarioName: "Consultation",
      presetId: "revenue-playbook-ad_consultation",
      actionNodeId: "revenue-handoff",
      scenarioAttribution: {
        method: "completed_touch",
        anchorAt,
        startedAt,
        completedAt,
        windowHours: 24,
      },
    });
    expect(mockScenarioFindOne).toHaveBeenCalledWith({
      _id: scenarioId,
      workspaceId: "workspace",
    });
  });

  it("attributes a recorded booking within24hours after the last completion", async () => {
    expect(
      await build({ convertedAt: "2026-09-11T11:00:00.000Z" })
    ).toMatchObject({
      scenarioId,
      scenarioAttribution: { method: "completed_touch" },
    });
  });

  it("prefers the active scenario with a valid start at the event time", async () => {
    state = {
      ...state,
      lockedScenarioId: scenarioId,
      lockedScenarioName: "Active consultation",
      currentActionNodeId: "revenue-offer",
      currentBranchNodeIds: ["branch"],
      completedScenarios: [],
    };
    expect(await build()).toMatchObject({
      scenarioId,
      scenarioName: "Active consultation",
      actionNodeId: "revenue-offer",
      branchNodeIds: ["branch"],
      scenarioAttribution: { method: "active", startedAt },
    });
  });

  it("preserves a legacy active lock with a valid persisted last touch", async () => {
    state = {
      lockedScenarioId: scenarioId,
      lastMatchedAt: startedAt,
      currentActionNodeId: "revenue-offer",
    };
    expect(await build()).toMatchObject({
      scenarioId,
      scenarioAttribution: { method: "active", startedAt },
    });
  });

  it("does not credit a previous completion after another scenario started", async () => {
    state.startedScenarios = [
      started,
      { scenarioId: newerScenarioId, startedAt: "2026-09-11T10:15:00Z" },
    ];
    expect(await build({ convertedAt: "2026-09-11T11:00:00Z" })).toMatchObject({
      scenarioId: null,
      scenarioAttribution: null,
    });
    expect(mockScenarioFindOne).not.toHaveBeenCalled();
  });

  it("does not apply an old receipt to the scenario started later", async () => {
    state = {
      ...state,
      lockedScenarioId: newerScenarioId,
      startedScenarios: [
        started,
        { scenarioId: newerScenarioId, startedAt: "2026-09-11T10:15:00Z" },
      ],
    };
    expect(await build()).toMatchObject({
      scenarioId,
      scenarioAttribution: { method: "completed_touch", anchorAt },
    });
  });

  it.each([
    { startedScenarios: [], completedScenarios: [completed] },
    {
      startedScenarios: [{ ...started, startedAt: "invalid" }],
      completedScenarios: [completed],
    },
    {
      startedScenarios: [started],
      completedScenarios: [{ ...completed, completedAt: "invalid" }],
    },
    {
      startedScenarios: [started],
      completedScenarios: [
        { ...completed, completedAt: "2026-09-12T00:00:00Z" },
      ],
    },
    {
      startedScenarios: [{ ...started, startedAt: "2026-09-11T11:00:00Z" }],
      completedScenarios: [completed],
    },
    {
      startedScenarios: [{ ...started, startedAt: "2026-09-01T09:00:00Z" }],
      completedScenarios: [
        { ...completed, completedAt: "2026-09-01T10:00:00Z" },
      ],
    },
    { lockedScenarioId: scenarioId },
  ])("excludes missing, stale, future or malformed receipts", async invalid => {
    state = invalid;
    expect(await build()).toMatchObject({
      scenarioId: null,
      scenarioAttribution: null,
    });
    expect(mockScenarioFindOne).not.toHaveBeenCalled();
  });

  it.each(["invalid", "2026-09-12T00:00:00Z"])(
    "excludes invalid or future conversion anchors",
    async convertedAt => {
      expect(await build({ convertedAt })).toMatchObject({
        scenarioId: null,
        scenarioAttribution: null,
      });
    }
  );

  it("rejects a scenario document outside the conversation workspace", async () => {
    mockScenarioFindOne.mockReturnValue({
      select: () => ({
        lean: async () => ({
          workspaceId: "other-workspace",
          presetId: "forbidden",
        }),
      }),
    });
    expect(await build()).toMatchObject({
      scenarioId: null,
      presetId: null,
      scenarioAttribution: null,
    });
  });

  it("clears caller-provided attribution when no trusted receipt remains", async () => {
    state = {};
    expect(
      await build({
        metadata: {
          scenarioId,
          presetId: "forged",
          scenarioAttribution: { method: "active" },
        },
      })
    ).toMatchObject({
      scenarioId: null,
      presetId: null,
      scenarioAttribution: null,
    });
  });
});

describe("scenario conversion database report", () => {
  const params = {
    workspaceId: "workspace",
    scenarioId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    start: "2026-09-01T00:00:00Z",
    end: "2026-09-10T00:00:00Z",
  };
  const data = {
    totals: { sales: 2, refunds: 1, bookings: 3, signups: 4 },
    currencies: [
      {
        currency: "KZT",
        sales: 1,
        refunds: 1,
        grossRevenue: 10000,
        refundedRevenue: 2500,
        netRevenue: 7500,
      },
      {
        currency: "USD",
        sales: 1,
        refunds: 0,
        grossRevenue: 20,
        refundedRevenue: 0,
        netRevenue: 20,
      },
    ],
    truncated: false,
  };

  it("preserves per-currency refunds and recorded booking counts without a revenue total", async () => {
    const rpc = jest.fn().mockResolvedValue({ data, error: null });
    expect(
      await getScenarioConversionReport({
        ...params,
        supabase: { rpc } as never,
      })
    ).toEqual({
      ...data,
      scenarioId: params.scenarioId,
      period: { startDate: params.start, endDate: params.end },
    });
    expect(rpc).toHaveBeenCalledWith("get_scenario_conversion_report", {
      p_workspace_id: params.workspaceId,
      p_scenario_id: params.scenarioId,
      p_start: params.start,
      p_end: params.end,
    });
  });

  it("preserves the explicit truncation signal", async () => {
    const rpc = jest
      .fn()
      .mockResolvedValue({ data: { ...data, truncated: true }, error: null });
    expect(
      await getScenarioConversionReport({
        ...params,
        supabase: { rpc } as never,
      })
    ).toMatchObject({ truncated: true });
  });

  it.each([
    null,
    {},
    { ...data, currencies: new Array(201).fill(data.currencies[0]) },
    { ...data, totals: { ...data.totals, bookings: -1 } },
    { ...data, totals: { ...data.totals, sales: "2" } },
    {
      ...data,
      currencies: [{ ...data.currencies[0], netRevenue: Number.NaN }],
    },
    { ...data, currencies: [{ ...data.currencies[0], currency: "a lot" }] },
    { ...data, truncated: undefined },
  ])("fails visibly on a malformed or unbounded report", async malformed => {
    const rpc = jest.fn().mockResolvedValue({ data: malformed, error: null });
    await expect(
      getScenarioConversionReport({ ...params, supabase: { rpc } as never })
    ).rejects.toThrow("Failed to load scenario conversion report");
  });
});

const mockSourcesQuery = jest.fn();
const mockAggregate = jest.fn();
const mockUpdateCredentials = jest.fn();
const mockCapture = jest.fn();

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => mockSourcesQuery() }),
    }),
  },
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
}));
jest.mock("@icecore/airi-runtime/whatsapp-webhook-event-model", () => ({
  __esModule: true,
  default: {
    aggregate: (...args: unknown[]) => ({
      option: async () => mockAggregate(...args),
    }),
  },
}));
jest.mock("@/lib/whatsapp/flows/source-rebind-guard", () => ({
  updateCurrentWhatsAppSourceCredentials: (...args: unknown[]) =>
    mockUpdateCredentials(...args),
}));
jest.mock("@/lib/posthog/server", () => ({
  getPostHogClient: () => ({ capture: mockCapture }),
  flushServerPostHog: jest.fn(async () => undefined),
}));
jest.mock("@/lib/observability/server-logs", () => ({
  createServerLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { runWhatsAppInboundLivenessCheck } from "./inbound-liveness-monitor";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-12T12:00:00.000Z");
const MIDNIGHT = Date.parse("2026-10-12T00:00:00.000Z");
const SILENT_SINCE = "2026-10-11T15:40:00.000Z";

type Bucket = {
  _id: { phone: string; slot: number };
  count: number;
  first: Date;
  last: Date;
};

/**
 * Hour buckets as the aggregate returns them: 3 messages an hour,
 * 04:00-16:00 UTC, from `fromDay` up to `throughDay` days before NOW,
 * leaving out `skipDays`.
 */
function busyBuckets(
  phone: string,
  {
    throughDay = 1,
    fromDay = 14,
    skipDays = [] as number[],
  }: { throughDay?: number; fromDay?: number; skipDays?: number[] } = {}
) {
  const buckets: Bucket[] = [];
  for (let day = fromDay; day >= throughDay; day -= 1) {
    if (skipDays.includes(day)) continue;
    for (let hour = 4; hour < 16; hour += 1) {
      const first = MIDNIGHT - day * DAY + hour * HOUR;
      const last = first + 40 * 60 * 1000;
      if (last > NOW.getTime()) continue;
      buckets.push({
        _id: { phone, slot: Math.floor((NOW.getTime() - first) / HOUR) },
        count: 3,
        first: new Date(first),
        last: new Date(last),
      });
    }
  }
  return buckets;
}

/** A busy number that is still receiving messages this morning. */
function activeBuckets(phone: string) {
  const buckets = busyBuckets(phone);
  for (let hour = 4; hour < 12; hour += 1) {
    const first = MIDNIGHT + hour * HOUR;
    buckets.push({
      _id: { phone, slot: Math.floor((NOW.getTime() - first) / HOUR) },
      count: 3,
      first: new Date(first),
      last: new Date(first + 40 * 60 * 1000),
    });
  }
  return buckets;
}

/** Mongo does not order $group output. */
const shuffled = (buckets: Bucket[]) =>
  buckets
    .map((bucket, index) => ({ bucket, key: (index * 7919) % 104729 }))
    .sort((left, right) => left.key - right.key)
    .map(({ bucket }) => bucket);

function source(id: string, credentials: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: `workspace-${id}`,
    company_id: `company-${id}`,
    created_at: "2026-09-01T00:00:00.000Z",
    credentials: {
      phone_number_id: `phone-${id}`,
      waba_id: `waba-${id}`,
      ...credentials,
    },
  };
}

function givenSources(...rows: ReturnType<typeof source>[]) {
  mockSourcesQuery.mockResolvedValue({ data: rows, error: null });
}

const writtenPatch = (call = 0) =>
  mockUpdateCredentials.mock.calls[call][0].buildCredentials({});

describe("runWhatsAppInboundLivenessCheck", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateCredentials.mockResolvedValue({});
    mockAggregate.mockResolvedValue([]);
  });

  it("marks a busy number that went silent while others keep receiving", async () => {
    givenSources(
      source("a"),
      source("b"),
      source("removed", { coexistence_reonboarding_status: "removed" }),
      source("no-phone", { phone_number_id: undefined })
    );
    mockAggregate.mockResolvedValue(
      shuffled([...busyBuckets("phone-a"), ...activeBuckets("phone-b")])
    );

    const summary = await runWhatsAppInboundLivenessCheck({ now: NOW });

    const [pipeline] = mockAggregate.mock.calls[0] as [
      Array<{ $match?: Record<string, unknown> }>,
    ];
    expect(pipeline[0].$match).toMatchObject({
      phoneNumberId: { $in: ["phone-a", "phone-b"] },
      field: { $in: ["messages", "smb_message_echoes"] },
      itemKind: { $in: ["message", "messages", "smb_message_echoes"] },
      // Five weeks of gap history plus a week for an older silence.
      createdAt: { $gte: new Date(NOW.getTime() - 42 * DAY), $lte: NOW },
    });
    expect(summary).toMatchObject({
      checked: 2,
      silent: [
        {
          sourceId: "a",
          workspaceId: "workspace-a",
          silentSince: SILENT_SINCE,
        },
      ],
      fleetSilent: false,
      errors: 0,
    });
    expect(mockUpdateCredentials).toHaveBeenCalledTimes(1);
    expect(mockUpdateCredentials.mock.calls[0][0]).toMatchObject({
      workspaceId: "workspace-a",
      sourceId: "a",
      expectedWabaId: "waba-a",
      expectedPhoneNumberId: "phone-a",
    });
    expect(
      mockUpdateCredentials.mock.calls[0][0].buildCredentials({ keep: true })
    ).toEqual({
      keep: true,
      inbound_liveness_status: "silent",
      inbound_liveness_phone_number_id: "phone-a",
      inbound_liveness_silent_since: SILENT_SINCE,
      inbound_liveness_detected_at: NOW.toISOString(),
      inbound_liveness_checked_at: NOW.toISOString(),
    });
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: "airi:workspace:workspace-a",
        event: "whatsapp_inbound_liveness_silent",
        groups: { company: "company-a" },
        properties: expect.objectContaining({
          source_id: "a",
          silent_since: SILENT_SINCE,
          silence_hours: 20,
          active_reference_days: 14,
          // The nightly gap, 15:40 to 04:00.
          longest_earlier_gap_hours: 12,
        }),
      })
    );
  });

  describe("an earlier long gap", () => {
    // Quiet 22 and 21 days back: 60 h 20 min without messages, before the
    // reference days but inside the five weeks of gap history.
    const withEarlierGap = () =>
      shuffled([
        ...busyBuckets("phone-a", { fromDay: 30, skipDays: [22, 21] }),
        ...activeBuckets("phone-b"),
      ]);
    const gapFrom = new Date(
      MIDNIGHT - 23 * DAY + 15 * HOUR + 40 * 60 * 1000
    ).toISOString();
    const gapTo = new Date(MIDNIGHT - 20 * DAY + 4 * HOUR).toISOString();

    it("keeps a shorter silence quiet when the gap was ordinary for the number", async () => {
      givenSources(source("a"), source("b"));
      mockAggregate.mockResolvedValue(withEarlierGap());

      const summary = await runWhatsAppInboundLivenessCheck({ now: NOW });

      expect(summary.silent).toEqual([]);
      expect(mockUpdateCredentials).not.toHaveBeenCalled();
    });

    it("flags the silence when that gap was a recorded outage", async () => {
      givenSources(
        source("a", {
          inbound_liveness_outages: [
            { phone_number_id: "phone-a", from: gapFrom, to: gapTo },
          ],
        }),
        source("b")
      );
      mockAggregate.mockResolvedValue(withEarlierGap());

      const summary = await runWhatsAppInboundLivenessCheck({ now: NOW });

      expect(summary.silent).toEqual([
        expect.objectContaining({ sourceId: "a", silentSince: SILENT_SINCE }),
      ]);
    });

    it("still counts the gap when the outage was another number's", async () => {
      givenSources(
        source("a", {
          inbound_liveness_outages: [
            { phone_number_id: "phone-old", from: gapFrom, to: gapTo },
          ],
        }),
        source("b")
      );
      mockAggregate.mockResolvedValue(withEarlierGap());

      const summary = await runWhatsAppInboundLivenessCheck({ now: NOW });

      expect(summary.silent).toEqual([]);
    });
  });

  it("warns no customer when every number goes quiet together", async () => {
    givenSources(source("a"), source("b"), source("c"));
    mockAggregate.mockResolvedValue(
      shuffled([
        ...busyBuckets("phone-a"),
        ...busyBuckets("phone-b"),
        ...busyBuckets("phone-c"),
      ])
    );

    const summary = await runWhatsAppInboundLivenessCheck({ now: NOW });

    expect(summary).toMatchObject({ fleetSilent: true, silent: [] });
    expect(mockUpdateCredentials).not.toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: "airi:platform",
        event: "whatsapp_inbound_liveness_fleet_silent",
        properties: expect.objectContaining({ last_inbound_at: SILENT_SINCE }),
      })
    );
  });

  it.each([
    ["the webhook needs reconnecting", { webhook_requires_reconnect: true }],
    [
      "Meta stopped sending messages",
      { webhook_missing_required_fields: ["messages"] },
    ],
    ["the phone is not registered", { phone_registered: false }],
  ])(
    "leaves the silence to the existing warning when %s",
    async (_label, credentials) => {
      givenSources(source("a", credentials), source("b"));
      mockAggregate.mockResolvedValue([
        ...busyBuckets("phone-a"),
        ...activeBuckets("phone-b"),
      ]);

      const summary = await runWhatsAppInboundLivenessCheck({ now: NOW });

      expect(summary).toMatchObject({ silent: [], explainedElsewhere: 1 });
      expect(mockUpdateCredentials).not.toHaveBeenCalled();
    }
  );

  describe("a number it already flagged", () => {
    const flagged = {
      inbound_liveness_status: "silent",
      inbound_liveness_phone_number_id: "phone-a",
      inbound_liveness_silent_since: SILENT_SINCE,
      inbound_liveness_checked_at: "2026-10-12T11:00:00.000Z",
    };

    it("refreshes the check time without a new event", async () => {
      givenSources(source("a", flagged), source("b"));
      mockAggregate.mockResolvedValue([
        ...busyBuckets("phone-a"),
        ...activeBuckets("phone-b"),
      ]);

      const summary = await runWhatsAppInboundLivenessCheck({ now: NOW });

      expect(summary).toMatchObject({ stillSilent: 1, silent: [] });
      expect(writtenPatch()).toEqual({
        inbound_liveness_checked_at: NOW.toISOString(),
      });
      expect(mockCapture).not.toHaveBeenCalled();
    });

    it("clears the flag once messages arrive again", async () => {
      givenSources(source("a", flagged));
      mockAggregate.mockResolvedValue(activeBuckets("phone-a"));

      const summary = await runWhatsAppInboundLivenessCheck({ now: NOW });

      expect(summary.recovered).toEqual([
        { sourceId: "a", workspaceId: "workspace-a" },
      ]);
      expect(writtenPatch()).toMatchObject({
        inbound_liveness_status: null,
        inbound_liveness_phone_number_id: null,
        inbound_liveness_checked_at: null,
      });
      // Outages are recorded by an operator, never by a recovery.
      expect(writtenPatch()).not.toHaveProperty("inbound_liveness_outages");
      expect(mockCapture).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "whatsapp_inbound_liveness_recovered",
        })
      );
    });

    it("drops the flag quietly after the source switched numbers", async () => {
      givenSources(
        source("a", { ...flagged, phone_number_id: "phone-new" }),
        source("b")
      );
      mockAggregate.mockResolvedValue(activeBuckets("phone-b"));

      const summary = await runWhatsAppInboundLivenessCheck({ now: NOW });

      expect(summary).toMatchObject({ cleared: 1, recovered: [] });
      expect(writtenPatch()).toMatchObject({ inbound_liveness_status: null });
      expect(mockCapture).not.toHaveBeenCalled();
    });
  });

  it("counts a failed write and reports nothing for it", async () => {
    givenSources(source("a"), source("b"));
    mockAggregate.mockResolvedValue([
      ...busyBuckets("phone-a"),
      ...activeBuckets("phone-b"),
    ]);
    mockUpdateCredentials.mockRejectedValue(new Error("fence conflict"));

    const summary = await runWhatsAppInboundLivenessCheck({ now: NOW });

    expect(summary).toMatchObject({ errors: 1, silent: [] });
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("waits for a baseline on a number that never received anything", async () => {
    givenSources(source("a"));

    const summary = await runWhatsAppInboundLivenessCheck({ now: NOW });

    expect(summary).toMatchObject({ insufficientBaseline: 1, silent: [] });
    expect(mockUpdateCredentials).not.toHaveBeenCalled();
  });
});

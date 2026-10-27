/* eslint-disable @typescript-eslint/no-require-imports -- Shared Node QA fixtures. */
const assert = require("node:assert/strict");
const keys = [
  "acquisition",
  "attention",
  "delivery",
  "templates",
  "health",
  "flows",
  "retention",
];
const at = "2026-10-02T00:00:00Z";
const sourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const observed = {
  events: 5,
  resolvedEvents: 1,
  measuredResolutions: 1,
  unknownClosures: 0,
  timeoutClosures: 1,
  reopened: 1,
  handoffStarted: 1,
  handoffEnded: 1,
  measuredHandoffs: 1,
  averageResolutionSeconds: 120,
  averageHandoffSeconds: 60,
  snapshotEvents: 0,
  streamEvents: 5,
};
const health = {
  sourceId,
  sourceName: "Store WhatsApp",
  phoneQuality: "GREEN",
  portfolioLimit: "TIER_10000",
  accountStatus: "healthy",
  webhookStatus: "healthy",
  lastVerifiedAt: at,
  verificationFreshness: "fresh",
  templateIssues: 1,
  activationStatus: "required",
  history: [
    {
      day: "2026-10-01",
      observedAt: at,
      phoneQuality: "YELLOW",
      accountStatus: "healthy",
      portfolioLimit: "TIER_10000",
      webhookStatus: "healthy",
      templateIssues: 1,
      pending7d: 12,
      failed7d: 3,
    },
  ],
};
const counts = {
  needsReply: 2,
  agedUnanswered: 1,
  stalled: 1,
  handoff: 1,
  ghosted: 0,
  qualifiedUnanswered: 2,
};
const cohort = {
  kind: "ad",
  sourceId,
  adId: "ad1",
  entries: 5,
  engaged: 3,
  qualified: 2,
  qualifiedPaid: 1,
  booked: 1,
  paid: 1,
  pendingObservation: 2,
  currencies: [
    {
      currency: "USD",
      sales: 1,
      refunds: 1,
      grossRevenue: 100,
      refundedRevenue: 30,
      netRevenue: 70,
      unknownValues: 0,
    },
  ],
};
const fixtures = {
  acquisition: {
    window: {
      start: "2026-09-01T00:00:00Z",
      end: at,
      observationDays: 30,
      asOf: at,
    },
    policy: { qualifiedStageKeys: ["qualified"], revision: 0 },
    coverage: {
      status: "ready",
      projectedThrough: at,
      conversionThrough: at,
      reconciliationThrough: at,
      identityMissing: 1,
      qualification: "recorded_events",
      truncated: false,
    },
    cohorts: [cohort],
    flows: [
      {
        flowId: "flow1",
        sent: 4,
        delivered: 3,
        read: 2,
        submitted: 2,
        qualified: 1,
        paid: 1,
      },
    ],
    retention: [
      {
        cohortMonth: "2026-09",
        currency: "USD",
        customers: 3,
        repeatCustomers: 1,
        pendingCustomers: 2,
        unknownValues: 0,
        sales: 4,
        grossRevenue: 100,
        refundedRevenue: 30,
        netRevenue: 70,
      },
    ],
    retentionMissingIdentity: 1,
  },
  whatsapp: {
    window: { days: 30, start: "2026-09-01", end: at, replyWindowHours: 168 },
    generatedAt: at,
    delivery: {
      accepted: 20,
      sent: 20,
      delivered: 15,
      read: 12,
      replied: 8,
      failed: 3,
      pending: 2,
      medianDeliverySeconds: 2,
      p95DeliverySeconds: 9,
      medianReadSeconds: 30,
      p95ReadSeconds: 400,
      byOrigin: [
        {
          origin: "campaign",
          accepted: 20,
          delivered: 15,
          read: 12,
          replied: 8,
          failed: 3,
        },
      ],
      topErrors: [{ code: "131049", count: 3 }],
      dailyDelivery: [
        {
          day: "2026-10-01",
          accepted: 20,
          delivered: 15,
          read: 12,
          replied: 8,
          failed: 3,
          pending: 2,
          topErrors: [],
        },
      ],
      bySourcePhoneTemplate: [
        {
          sourceId,
          phoneNumberId: "phone1",
          template: "offer_long_name_for_overflow_test",
          accepted: 20,
          delivered: 15,
          read: 12,
          replied: 8,
          failed: 3,
          pending: 2,
        },
      ],
      breakdownTruncated: false,
    },
    pricing: {
      billable: 3,
      free: 10,
      unknown: 7,
      categoryBreakdown: [],
      providerAccounts: [],
      estimate: {
        amount: null,
        currency: null,
        reason: "verified_tariff_required",
      },
      aiCostIncluded: false,
    },
    templates: [
      {
        accountKey: "waba1",
        sourceName: "Store WhatsApp",
        providerWindow: { start: "2026-09-01T00:00:00Z", end: at },
        templateStatus: "activation_required",
        fetchedAt: at,
        templatesTruncated: false,
        templates: [
          {
            id: "template1",
            name: "offer",
            language: "en",
            quality: null,
            status: "APPROVED",
            category: "MARKETING",
            sent: 20,
            delivered: 15,
            read: null,
            clicked: null,
            uniqueClicked: null,
            quickReplyClicked: null,
            cost: null,
            currency: "USD",
          },
        ],
      },
    ],
    health: [health],
    templateLifecycle: [
      {
        at,
        templateId: "template1",
        name: "offer",
        kind: "quality_changed",
        status: "APPROVED",
        quality: "YELLOW",
        category: "MARKETING",
      },
    ],
    limitations: {
      sourcesTruncated: false,
      providerAccountsTruncated: false,
      providerTemplateLookbackDays: 90,
      providerReadClickWindowDays: 7,
      flowOpenMeasured: false,
    },
  },
  policy: {
    qualifiedStageKeys: ["qualified"],
    revision: 0,
    stages: [{ key: "qualified", name: "Qualified" }],
    canEdit: false,
  },
  "chat-leakage": {
    status: "ready",
    asOf: at,
    population: "current_active_customer_primary_conversations",
    scannedCustomers: 2,
    eligibleCustomers: 2,
    truncated: false,
    qualification: { stageKeys: ["qualified"], policyRevision: 0 },
    counts,
    groups: [
      {
        sourceId: null,
        adId: "ad1",
        ownerId: null,
        ownerName: null,
        sourceName: null,
        eligibleCustomers: 2,
        counts,
      },
    ],
    audience: [
      {
        conversationId: "chat1",
        customerId: "customer1",
        customerName: "Customer example",
        stageKey: "qualified",
        stageName: "Qualified",
        ownerId: null,
        sourceId: null,
        adId: "ad1",
        channel: "whatsapp",
        lastInboundAt: at,
        qualified: true,
        waitSeconds: 7200,
        followUp: { kind: "reply", dueAt: at },
        attention: ["needs_reply"],
      },
    ],
    audienceTotal: 1,
    audienceTruncated: false,
  },
  "service-lifecycle": {
    window: { start: "2026-09-01", endExclusive: at },
    coverage: {
      state: "history_gap",
      history: "history_gap",
      firstObservedAt: at,
      historyGapAt: at,
      snapshotRecovery: "complete",
      snapshotScanned: 2,
      resumePersistedAt: at,
    },
    observed,
    groupLimit: 50,
    sourceGroupsTotal: 1,
    groupsTruncated: false,
    bySource: [{ sourceId, channel: "whatsapp", ...observed }],
  },
  dashboard: {
    advertisement: {
      metaInsights: {
        topAds: [
          {
            adId: "ad1",
            adName: "Autumn campaign",
            currency: "USD",
            spend: 50,
          },
        ],
        partial: false,
        reporting: { workspaceTimeZone: "UTC" },
        accounts: [{ timeZone: "UTC" }],
      },
    },
  },
};

// Dashboards view (`?view=dashboards`): the full /api/dashboard contract plus the
// AI and campaign summaries its domain cards request. Values are illustrative.
const overviewDays = 30;
const overviewEnd = Date.UTC(2026, 9, 5);
const day = (index, offsetDays = 0) =>
  new Date(overviewEnd - (overviewDays + offsetDays - index) * 86400000)
    .toISOString()
    .slice(0, 10);
const change = (current, previous) => ({
  current,
  previous,
  delta: current - previous,
  percentChange: previous ? ((current - previous) / previous) * 100 : null,
  kind:
    current > previous
      ? "increase"
      : current < previous
        ? "decrease"
        : "unchanged",
});
const metric = (id, value, previous, secondaryValue = null) => ({
  id,
  value,
  secondaryValue,
  comparison: previous === null ? null : change(value, previous),
});
// Every inquiry has one category, so these sum to the total metric (312 vs 268).
const categories = [
  ["Delivery", 96, 80],
  ["Pricing", 74, 81],
  ["__uncategorized__", 46, 11],
  ["Returns", 41, 30],
  ["Product questions", 38, 44],
  ["Complaints", 17, 22],
];
const managers = [
  ["manager-1", "Aigerim S.", 118, 18, 9, 91, 95, 74],
  ["manager-2", "Dias K.", 96, 12, 11, 73, 80, 132],
  ["manager-3", "Madina T.", 61, 6, 4, 51, 55, 210],
];
fixtures.dashboardOverview = {
  stats: [
    metric("total", 312, 268),
    // Like the API, live queue counts (open, in progress, SLA) have no previous value.
    metric("new", 41, null),
    metric("in_progress", 26, null),
    metric("resolved", 245, 200),
    metric("sla", 4, null),
    metric("repeat", 58, 49, 19),
    metric("csat", 4.6, 4.4, 5),
    metric("first_response", 96, 140),
    metric("ttr", 5.4, 6.1),
  ],
  comparisonPeriod: {
    preset: "30d",
    strategy: "adjacent_equal_duration",
    timeZone: "UTC",
    current: {
      start: `${day(0)}T00:00:00.000Z`,
      endExclusive: "2026-10-05T00:00:00.000Z",
    },
    previous: {
      start: "2026-08-06T00:00:00.000Z",
      endExclusive: `${day(0)}T00:00:00.000Z`,
    },
  },
  dailySeries: {
    current: Array.from({ length: overviewDays }, (_, index) => ({
      date: day(index),
      total:
        5 +
        ((index * 7) % 9) +
        (index % 7 === 5 ? 6 : 0) +
        (index % 5 === 0 ? 3 : 0),
    })),
    previous: Array.from({ length: overviewDays }, (_, index) => ({
      date: day(index, overviewDays),
      total: 5 + ((index * 5) % 8) + (index % 2 === 0 ? 1 : 0),
    })),
  },
  conversationActivityByTime: Array.from({ length: 7 * 12 }, (_, index) => ({
    dayOfWeek: index % 7,
    hour: 8 + Math.floor(index / 7),
    count: (index * 13) % 11,
  })),
  categoryComparisons: categories.map(([category, current, previous]) => ({
    category,
    ...change(current, previous),
  })),
  peakTime: { dayOfWeek: 1, hour: 11 },
  topCategories: categories
    .slice(0, 5)
    .map(([name, value]) => ({ name, value })),
  uncategorizedCount: 46,
  categoriesByChannel: categories.slice(0, 5).flatMap(([category, value]) => [
    { category, channel: "whatsapp", count: Math.round(value * 0.7) },
    { category, channel: "instagram", count: Math.round(value * 0.3) },
  ]),
  topComplaintTag: "Delivery",
  advertisement: {
    totalConversations: 0,
    uniqueSources: 0,
    respondedConversations: 0,
    closedConversations: 0,
    responseRate: 0,
    closeRate: 0,
    topSources: [],
    bySourceType: [],
    dailyCounts: [],
  },
  internalLabels: {
    taggedConversations: 0,
    unlabeledConversations: 312,
    uniqueLabels: 0,
    totalAssignments: 0,
    availableLabels: [],
    topLabels: [],
  },
  managerOptions: managers.map(([id, name]) => ({
    id,
    name,
    role: "manager",
    email: null,
    avatarUrl: null,
  })),
  managerPerformance: managers.map(
    ([id, name, conversations, open, inProgress, resolved, count, median]) => ({
      id,
      name,
      role: "manager",
      email: null,
      avatarUrl: null,
      conversations,
      open,
      inProgress,
      resolved,
      firstResponseCount: count,
      medianFirstResponseSeconds: median,
      averageFirstResponseSeconds: median + 30,
      p90FirstResponseSeconds: median * 3,
    })
  ),
  firstResponse: {
    count: 230,
    medianSeconds: 96,
    averageSeconds: 128,
    p90Seconds: 410,
  },
};
fixtures.llm = {
  warehouse: {
    overview: { trace_count: 1240, error_count: 3 },
    spend: { workspace: { overview: { total_cost_usd: 12.45 } } },
  },
};
fixtures.bulk = {
  overview: { status: "ready" },
  summary: { totalAccepted: 420, delivered: 396, replied: 88 },
};
// Starting dashboard the preference API recommends for this fixture workspace.
fixtures.recommendation = { templateId: "sales", reason: "ads_connected" };

/** /api/dashboard serves both views: Outcomes asks for from/to, Dashboards for a period. */
function dashboardFixtureKey(url) {
  return url.searchParams.has("from") ? "dashboard" : "dashboardOverview";
}

function requestedWindow(url) {
  const from = url.searchParams.get("from"),
    to = url.searchParams.get("to");
  assert.match(from || "", /^\d{4}-\d{2}-\d{2}$/);
  assert.match(to || "", /^\d{4}-\d{2}-\d{2}$/);
  // Every browser context explicitly runs in UTC. DST/date normalization is owned by shared helper tests.
  assert.equal(
    url.searchParams.get("timeZone") || url.searchParams.get("timezone"),
    "UTC"
  );
  const start = new Date(`${from}T00:00:00Z`),
    end = new Date(`${to}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return { from, to, start: start.toISOString(), end: end.toISOString() };
}

function responseFixture(key, url, overrides = {}) {
  const value = overrides[key] || fixtures[key] || {};
  if (key === "acquisition") {
    const range = requestedWindow(url);
    return {
      ...value,
      window: {
        ...value.window,
        start: range.start,
        end: range.end,
        observationDays: Number(url.searchParams.get("observationDays") || 30),
      },
    };
  }
  if (key === "dashboard") {
    const range = requestedWindow(url);
    const meta = value.advertisement.metaInsights;
    return {
      ...value,
      advertisement: {
        ...value.advertisement,
        metaInsights: {
          ...meta,
          dateStart: range.from,
          dateStop: range.to,
          accounts: meta.accounts.map(account => ({
            ...account,
            dateStart: range.from,
            dateStop: range.to,
          })),
        },
      },
    };
  }
  return value;
}

// Ignore only a resource error deliberately produced by this QA API transport.
// Other failures remain visible even when an earlier injected API request failed.
function isExpectedApiResourceError(message, resourceUrl, injectedRequests) {
  const match = /^Failed to load resource:.*\bstatus of (\d{3})\b/.exec(
    message
  );
  if (!resourceUrl || !match) return false;
  const status = Number(match[1]);
  return (
    status >= 400 &&
    injectedRequests.some(
      request => request.url === resourceUrl && request.status === status
    )
  );
}

module.exports = {
  keys,
  at,
  sourceId,
  health,
  counts,
  cohort,
  fixtures,
  dashboardFixtureKey,
  requestedWindow,
  responseFixture,
  isExpectedApiResourceError,
};

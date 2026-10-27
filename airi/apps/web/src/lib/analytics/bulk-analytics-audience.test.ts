import mongoose, { type PipelineStage } from "mongoose";

const mockConnectDB = jest.fn(async () => undefined);
const mockMessageAggregate = jest.fn();
const mockSupabaseFrom = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB.apply(null, args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseFrom.apply(null, args),
  },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    aggregate: (...args: unknown[]) => mockMessageAggregate.apply(null, args),
  },
}));

import {
  buildConversationRecordsPipeline,
  buildConversationCandidateStages,
  buildBulkAnalyticsSendBaseMatch,
  buildEnrichmentStages,
  buildMessageTextSearchPipeline,
  computePreviousAnalyticsWindow,
  normalizeBulkAnalyticsAudienceFilters,
  parseBulkAnalyticsAudienceFiltersFromSearchParams,
  parseKeywordGroups,
  resolveBulkAnalyticsAudience,
} from "@/lib/analytics/bulk-analytics-audience";
import type { BulkAnalyticsStatus } from "@/lib/analytics/bulk-analytics-contract";
import { MAX_BULK_CAMPAIGN_RECIPIENTS } from "@/lib/campaign/bulk-campaign-contracts";

const APPLICATION_RECIPIENT_CAP = 50_000;

function buildCandidateStages(
  overrides: {
    status?: BulkAnalyticsStatus;
    templateNames?: string[];
    campaignMessageIds?: string[] | null;
  } = {}
) {
  return buildConversationCandidateStages({
    workspaceId: "ws-1",
    startDate: new Date("2026-04-01T00:00:00.000Z"),
    endDate: new Date("2026-04-20T00:00:00.000Z"),
    conversationScope: "all",
    campaignMessageIds: overrides.campaignMessageIds ?? null,
    templateNames: overrides.templateNames ?? [],
    messageContainsConversationIds: null,
    messageContainsMode: "contains",
    status: overrides.status ?? "all",
    engagement: "all",
    excludeRecentClientMessageWithin24h: false,
    excludeTemplates: false,
    replyWindowHours: 168,
  });
}

function findAddFieldsContaining(
  stages: PipelineStage[],
  predicate: (addFields: Record<string, unknown>) => boolean
): Record<string, unknown> | undefined {
  for (const stage of stages) {
    if (
      "$addFields" in stage &&
      stage.$addFields &&
      typeof stage.$addFields === "object" &&
      predicate(stage.$addFields as Record<string, unknown>)
    ) {
      return stage.$addFields as Record<string, unknown>;
    }
  }
  return undefined;
}

function findMatchStage(
  stages: PipelineStage[],
  predicate: (match: Record<string, unknown>) => boolean
): PipelineStage.Match | undefined {
  for (const stage of stages) {
    if (
      "$match" in stage &&
      stage.$match &&
      typeof stage.$match === "object" &&
      predicate(stage.$match as Record<string, unknown>)
    ) {
      return stage as PipelineStage.Match;
    }
  }
  return undefined;
}

function findLookupStage(
  stages: PipelineStage[],
  alias: string
): PipelineStage.Lookup | undefined {
  return stages.find(
    stage =>
      "$lookup" in stage &&
      stage.$lookup &&
      typeof stage.$lookup === "object" &&
      "as" in stage.$lookup &&
      stage.$lookup.as === alias
  ) as PipelineStage.Lookup | undefined;
}

function createSupabaseQuery(data: unknown[]) {
  const query: Record<string, jest.Mock> = {};
  query.select = jest.fn(() => query);
  query.eq = jest.fn(() => query);
  query.gte = jest.fn(() => query);
  query.lte = jest.fn(() => query);
  query.in = jest.fn(() => query);
  query.order = jest.fn(() => query);
  query.range = jest.fn(async () => ({ data, error: null }));
  return query;
}

function createPaginatedSupabaseQuery(
  totalRows: number,
  rowForIndex: (index: number) => Record<string, unknown>
) {
  const query = createSupabaseQuery([]);
  query.range = jest.fn(async (start: number, end: number) => {
    const rows: Record<string, unknown>[] = [];
    for (let index = start; index <= end && index < totalRows; index += 1) {
      rows.push(rowForIndex(index));
    }
    return { data: rows, error: null };
  });
  return query;
}

describe("resolveBulkAnalyticsAudience campaign send history path", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("resolves broad campaign-send recipients from campaign history without touching Mongo messages", async () => {
    const campaignQuery = createSupabaseQuery([{ id: "campaign-1" }]);
    const messageQuery = createSupabaseQuery([
      {
        campaign_id: "campaign-1",
        message_id: "wamid.1",
        recipient: "77001234567",
        phone: "+77001234567",
      },
      {
        campaign_id: "campaign-1",
        message_id: "wamid.2",
        recipient: "77001234567",
        phone: "+77001234567",
      },
    ]);
    mockSupabaseFrom.mockImplementation((table: string) =>
      table === "campaign_history" ? campaignQuery : messageQuery
    );

    const audience = await resolveBulkAnalyticsAudience({
      workspaceId: "ws-1",
      filters: {
        from: "2026-06-01T00:00:00.000Z",
        to: "2026-06-30T23:59:59.999Z",
      },
      maxRecipients: 10,
    });

    expect(audience).toMatchObject({
      total: 1,
      eligibleTotal: 1,
      capped: false,
    });
    expect(audience.recipients).toEqual([
      expect.objectContaining({
        phone: "+77001234567",
        conversationId: "campaign:campaign-1:wamid.1",
      }),
    ]);
    expect(campaignQuery.eq).toHaveBeenCalledWith("workspace_id", "ws-1");
    expect(campaignQuery.eq).toHaveBeenCalledWith("channel", "whatsapp");
    expect(campaignQuery.order).toHaveBeenCalledWith("id", {
      ascending: true,
    });
    expect(messageQuery.in).toHaveBeenCalledWith("campaign_id", ["campaign-1"]);
    expect(messageQuery.order).toHaveBeenNthCalledWith(1, "campaign_id", {
      ascending: true,
    });
    expect(messageQuery.order).toHaveBeenNthCalledWith(2, "id", {
      ascending: true,
    });
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockMessageAggregate).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "the exact application cap",
      sourceRows: APPLICATION_RECIPIENT_CAP,
      expectedTotal: APPLICATION_RECIPIENT_CAP,
      expectedCapped: false,
    },
    {
      label: "one recipient above the application cap",
      sourceRows: APPLICATION_RECIPIENT_CAP + 1,
      expectedTotal: APPLICATION_RECIPIENT_CAP,
      expectedCapped: true,
    },
  ])(
    "paginates one campaign deterministically through $label",
    async ({ sourceRows, expectedTotal, expectedCapped }) => {
      expect(MAX_BULK_CAMPAIGN_RECIPIENTS).toBe(APPLICATION_RECIPIENT_CAP);
      const campaignQuery = createSupabaseQuery([{ id: "campaign-1" }]);
      const messageQuery = createPaginatedSupabaseQuery(
        sourceRows,
        index => ({
          id: index + 1,
          campaign_id: "campaign-1",
          message_id: `wamid.${index + 1}`,
          phone: `+1${String(index).padStart(10, "0")}`,
        })
      );
      mockSupabaseFrom.mockImplementation((table: string) =>
        table === "campaign_history" ? campaignQuery : messageQuery
      );

      const audience = await resolveBulkAnalyticsAudience({
        workspaceId: "ws-1",
        filters: {
          from: "2026-06-01T00:00:00.000Z",
          to: "2026-06-30T23:59:59.999Z",
        },
      });

      expect(audience).toMatchObject({
        total: expectedTotal,
        eligibleTotal: expectedTotal,
        capped: expectedCapped,
        maxRecipients: MAX_BULK_CAMPAIGN_RECIPIENTS,
      });
      expect(messageQuery.range).toHaveBeenCalledWith(
        APPLICATION_RECIPIENT_CAP,
        APPLICATION_RECIPIENT_CAP
      );
    }
  );

  it("fails closed when the bounded message scan cannot prove the full audience", async () => {
    const campaignQuery = createSupabaseQuery([{ id: "campaign-1" }]);
    const messageQuery = createPaginatedSupabaseQuery(
      APPLICATION_RECIPIENT_CAP + 1,
      index => ({
        id: index + 1,
        campaign_id: "campaign-1",
        message_id: `wamid.${index + 1}`,
        phone: "+77001234567",
      })
    );
    mockSupabaseFrom.mockImplementation((table: string) =>
      table === "campaign_history" ? campaignQuery : messageQuery
    );

    await expect(
      resolveBulkAnalyticsAudience({
        workspaceId: "ws-1",
        filters: {
          from: "2026-06-01T00:00:00.000Z",
          to: "2026-06-30T23:59:59.999Z",
        },
      })
    ).rejects.toMatchObject({
      code: "campaign_send_audience_scan_limit",
    });
  });

  it("fails closed when the bounded campaign-history scan is incomplete", async () => {
    const campaignQuery = createPaginatedSupabaseQuery(
      APPLICATION_RECIPIENT_CAP + 1,
      index => ({ id: `campaign-${index + 1}` })
    );
    mockSupabaseFrom.mockReturnValue(campaignQuery);

    await expect(
      resolveBulkAnalyticsAudience({
        workspaceId: "ws-1",
        filters: {
          from: "2026-06-01T00:00:00.000Z",
          to: "2026-06-30T23:59:59.999Z",
        },
      })
    ).rejects.toMatchObject({
      code: "campaign_send_audience_scan_limit",
    });
  });

  it("refuses reply-attributed campaign-send audiences instead of falling back to Message.aggregate", async () => {
    await expect(
      resolveBulkAnalyticsAudience({
        workspaceId: "ws-1",
        filters: {
          status: "replied",
          from: "2026-06-01T00:00:00.000Z",
          to: "2026-06-30T23:59:59.999Z",
        },
      })
    ).rejects.toMatchObject({
      code: "campaign_send_audience_rollup_required",
    });

    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockMessageAggregate).not.toHaveBeenCalled();
  });

  it("refuses non-campaign conversation audiences instead of running the conversation aggregate", async () => {
    await expect(
      resolveBulkAnalyticsAudience({
        workspaceId: "ws-1",
        filters: {
          conversationScope: "all",
          from: "2026-06-01T00:00:00.000Z",
          to: "2026-06-30T23:59:59.999Z",
        },
      })
    ).rejects.toMatchObject({
      code: "conversation_audience_rollup_required",
    });

    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockMessageAggregate).not.toHaveBeenCalled();
  });
});

describe("bulk analytics audience pipelines", () => {
  it("early-matches template fields on campaign-send base match", () => {
    const match = buildBulkAnalyticsSendBaseMatch({
      workspaceId: "ws-1",
      startDate: new Date("2026-04-01T00:00:00.000Z"),
      endDate: new Date("2026-04-20T00:00:00.000Z"),
    });
    expect(match).toMatchObject({
      workspaceId: "ws-1",
      channel: "whatsapp",
      direction: "outbound",
    });
    expect(JSON.stringify(match)).toContain("whatsappTemplate.name");
    expect(JSON.stringify(match)).toContain("origin.templateName");
    expect(JSON.stringify(match)).toContain("^(?:wamid\\\\.|ws_wamid\\\\.)");
  });

  it("keeps campaign-scoped messageId filter when campaignMessageIds provided", () => {
    const match = buildBulkAnalyticsSendBaseMatch({
      workspaceId: "ws-1",
      startDate: new Date("2026-04-01T00:00:00.000Z"),
      endDate: new Date("2026-04-20T00:00:00.000Z"),
      campaignMessageIds: ["wamid.1", "wamid.2"],
    });
    expect(match).toMatchObject({
      workspaceId: "ws-1",
      messageId: { $in: ["wamid.1", "wamid.2"] },
    });
  });
});

describe("bulk analytics audience filter params", () => {
  it("parses repeated campaignId query params as a multi-select list", () => {
    const parsed = parseBulkAnalyticsAudienceFiltersFromSearchParams(
      new URLSearchParams(
        "campaignId=camp-a&campaignId=camp-b&campaignIds=camp-c"
      )
    );

    expect(normalizeBulkAnalyticsAudienceFilters(parsed).campaignIds).toEqual([
      "camp-a",
      "camp-b",
      "camp-c",
    ]);
  });

  it("defaults omitted conversationScope to campaign sends", () => {
    const parsed = parseBulkAnalyticsAudienceFiltersFromSearchParams(
      new URLSearchParams()
    );

    const normalized = normalizeBulkAnalyticsAudienceFilters(parsed);

    expect(normalized.conversationScope).toBe("campaign_sends");
  });

  it("ignores removed global search and run threshold params", () => {
    const parsed = parseBulkAnalyticsAudienceFiltersFromSearchParams(
      new URLSearchParams("q=pricing&minRunSize=50&messageContains=discount")
    );

    expect(parsed).not.toHaveProperty("q");
    expect(parsed).not.toHaveProperty("minRunSize");
    expect(parsed).toMatchObject({ messageContains: "discount" });

    const normalized = normalizeBulkAnalyticsAudienceFilters(parsed);
    expect(normalized).not.toHaveProperty("query");
    expect(normalized).not.toHaveProperty("minRunSize");
    expect(normalized).toMatchObject({ messageContains: "discount" });
  });
});

describe("expandAnalyticsWindowForCampaigns", () => {
  beforeEach(() => {
    mockSupabaseFrom.mockReset();
  });

  it("expands the window to cover selected campaign send times", async () => {
    const query: Record<string, jest.Mock> = {};
    query.select = jest.fn(() => query);
    query.in = jest.fn(async () => ({
      data: [
        { sent_at: "2026-01-01T00:00:00.000Z" },
        { sent_at: "2026-03-15T12:00:00.000Z" },
      ],
      error: null,
    }));
    mockSupabaseFrom.mockReturnValue(query);

    const { expandAnalyticsWindowForCampaigns } = await import(
      "@/lib/analytics/bulk-analytics-audience"
    );

    const window = await expandAnalyticsWindowForCampaigns({
      campaignIds: ["camp-a", "camp-b"],
      startDate: new Date("2026-03-01T00:00:00.000Z"),
      endDate: new Date("2026-03-10T00:00:00.000Z"),
      replyWindowHours: 24,
    });

    expect(window.startDate.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(window.endDate.toISOString()).toBe("2026-03-16T12:00:00.000Z");
  });
});

describe("message text search pipeline", () => {
  it("pushes channel filtering into Atlas Search compound.filter", () => {
    const stages = buildMessageTextSearchPipeline({
      workspaceId: "ws-1",
      query: "pricing",
      dateRange: {
        from: new Date("2026-04-01T00:00:00.000Z"),
        to: new Date("2026-04-20T00:00:00.000Z"),
      },
    });

    const searchStage = stages[0] as PipelineStage.Search;
    expect(searchStage.$search?.compound?.filter).toEqual(
      expect.arrayContaining([
        { equals: { path: "workspaceId", value: "ws-1" } },
        { equals: { path: "channel", value: "whatsapp" } },
      ])
    );
    expect(stages).not.toContainEqual({ $match: { channel: "whatsapp" } });
  });

  it("can use stored source when the Atlas Search index is ready", () => {
    const stages = buildMessageTextSearchPipeline({
      workspaceId: "ws-1",
      query: "pricing",
    });

    const searchStage = stages[0] as { $search?: Record<string, unknown> };
    expect(searchStage.$search?.returnStoredSource).toBe(true);
  });

  it("detects message-scan exhaustion via facet meta (not only conversation-ID cap)", () => {
    const stages = buildMessageTextSearchPipeline({
      workspaceId: "ws-1",
      query: "pricing",
    });

    expect(stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ $limit: 200_001 }),
        expect.objectContaining({
          $facet: expect.objectContaining({
            scanMeta: [{ $count: "scannedMessages" }],
            conversations: expect.any(Array),
          }),
        }),
      ])
    );
  });

  it("supports future direction and conversation filters inside Atlas Search", () => {
    const conversationId = "662a7b4385c9c87f2ab4a111";
    const stages = buildMessageTextSearchPipeline({
      workspaceId: "ws-1",
      query: "pricing",
      directions: ["inbound"],
      conversationIds: [conversationId],
    });

    const searchStage = stages[0] as {
      $search?: { compound?: { filter?: Record<string, unknown>[] } };
    };
    const filters = searchStage.$search?.compound?.filter || [];
    expect(filters).toEqual(
      expect.arrayContaining([
        { equals: { path: "direction", value: "inbound" } },
        {
          equals: {
            path: "conversation",
            value: new mongoose.Types.ObjectId(conversationId),
          },
        },
      ])
    );
  });
});

describe("buildConversationCandidateStages reply attribution", () => {
  it("anchors attribution on the denormalized last outbound when no campaign send matches", () => {
    const stages = buildCandidateStages();

    // Denormalized fields replace the per-conversation lastOutboundAny $lookup.
    expect(findLookupStage(stages, "lastOutboundAny")).toBeUndefined();

    const denormStage = findAddFieldsContaining(
      stages,
      addFields => "lastOutboundAny" in addFields
    );
    expect(JSON.stringify(denormStage?.lastOutboundAny)).toContain(
      "$last_outbound_at"
    );

    const anchorStage = findAddFieldsContaining(
      stages,
      addFields => "anchorSend" in addFields
    );
    expect(anchorStage?.anchorSend).toEqual({
      $ifNull: ["$campaignSend", "$lastOutboundAny"],
    });
  });

  it("caps the attribution window at the next outbound or reply window end", () => {
    const stages = buildCandidateStages();

    const nextOutboundLookup = findLookupStage(
      stages,
      "nextOutboundAfterAnchor"
    );
    expect(nextOutboundLookup).toBeDefined();
    expect(JSON.stringify(nextOutboundLookup?.$lookup.pipeline)).toContain(
      '"$gt":["$date","$$anchorDate"]'
    );

    const attributionStage = findAddFieldsContaining(
      stages,
      addFields => "attributionEndsAt" in addFields
    );
    expect(attributionStage).toBeDefined();
    expect(JSON.stringify(attributionStage)).toContain("$cond");
    expect(JSON.stringify(attributionStage)).toContain(
      "$nextOutboundAfterAnchorAt"
    );
    expect(JSON.stringify(attributionStage)).toContain("$replyWindowEndsAt");
  });

  it("coalesces a missing next outbound to null so replies still attribute", () => {
    const sendStages = buildEnrichmentStages({
      workspaceId: "ws_1",
      replyWindowHours: 24,
    });
    const nextOutboundAt = findAddFieldsContaining(
      sendStages,
      addFields => "nextOutboundAt" in addFields
    );
    expect(nextOutboundAt?.nextOutboundAt).toEqual({
      $ifNull: [{ $arrayElemAt: ["$nextOutbound.date", 0] }, null],
    });

    const conversationStages = buildCandidateStages();
    const nextOutboundAfterAnchorAt = findAddFieldsContaining(
      conversationStages,
      addFields => "nextOutboundAfterAnchorAt" in addFields
    );
    expect(nextOutboundAfterAnchorAt?.nextOutboundAfterAnchorAt).toEqual({
      $ifNull: [{ $arrayElemAt: ["$nextOutboundAfterAnchor.date", 0] }, null],
    });
  });

  it("counts only inbound messages inside the anchor -> attributionEndsAt window", () => {
    const stages = buildCandidateStages();

    const replyStatsLookup = findLookupStage(stages, "replyStats");
    expect(replyStatsLookup).toBeDefined();
    const lookupJson = JSON.stringify(replyStatsLookup?.$lookup);
    const pipeline = JSON.stringify(replyStatsLookup?.$lookup.pipeline);
    expect(lookupJson).toContain('"direction":"inbound"');
    expect(pipeline).toContain('"$gt":["$date","$$anchorDate"]');
    expect(pipeline).toContain('"$lte":["$date","$$attributionEndsAt"]');
    expect(pipeline).toContain('"$group"');
    expect(pipeline).toContain("replyCount");
    expect(pipeline).toContain("firstReply");
  });

  it("filters status=replied/not_replied against the attributed replied flag", () => {
    const repliedStages = buildCandidateStages({ status: "replied" });
    const notRepliedStages = buildCandidateStages({ status: "not_replied" });

    expect(
      findMatchStage(repliedStages, match => match.replied === true)?.$match
    ).toEqual({ replied: true });
    expect(
      findMatchStage(notRepliedStages, match => match.replied === false)?.$match
    ).toEqual({ replied: false });
  });

  it("exposes replyCount, replied, firstReply, and replyCategory for downstream projection", () => {
    const stages = buildCandidateStages();

    const replyFields = findAddFieldsContaining(
      stages,
      addFields => "replyCount" in addFields && "firstReply" in addFields
    );
    expect(replyFields).toBeDefined();
    expect(replyFields?.replyCount).toEqual({
      $ifNull: ["$replyStats.replyCount", 0],
    });
    expect(replyFields?.firstReply).toBe("$replyStats.firstReply");

    const repliedFields = findAddFieldsContaining(
      stages,
      addFields => "replied" in addFields && "replyDelayMinutes" in addFields
    );
    expect(repliedFields?.replied).toEqual({ $gt: ["$replyCount", 0] });

    const replyCategoryFields = findAddFieldsContaining(
      stages,
      addFields => "replyCategory" in addFields
    );
    expect(replyCategoryFields).toBeDefined();
    expect(JSON.stringify(replyCategoryFields)).toContain('"no_reply"');
    expect(JSON.stringify(replyCategoryFields)).toContain('"flow"');
  });

  it("exposes wasRead on campaign-send enrichment stages", () => {
    const stages = buildEnrichmentStages({
      workspaceId: "ws_1",
      replyWindowHours: 24,
    });
    const readFields = findAddFieldsContaining(
      stages,
      addFields => "wasRead" in addFields
    );
    expect(readFields).toBeDefined();
    expect(JSON.stringify(readFields)).toContain('"read"');
    expect(JSON.stringify(readFields)).toContain('"played"');
    expect(JSON.stringify(readFields)).toContain("$delivery.readAt");
    expect(JSON.stringify(readFields)).toContain('"wasDelivered"');
    expect(JSON.stringify(readFields)).toContain('"wasFailed"');

    const nextOutboundLookup = findLookupStage(stages, "nextOutbound");
    expect(nextOutboundLookup?.$lookup).toMatchObject({
      localField: "conversation",
      foreignField: "conversation",
    });
    const replyStatsLookup = findLookupStage(stages, "replyStats");
    expect(replyStatsLookup?.$lookup).toMatchObject({
      localField: "conversation",
      foreignField: "conversation",
    });

    const outcomeFields = findAddFieldsContaining(
      stages,
      addFields => "outcomeBucket" in addFields && "messageCostUsd" in addFields
    );
    expect(outcomeFields).toBeDefined();
    expect(JSON.stringify(outcomeFields)).toContain('"read_no_reply"');
    expect(JSON.stringify(outcomeFields)).toContain('"not_delivered"');
    expect(JSON.stringify(outcomeFields)).toContain("messageCostUsd");
  });

  it("computes previous analytics window as equal-length predecessor", () => {
    const window = computePreviousAnalyticsWindow(
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-07-08T00:00:00.000Z")
    );
    expect(window.startDate.toISOString()).toBe("2026-06-24T00:00:00.000Z");
    expect(window.endDate.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("scopes the next-outbound lookup to the picked template's anchor (medal_1/medal_2 isolation)", () => {
    const medal1 = buildCandidateStages({ templateNames: ["medal_1"] });
    const medal2 = buildCandidateStages({ templateNames: ["medal_2"] });

    for (const stages of [medal1, medal2]) {
      const nextOutboundLookup = findLookupStage(
        stages,
        "nextOutboundAfterAnchor"
      );
      expect(nextOutboundLookup).toBeDefined();
      expect(nextOutboundLookup?.$lookup).toMatchObject({
        localField: "_id",
        foreignField: "conversation",
        let: { anchorDate: "$anchorSend.date" },
      });

      const replyStatsLookup = findLookupStage(stages, "replyStats");
      expect(replyStatsLookup?.$lookup.let).toMatchObject({
        anchorDate: "$anchorDate",
        attributionEndsAt: "$attributionEndsAt",
      });
    }
  });

  it("returns zero replies for a fresh conversation with no outbound (anchorSend is null)", () => {
    const stages = buildCandidateStages();

    const replyStatsLookup = findLookupStage(stages, "replyStats");
    const pipeline = JSON.stringify(replyStatsLookup?.$lookup.pipeline);
    expect(pipeline).toContain('"$ne":["$$anchorDate",null]');
    expect(pipeline).toContain('"$ne":["$$attributionEndsAt",null]');
  });
});

describe("bulk analytics paginated records pipelines", () => {
  it("applies cursor pagination to conversation records", () => {
    const stages = buildConversationRecordsPipeline({
      candidateStages: [{ $match: { workspaceId: "ws-1" } }],
      limit: 100,
      cursor: {
        sortAt: new Date("2026-04-20T12:00:00.000Z"),
        id: "507f1f77bcf86cd799439011",
      },
    });

    const cursorMatch = findMatchStage(stages, match => {
      const branches = match.$or as Array<Record<string, unknown>> | undefined;
      return Array.isArray(branches) && branches.length === 2;
    });

    expect(cursorMatch).toBeDefined();
    expect(stages).toContainEqual({ $limit: 101 });
  });
});

describe("keyword parsing", () => {
  it("treats spaces as phrase separators within a group", () => {
    expect(parseKeywordGroups("first word")).toEqual(["first word"]);
  });

  it("splits on comma, semicolon, and pipe into OR groups", () => {
    expect(parseKeywordGroups("first, word")).toEqual(["first", "word"]);
    expect(parseKeywordGroups("a;b|c")).toEqual(["a", "b", "c"]);
  });

  it("preserves phrases inside comma-separated groups", () => {
    expect(parseKeywordGroups("first word, foo")).toEqual([
      "first word",
      "foo",
    ]);
  });

  it("dedupes case-insensitively and drops empty groups", () => {
    expect(parseKeywordGroups("Foo, foo,, FOO ,bar")).toEqual(["Foo", "bar"]);
  });

  it("handles Cyrillic / Kazakh characters without splitting them", () => {
    expect(parseKeywordGroups("медаль за заказ, қанша")).toEqual([
      "медаль за заказ",
      "қанша",
    ]);
  });
});

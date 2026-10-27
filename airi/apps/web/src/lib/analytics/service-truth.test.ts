import {
  buildServiceTruthReport,
  measuredResolutionSeconds,
  measuredResolutionWholeSeconds,
} from "./service-truth";

const now = new Date("2026-10-02T12:00:00Z");

describe("service metric evidence", () => {
  it("uses stable resolution time and excludes unknown and timeout closures", () => {
    expect(
      measuredResolutionSeconds({
        status: "closed",
        first_inbound_at: "2026-10-01T12:00:00Z",
        service_resolved_at: "2026-10-01T12:10:00Z",
        service_resolution_kind: "manager",
        updatedAt: now,
      })
    ).toBe(600);
    expect(
      measuredResolutionSeconds({
        status: "closed",
        createdAt: "2026-10-01T12:00:00Z",
        updatedAt: now,
      })
    ).toBeNull();
    expect(
      measuredResolutionSeconds({
        status: "closed",
        first_inbound_at: "2026-10-01T12:00:00Z",
        service_resolved_at: now,
        service_resolution_kind: "timeout",
      })
    ).toBeNull();
  });

  it("gives customer webhooks whole measured seconds and omits unmeasured closes", () => {
    const measured = {
      status: "closed",
      service_episode_started_at: "2026-10-01T12:00:00.000Z",
      service_resolved_at: "2026-10-01T12:01:30.600Z",
      service_resolution_kind: "customer_csat",
    };
    expect(measuredResolutionSeconds(measured)).toBe(90.6);
    expect(measuredResolutionWholeSeconds(measured)).toBe(91);
    expect(
      measuredResolutionWholeSeconds({
        ...measured,
        service_resolution_kind: "timeout",
        csat_timeout_closed: true,
      })
    ).toBeUndefined();
  });

  it("includes unanswered conversations in response coverage and reports current age", () => {
    const report = buildServiceTruthReport({
      now,
      firstResponseRows: [
        {
          first_inbound_at: "2026-10-02T11:00:00Z",
          first_response_seconds: 60,
        },
        {
          first_inbound_at: "2026-10-02T10:00:00Z",
          first_response_seconds: null,
        },
        { first_inbound_at: "2026-10-02T09:00:00Z" },
      ],
      conversationRows: [],
    });
    expect(report.firstHumanResponse).toEqual({
      eligibleConversations: 3,
      answeredConversations: 1,
      unansweredConversations: 2,
      coverageRate: 100 / 3,
      oldestUnansweredSeconds: 10800,
      medianSeconds: 60,
      p90Seconds: 60,
    });
    expect(report.resolution.averageSeconds).toBeNull();
  });

  it("does not claim an unanswered denominator for a first-responder manager filter", () => {
    const report = buildServiceTruthReport({
      now,
      firstResponderFiltered: true,
      firstResponseRows: [
        { first_inbound_at: now, first_response_seconds: 60 },
      ],
      conversationRows: [],
    });
    expect(report.firstHumanResponse.eligibleConversations).toBeNull();
    expect(report.firstHumanResponse.unansweredConversations).toBeNull();
    expect(report.firstHumanResponse.coverageRate).toBeNull();
  });

  it("keeps aged-open backlog separate from resolution coverage", () => {
    const report = buildServiceTruthReport({
      now,
      firstResponseRows: [],
      conversationRows: [
        { status: "open", createdAt: "2026-09-01T00:00:00Z" },
        { status: "closed", csat_timeout_closed: true },
        { status: "closed" },
        {
          status: "closed",
          first_inbound_at: "2026-10-01T00:00:00Z",
          service_resolved_at: "2026-10-01T01:00:00Z",
          service_resolution_kind: "manager",
        },
      ],
    });
    expect(report.agedOpenPolicy).toEqual({ windowDays: 3, count: 1 });
    expect(report.resolution).toEqual({
      measuredResolvedConversations: 1,
      unknownClosedConversations: 1,
      timeoutClosedConversations: 1,
      averageSeconds: 3600,
      medianSeconds: 3600,
      p90Seconds: 3600,
    });
  });
});

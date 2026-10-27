/**
 * @jest-environment node
 */

import {
  assertWhatsAppQrManagerExplainPlan,
  buildWhatsAppQrManagerQueryShape,
} from "./query-plan";

const FACETS = [
  {
    facet: undefined,
    listHint: "whatsapp_qr_manager_list_base_v1",
    searchHint: "whatsapp_qr_manager_search_base_v1",
    expectedFilter: {},
  },
  {
    facet: { kind: "source" as const, value: "source-1" },
    listHint: "whatsapp_qr_manager_list_source_v1",
    searchHint: "whatsapp_qr_manager_search_source_v1",
    expectedFilter: { sourceId: "source-1" },
  },
  {
    facet: { kind: "status" as const, value: "ACTIVE" },
    listHint: "whatsapp_qr_manager_list_status_v1",
    searchHint: "whatsapp_qr_manager_search_status_v1",
    expectedFilter: { status: "ACTIVE" },
  },
  {
    facet: { kind: "assignment" as const, value: "unassigned" },
    listHint: "whatsapp_qr_manager_list_assignment_v1",
    searchHint: "whatsapp_qr_manager_search_assignment_v1",
    expectedFilter: { assignmentState: "unassigned" },
  },
] as const;

describe("WhatsApp QR Manager query plans", () => {
  it.each(FACETS)(
    "uses the exact $listHint no-search index and ordering",
    ({ facet, listHint, expectedFilter }) => {
      expect(
        buildWhatsAppQrManagerQueryShape({
          workspaceId: "workspace-1",
          facets: facet ? [facet] : [],
          limit: 21,
        })
      ).toEqual({
        mode: "list",
        filter: { workspaceId: "workspace-1", ...expectedFilter },
        sort: { updatedAt: -1, entryPointId: 1 },
        hint: listHint,
        collation: { locale: "simple" },
        limit: 21,
      });
    }
  );

  it.each(FACETS)(
    "uses the exact $searchHint normalized-prefix index and ordering",
    ({ facet, searchHint, expectedFilter }) => {
      expect(
        buildWhatsAppQrManagerQueryShape({
          workspaceId: "workspace-1",
          query: "  Ｓtore  ",
          facets: facet ? [facet] : [],
          limit: 11,
        })
      ).toEqual({
        mode: "search",
        filter: {
          workspaceId: "workspace-1",
          ...expectedFilter,
          placementNameSearch: { $gte: "store", $lt: "storf" },
        },
        sort: { placementNameSearch: 1, entryPointId: 1 },
        hint: searchHint,
        collation: { locale: "simple" },
        limit: 11,
      });
    }
  );

  it("adds list and search keyset predicates without regex or a sentinel", () => {
    const list = buildWhatsAppQrManagerQueryShape({
      workspaceId: "workspace-1",
      facets: [],
      after: {
        mode: "list",
        updatedAt: "2026-08-10T10:00:00.000Z",
        entryPointId: "11111111-1111-4111-8111-111111111111",
      },
      limit: 10,
    });
    const search = buildWhatsAppQrManagerQueryShape({
      workspaceId: "workspace-1",
      query: "store",
      facets: [],
      after: {
        mode: "search",
        placementNameSearch: "store front",
        entryPointId: "11111111-1111-4111-8111-111111111111",
      },
      limit: 10,
    });

    expect(list.filter).toEqual({
      workspaceId: "workspace-1",
      $or: [
        { updatedAt: { $lt: new Date("2026-08-10T10:00:00.000Z") } },
        {
          updatedAt: new Date("2026-08-10T10:00:00.000Z"),
          entryPointId: { $gt: "11111111-1111-4111-8111-111111111111" },
        },
      ],
    });
    expect(search.filter).toEqual({
      workspaceId: "workspace-1",
      $and: [
        { placementNameSearch: { $gte: "store", $lt: "storf" } },
        {
          $or: [
            { placementNameSearch: { $gt: "store front", $lt: "storf" } },
            {
              placementNameSearch: "store front",
              entryPointId: {
                $gt: "11111111-1111-4111-8111-111111111111",
              },
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(search.filter)).not.toMatch(/regex|uffff/i);
  });

  it("rejects multiple facets instead of producing a scan fallback", () => {
    expect(() =>
      buildWhatsAppQrManagerQueryShape({
        workspaceId: "workspace-1",
        facets: [
          { kind: "source", value: "source-1" },
          { kind: "status", value: "ACTIVE" },
        ],
        limit: 10,
      })
    ).toThrow("INVALID_INPUT");
  });

  const indexedPlan = {
    queryPlanner: {
      winningPlan: {
        stage: "FETCH",
        inputStage: {
          stage: "IXSCAN",
          indexName: "whatsapp_qr_manager_list_base_v1",
        },
      },
    },
    executionStats: {
      nReturned: 10,
      totalDocsExamined: 10,
      totalKeysExamined: 11,
    },
  };

  it("accepts a bounded winning plan using the exact named index", () => {
    expect(() =>
      assertWhatsAppQrManagerExplainPlan({
        explain: indexedPlan,
        expectedIndexName: "whatsapp_qr_manager_list_base_v1",
        limit: 10,
      })
    ).not.toThrow();
  });

  it.each([
    {
      label: "collection scan",
      explain: {
        ...indexedPlan,
        queryPlanner: { winningPlan: { stage: "COLLSCAN" } },
      },
    },
    {
      label: "blocking sort",
      explain: {
        ...indexedPlan,
        queryPlanner: {
          winningPlan: {
            stage: "SORT",
            inputStage: indexedPlan.queryPlanner.winningPlan,
          },
        },
      },
    },
    {
      label: "execution-stage post-filter",
      explain: {
        ...indexedPlan,
        executionStats: {
          ...indexedPlan.executionStats,
          executionStages: {
            stage: "FETCH",
            filter: { status: { $eq: "ACTIVE" } },
            inputStage: { stage: "IXSCAN" },
          },
        },
      },
    },
    {
      label: "post-filter",
      explain: {
        ...indexedPlan,
        queryPlanner: {
          winningPlan: {
            stage: "FETCH",
            filter: { status: { $eq: "ACTIVE" } },
            inputStage: indexedPlan.queryPlanner.winningPlan.inputStage,
          },
        },
      },
    },
    {
      label: "wrong index",
      explain: {
        ...indexedPlan,
        queryPlanner: {
          winningPlan: {
            stage: "FETCH",
            inputStage: { stage: "IXSCAN", indexName: "wrong_index" },
          },
        },
      },
    },
    {
      label: "unbounded examined rows",
      explain: {
        ...indexedPlan,
        executionStats: {
          nReturned: 10,
          totalDocsExamined: 12,
          totalKeysExamined: 1000,
        },
      },
    },
  ])("rejects a $label", ({ explain }) => {
    expect(() =>
      assertWhatsAppQrManagerExplainPlan({
        explain,
        expectedIndexName: "whatsapp_qr_manager_list_base_v1",
        limit: 10,
      })
    ).toThrow("WHATSAPP_QR_MANAGER_QUERY_PLAN_INVALID");
  });
});

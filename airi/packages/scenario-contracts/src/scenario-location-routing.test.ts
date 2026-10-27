import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_LOCATION_ANY_OFFICE_OUTCOME_HANDLE_ID,
  ACTION_LOCATION_OUTSIDE_OUTCOME_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  DEFAULT_SCENARIO_LOCATION_MAX_DISTANCE_KM,
  MAX_SCENARIO_LOCATION_ROUTES,
  MAX_SCENARIO_LOCATION_ROUTE_VALUES,
  MAX_SCENARIO_ROUTED_LOCATIONS,
  POST_ACTION_LOCATION_ANY_OFFICE_HANDLE_ID,
  POST_ACTION_LOCATION_OUTSIDE_HANDLE_ID,
  SCENARIO_ACTION_OUTCOMES_LOCATION_VERSION,
  SCENARIO_BUSINESS_LOCATION_ISSUES,
  SCENARIO_BUSINESS_LOCATION_LIMITS,
  SCENARIO_LOCATION_OUTLIER_DISTANCE_KM,
  SCENARIO_LOCATION_WAIT_SKEW_MS,
  buildPostActionAnswerMatchHandleId,
  buildPostActionConditionHandleId,
  buildPostActionLocationRouteHandleId,
  buildScenarioActionAnswerOutcomeHandleId,
  buildScenarioActionLocationRouteOutcomeHandleId,
  buildScenarioActionOutcomeHandleId,
  buildScenarioBusinessLocationKey,
  buildScenarioLocationCityValue,
  buildScenarioLocationMapsUrl,
  findNearestScenarioBusinessLocation,
  findScenarioLocationOutlierOffices,
  getConfiguredScenarioActionOutcomeHandleIds,
  getScenarioActionOutcomeVirtualNodeId,
  isPostActionReplyClaimHandleId,
  isSupportedScenarioTemplateToken,
  listScenarioBusinessLocationIssues,
  listScenarioTemplateContextPaths,
  lowerScenarioRoutingGraph,
  mapPostActionConditionHandleToActionOutcomeHandle,
  measureScenarioLocationDistanceMeters,
  normalizeScenarioActionLocationRoutes,
  normalizeScenarioActionOutcomes,
  normalizeScenarioActionRunConditions,
  normalizeScenarioBusinessLocation,
  normalizeScenarioBusinessLocationKey,
  normalizeScenarioRoutedLocations,
  normalizeScenarioSharedLocationPoint,
  parsePostActionAnswerMatchHandleId,
  parsePostActionConditionHandleId,
  parsePostActionLocationHandleId,
  parseScenarioActionOutcomeHandleId,
  parseScenarioLocationCoordinate,
  parseScenarioLocationInput,
  readScenarioLocationLookupBounds,
  readScenarioRoutedLocations,
  readScenarioRoutedOffice,
  readScenarioRoutedOfficeTemplateValues,
  recordScenarioRoutedLocation,
  resolveScenarioLocationRoute,
  summarizeScenarioLocationRouteCoverage,
  toScenarioRoutedLocationOffice,
  transliterateScenarioKeyText,
  type ScenarioActionLocationRoutes,
  type ScenarioBusinessLocation,
  type ScenarioBusinessLocationIssue,
  type ScenarioLocationPoint,
  type ScenarioRoutedLocationEntry,
} from "./index.ts";

function office(
  overrides: Partial<ScenarioBusinessLocation> & { key: string },
): ScenarioBusinessLocation {
  const normalized = normalizeScenarioBusinessLocation({
    name: overrides.key,
    country: "KZ",
    city: "Almaty",
    latitude: 43.238949,
    longitude: 76.889709,
    tags: [],
    sortOrder: 0,
    ...overrides,
  });
  assert.ok(normalized, `office ${overrides.key} should normalize`);
  return normalized;
}

const abay = office({
  key: "almaty_abay",
  name: "Abay",
  latitude: 43.24,
  longitude: 76.91,
  tags: ["flagship"],
  address: "Abay Ave 10",
  phone: "+7 727 000 00 00",
});
const dostyk = office({
  key: "almaty_dostyk",
  name: "Dostyk",
  latitude: 43.22,
  longitude: 76.96,
});
const astana = office({
  key: "astana_center",
  name: "Center",
  city: "Astana",
  latitude: 51.169392,
  longitude: 71.449074,
  mapUrl: "https://2gis.kz/astana/firm/1",
});
const tashkent = office({
  key: "tashkent_1",
  name: "Chilonzor",
  country: "UZ",
  city: "Tashkent",
  latitude: 41.2995,
  longitude: 69.2401,
});
const offices = [abay, dostyk, astana, tashkent];

const nearAbay = { latitude: 43.2401, longitude: 76.9101 };

function routing(value: Record<string, unknown>): ScenarioActionLocationRoutes {
  const normalized = normalizeScenarioActionLocationRoutes(value);
  assert.ok(normalized);
  return normalized;
}

describe("location route normalization", () => {
  it("keeps a route with no values yet, so editing never drops its connection", () => {
    assert.deepEqual(
      normalizeScenarioActionLocationRoutes({
        routes: [
          {
            id: "loc_kz",
            label: "  Kazakhstan ",
            match: { by: "country", values: [] },
          },
        ],
      }),
      {
        routes: [
          {
            id: "loc_kz",
            label: "Kazakhstan",
            match: { by: "country", values: [] },
          },
        ],
      },
    );
  });

  it("normalizes values per kind, drops unreadable ones and de-duplicates", () => {
    const normalized = routing({
      routes: [
        {
          id: "a",
          match: { by: "country", values: ["kz", "KZ", "Kazakhstan", 7] },
        },
        {
          id: "b",
          match: { by: "city", values: ["kz: Almaty ", "KZ:almaty", "Almaty"] },
        },
        {
          id: "c",
          match: { by: "tag", values: [" Flagship ", "flagship", ""] },
        },
        {
          id: "d",
          match: { by: "office", values: ["almaty_abay", "bad key!"] },
        },
      ],
    });
    assert.deepEqual(
      normalized.routes.map((route) => route.match.values),
      [["KZ"], ["KZ:almaty"], ["flagship"], ["almaty_abay"]],
    );
  });

  it("drops a route of an unknown kind and makes ids unique", () => {
    const normalized = routing({
      routes: [
        { id: "same", match: { by: "country", values: ["KZ"] } },
        { id: "same", match: { by: "country", values: ["UZ"] } },
        { id: "x", match: { by: "polygon", values: [] } },
        { match: { by: "tag", values: ["vip"] } },
      ],
    });
    assert.deepEqual(
      normalized.routes.map((route) => route.id),
      ["same", "same_2", "location_4"],
    );
  });

  it("keeps renamed ids within the id limit, so each handle names one route", () => {
    const long = "x".repeat(80);
    const normalized = routing({
      routes: [
        { id: `${long}a`, match: { by: "country", values: ["KZ"] } },
        { id: `${long}b`, match: { by: "country", values: ["UZ"] } },
      ],
    });
    const ids = normalized.routes.map((route) => route.id);
    assert.equal(new Set(ids).size, 2);
    for (const id of ids) {
      assert.ok(id.length <= 80, id);
      assert.equal(
        parseScenarioActionOutcomeHandleId(
          buildScenarioActionLocationRouteOutcomeHandleId(id),
        )?.type,
        "location_route",
      );
      assert.deepEqual(
        parsePostActionLocationHandleId(
          buildPostActionLocationRouteHandleId(id),
        ),
        { type: "location_route", routeId: id },
      );
    }
  });

  it("bounds routes and values", () => {
    const normalized = routing({
      routes: Array.from({ length: 30 }, (_, index) => ({
        id: `r${index}`,
        match: {
          by: "office",
          values: Array.from({ length: 80 }, (_, value) => `o${value}`),
        },
      })),
    });
    assert.equal(normalized.routes.length, MAX_SCENARIO_LOCATION_ROUTES);
    assert.equal(
      normalized.routes[0]?.match.values.length,
      MAX_SCENARIO_LOCATION_ROUTE_VALUES,
    );
  });

  it("keeps the cutoff while its switch is on, clamping an unreadable distance", () => {
    assert.deepEqual(routing({ routes: [], outside: {} }).outside, {
      maxDistanceKm: DEFAULT_SCENARIO_LOCATION_MAX_DISTANCE_KM,
    });
    assert.deepEqual(
      routing({ routes: [], outside: { maxDistanceKm: "" } }).outside,
      {
        maxDistanceKm: DEFAULT_SCENARIO_LOCATION_MAX_DISTANCE_KM,
      },
    );
    assert.deepEqual(
      routing({ routes: [], outside: { maxDistanceKm: 0 } }).outside,
      {
        maxDistanceKm: 1,
      },
    );
    assert.deepEqual(
      routing({ routes: [], outside: { maxDistanceKm: 99_999 } }).outside,
      { maxDistanceKm: 20_000 },
    );
    assert.deepEqual(
      routing({ routes: [], outside: { maxDistanceKm: "12,6" } }).outside,
      { maxDistanceKm: 13 },
    );
    assert.equal(routing({ routes: [] }).outside, undefined);
  });

  it("builds city values that keep same-name cities of two countries apart", () => {
    assert.equal(buildScenarioLocationCityValue("kz", " Almaty "), "KZ:almaty");
    assert.notEqual(
      buildScenarioLocationCityValue("US", "Paris"),
      buildScenarioLocationCityValue("FR", "Paris"),
    );
    assert.equal(buildScenarioLocationCityValue("", "Almaty"), null);
  });
});

describe("action outcomes with location routes", () => {
  it("stores outcomes with location routes as version 2", () => {
    const normalized = normalizeScenarioActionOutcomes({
      version: 1,
      noReply: { enabled: true, timeoutMinutes: 30 },
      locationRoutes: { routes: [], outside: { maxDistanceKm: 100 } },
    });
    assert.equal(normalized.status, "supported");
    assert.equal(
      normalized.value?.version,
      SCENARIO_ACTION_OUTCOMES_LOCATION_VERSION,
    );
    assert.deepEqual(normalized.value?.locationRoutes, {
      routes: [],
      outside: { maxDistanceKm: 100 },
    });
  });

  it("reads version 2 back, and writes version 1 once the routes are gone", () => {
    const normalized = normalizeScenarioActionOutcomes({
      version: 2,
      anyReply: { enabled: true },
    });
    assert.equal(normalized.status, "supported");
    assert.equal(normalized.value?.version, 1);
  });

  it("keeps later versions unsupported", () => {
    assert.equal(
      normalizeScenarioActionOutcomes({
        version: 3,
        locationRoutes: { routes: [] },
      }).status,
      "unsupported",
    );
  });

  it("keeps run conditions on version 1 only", () => {
    assert.equal(
      normalizeScenarioActionRunConditions({
        version: 2,
        match: "all",
        conditions: [],
      }).status,
      "unsupported",
    );
  });
});

describe("location route handles", () => {
  it("round-trips step handles strictly", () => {
    const handle = buildScenarioActionLocationRouteOutcomeHandleId("loc_kz");
    assert.deepEqual(parseScenarioActionOutcomeHandleId(handle), {
      type: "location_route",
      routeId: "loc_kz",
    });
    assert.equal(
      buildScenarioActionOutcomeHandleId({
        type: "location_route",
        routeId: "loc_kz",
      }),
      handle,
    );
    assert.deepEqual(
      parseScenarioActionOutcomeHandleId(
        ACTION_LOCATION_ANY_OFFICE_OUTCOME_HANDLE_ID,
      ),
      { type: "location_any_office" },
    );
    assert.deepEqual(
      parseScenarioActionOutcomeHandleId(
        ACTION_LOCATION_OUTSIDE_OUTCOME_HANDLE_ID,
      ),
      { type: "location_outside" },
    );
    assert.equal(
      parseScenarioActionOutcomeHandleId(
        `${handle.slice(0, -6)}${encodeURIComponent("bad id")}`,
      ),
      null,
    );
    assert.equal(
      parseScenarioActionOutcomeHandleId(
        "right-source-action-outcome::location::",
      ),
      null,
    );
  });

  it("lists every handle the step's routes own", () => {
    assert.deepEqual(
      getConfiguredScenarioActionOutcomeHandleIds({
        version: 2,
        noReply: { enabled: true, timeoutMinutes: 10 },
        locationRoutes: {
          routes: [
            { id: "loc_kz", match: { by: "country", values: ["KZ"] } },
            { id: "loc_uz", match: { by: "country", values: [] } },
          ],
          outside: { maxDistanceKm: 50 },
        },
      }),
      [
        ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
        buildScenarioActionLocationRouteOutcomeHandleId("loc_kz"),
        buildScenarioActionLocationRouteOutcomeHandleId("loc_uz"),
        ACTION_LOCATION_ANY_OFFICE_OUTCOME_HANDLE_ID,
        ACTION_LOCATION_OUTSIDE_OUTCOME_HANDLE_ID,
      ],
    );
  });

  it("parses compiled wait handles strictly and never as answers or fixed types", () => {
    const routeHandle = buildPostActionLocationRouteHandleId("loc_kz");
    assert.deepEqual(parsePostActionLocationHandleId(routeHandle), {
      type: "location_route",
      routeId: "loc_kz",
    });
    assert.deepEqual(
      parsePostActionLocationHandleId(
        POST_ACTION_LOCATION_ANY_OFFICE_HANDLE_ID,
      ),
      { type: "location_any_office" },
    );
    assert.deepEqual(
      parsePostActionLocationHandleId(POST_ACTION_LOCATION_OUTSIDE_HANDLE_ID),
      { type: "location_outside" },
    );
    assert.equal(parsePostActionLocationHandleId(`${routeHandle}!`), null);
    for (const handle of [
      routeHandle,
      POST_ACTION_LOCATION_ANY_OFFICE_HANDLE_ID,
      POST_ACTION_LOCATION_OUTSIDE_HANDLE_ID,
    ]) {
      assert.equal(parsePostActionAnswerMatchHandleId(handle), null);
      assert.equal(parsePostActionConditionHandleId(handle), null);
      assert.equal(isPostActionReplyClaimHandleId(handle), true);
    }
    assert.equal(
      parsePostActionLocationHandleId(
        buildPostActionAnswerMatchHandleId("answer_1"),
      ),
      null,
    );
    assert.equal(
      isPostActionReplyClaimHandleId(
        buildPostActionConditionHandleId("user_replied"),
      ),
      false,
    );
  });

  it("maps compiled wait handles back to the step's handles", () => {
    assert.equal(
      mapPostActionConditionHandleToActionOutcomeHandle(
        buildPostActionLocationRouteHandleId("loc_kz"),
      ),
      buildScenarioActionLocationRouteOutcomeHandleId("loc_kz"),
    );
    assert.equal(
      mapPostActionConditionHandleToActionOutcomeHandle(
        POST_ACTION_LOCATION_OUTSIDE_HANDLE_ID,
      ),
      ACTION_LOCATION_OUTSIDE_OUTCOME_HANDLE_ID,
    );
    assert.equal(
      mapPostActionConditionHandleToActionOutcomeHandle(
        buildPostActionAnswerMatchHandleId("answer_1"),
      ),
      buildScenarioActionAnswerOutcomeHandleId("answer_1"),
    );
    assert.equal(
      mapPostActionConditionHandleToActionOutcomeHandle(
        buildPostActionConditionHandleId("user_replied"),
      ),
      ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
    );
    assert.equal(
      mapPostActionConditionHandleToActionOutcomeHandle("right-source"),
      null,
    );
  });
});

describe("location route lowering", () => {
  const locationRoutes = {
    routes: [
      { id: "loc_kz", match: { by: "country", values: ["KZ"] } },
      { id: "loc_uz", match: { by: "country", values: ["UZ"] } },
    ],
    outside: { maxDistanceKm: 100 },
  };
  const action = {
    id: "ask",
    data: {
      kind: "action",
      actionType: "reply",
      actionOutcomes: { version: 2, locationRoutes },
    },
  };
  const step = (id: string) => ({
    id,
    data: { kind: "action", actionType: "reply" },
  });

  it("re-sources every route from the wait, with no condition branch", () => {
    const lowered = lowerScenarioRoutingGraph({
      nodes: [action, step("kz"), step("uz"), step("other"), step("far")],
      edges: [
        {
          id: "e1",
          source: "ask",
          target: "kz",
          sourceHandle:
            buildScenarioActionLocationRouteOutcomeHandleId("loc_kz"),
        },
        {
          id: "e2",
          source: "ask",
          target: "uz",
          sourceHandle:
            buildScenarioActionLocationRouteOutcomeHandleId("loc_uz"),
        },
        {
          id: "e3",
          source: "ask",
          target: "other",
          sourceHandle: ACTION_LOCATION_ANY_OFFICE_OUTCOME_HANDLE_ID,
        },
        {
          id: "e4",
          source: "ask",
          target: "far",
          sourceHandle: ACTION_LOCATION_OUTSIDE_OUTCOME_HANDLE_ID,
        },
      ],
    });
    assert.deepEqual(lowered.diagnostics, []);
    const virtualId = getScenarioActionOutcomeVirtualNodeId("ask");
    const virtualNode = lowered.nodes.find((node) => node.id === virtualId);
    assert.deepEqual(
      (virtualNode?.data as { conditionBranches?: unknown[] })
        .conditionBranches,
      [],
    );
    const fromWait = lowered.edges
      .filter((edge) => edge.source === virtualId)
      .map((edge) => [edge.sourceHandle, edge.target]);
    assert.deepEqual(fromWait, [
      [buildPostActionLocationRouteHandleId("loc_kz"), "kz"],
      [buildPostActionLocationRouteHandleId("loc_uz"), "uz"],
      [POST_ACTION_LOCATION_ANY_OFFICE_HANDLE_ID, "other"],
      [POST_ACTION_LOCATION_OUTSIDE_HANDLE_ID, "far"],
    ]);
    const ids = lowered.edges.map((edge) => edge.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("blocks raw duplicate route ids", () => {
    const lowered = lowerScenarioRoutingGraph({
      nodes: [
        {
          id: "ask",
          data: {
            kind: "action",
            actionOutcomes: {
              version: 2,
              locationRoutes: {
                routes: [
                  { id: "dup", match: { by: "country", values: ["KZ"] } },
                  { id: "dup", match: { by: "country", values: ["UZ"] } },
                ],
              },
            },
          },
        },
      ],
      edges: [],
    });
    assert.deepEqual(
      lowered.diagnostics.map((diagnostic) => diagnostic.code),
      ["duplicate_action_location_route_id"],
    );
  });

  it("blocks ids that only differ before normalization", () => {
    const long = "x".repeat(80);
    for (const ids of [
      ["kz route", "kz_route"],
      [`${long}a`, `${long}b`],
    ]) {
      const lowered = lowerScenarioRoutingGraph({
        nodes: [
          {
            id: "ask",
            data: {
              kind: "action",
              actionOutcomes: {
                version: 2,
                locationRoutes: {
                  routes: ids.map((id) => ({
                    id,
                    match: { by: "country", values: ["KZ"] },
                  })),
                },
              },
            },
          },
        ],
        edges: [],
      });
      assert.deepEqual(
        lowered.diagnostics.map((diagnostic) => diagnostic.code),
        ["duplicate_action_location_route_id"],
        ids.join(" / "),
      );
    }
  });

  it("treats a cutoff route without a cutoff as not configured", () => {
    const lowered = lowerScenarioRoutingGraph({
      nodes: [
        {
          id: "ask",
          data: {
            kind: "action",
            actionOutcomes: { version: 2, locationRoutes: { routes: [] } },
          },
        },
        step("far"),
      ],
      edges: [
        {
          id: "e1",
          source: "ask",
          target: "far",
          sourceHandle: ACTION_LOCATION_OUTSIDE_OUTCOME_HANDLE_ID,
        },
      ],
    });
    assert.deepEqual(
      lowered.diagnostics.map((diagnostic) => diagnostic.code),
      ["mixed_action_outcome_ownership"],
    );
  });
});

describe("nearest office decision", () => {
  it("measures straight-line distance in metres", () => {
    assert.equal(measureScenarioLocationDistanceMeters(nearAbay, nearAbay), 0);
    const almatyToAstana = measureScenarioLocationDistanceMeters(abay, astana);
    assert.ok(
      almatyToAstana > 960_000 && almatyToAstana < 985_000,
      String(almatyToAstana),
    );
  });

  it("breaks equal distances by sort order, then key", () => {
    const point = { latitude: 43.5, longitude: 77 };
    const twinA = office({
      key: "b_twin",
      latitude: 43.6,
      longitude: 77,
      sortOrder: 1,
    });
    const twinB = office({
      key: "a_twin",
      latitude: 43.6,
      longitude: 77,
      sortOrder: 1,
    });
    const twinC = office({
      key: "c_twin",
      latitude: 43.6,
      longitude: 77,
      sortOrder: 0,
    });
    assert.equal(
      findNearestScenarioBusinessLocation([twinA, twinB], point)?.office.key,
      "a_twin",
    );
    assert.equal(
      findNearestScenarioBusinessLocation([twinA, twinB, twinC], point)?.office
        .key,
      "c_twin",
    );
  });

  it("takes the first route whose group holds the nearest office", () => {
    const decision = resolveScenarioLocationRoute({
      routing: routing({
        routes: [
          { id: "flagship", match: { by: "tag", values: ["flagship"] } },
          { id: "kz", match: { by: "country", values: ["KZ"] } },
        ],
      }),
      offices,
      point: nearAbay,
    });
    assert.equal(decision.outcome, "route");
    assert.equal(decision.outcome === "route" && decision.routeId, "flagship");
    assert.equal(
      decision.outcome === "route" && decision.office.key,
      "almaty_abay",
    );
  });

  it("matches countries, cities and office keys of the nearest office", () => {
    const point = { latitude: 41.3, longitude: 69.24 };
    for (const match of [
      { by: "country", values: ["UZ"] },
      { by: "city", values: ["UZ:tashkent"] },
      { by: "office", values: ["tashkent_1"] },
    ]) {
      const decision = resolveScenarioLocationRoute({
        routing: routing({ routes: [{ id: "r", match }] }),
        offices,
        point,
      });
      assert.equal(decision.outcome, "route", JSON.stringify(match));
    }
  });

  it("sends the rest to Any other office", () => {
    const decision = resolveScenarioLocationRoute({
      routing: routing({
        routes: [{ id: "uz", match: { by: "country", values: ["UZ"] } }],
      }),
      offices,
      point: nearAbay,
    });
    assert.equal(decision.outcome, "any_office");
  });

  it("sends a far point past the cutoff, inclusive of the limit itself", () => {
    const point = { latitude: 43.24, longitude: 76.91 };
    const far = resolveScenarioLocationRoute({
      routing: routing({ routes: [], outside: { maxDistanceKm: 1 } }),
      offices: [astana],
      point,
    });
    assert.equal(far.outcome, "outside");
    assert.equal(far.outcome === "outside" && far.office?.key, "astana_center");

    const limitMeters = measureScenarioLocationDistanceMeters(point, dostyk);
    assert.ok(limitMeters > 0);
    const atLimit = resolveScenarioLocationRoute({
      routing: { routes: [], outside: { maxDistanceKm: limitMeters / 1000 } },
      offices: [dostyk],
      point,
    });
    assert.equal(atLimit.outcome, "any_office");
    const pastLimit = resolveScenarioLocationRoute({
      routing: {
        routes: [],
        outside: { maxDistanceKm: (limitMeters - 1) / 1000 },
      },
      offices: [dostyk],
      point,
    });
    assert.equal(pastLimit.outcome, "outside");
  });

  it("decides an empty catalog by the cutoff switch", () => {
    assert.deepEqual(
      resolveScenarioLocationRoute({
        routing: routing({ routes: [], outside: { maxDistanceKm: 100 } }),
        offices: [],
        point: nearAbay,
      }),
      { outcome: "outside", office: null, distanceMeters: null },
    );
    assert.deepEqual(
      resolveScenarioLocationRoute({
        routing: routing({ routes: [] }),
        offices: [],
        point: nearAbay,
      }),
      { outcome: "no_office" },
    );
  });

  it("counts offices per route by first match", () => {
    assert.deepEqual(
      summarizeScenarioLocationRouteCoverage(
        routing({
          routes: [
            { id: "almaty", match: { by: "city", values: ["KZ:almaty"] } },
            { id: "kz", match: { by: "country", values: ["KZ"] } },
          ],
        }),
        offices,
      ),
      {
        routes: [
          { routeId: "almaty", officeCount: 2 },
          { routeId: "kz", officeCount: 1 },
        ],
        anyOfficeCount: 1,
      },
    );
  });
});

describe("shared points and offices", () => {
  it("accepts only numeric, in-range points away from 0,0", () => {
    assert.deepEqual(normalizeScenarioSharedLocationPoint(nearAbay), nearAbay);
    assert.equal(
      normalizeScenarioSharedLocationPoint({ latitude: "43", longitude: "76" }),
      null,
    );
    assert.equal(
      normalizeScenarioSharedLocationPoint({ latitude: 91, longitude: 0 }),
      null,
    );
    assert.equal(
      normalizeScenarioSharedLocationPoint({ latitude: 0, longitude: 0 }),
      null,
    );
    assert.equal(
      normalizeScenarioSharedLocationPoint({ latitude: null, longitude: null }),
      null,
    );
  });

  it("keeps office text as typed but folds the values it compares", () => {
    const office = normalizeScenarioBusinessLocation({
      key: "almaty_5",
      name: "Филиал №5",
      country: "KZ",
      city: "Ａｌｍａｔｙ",
      address: "ул. Абая, 1, офис №12",
      tags: ["ＴＲＣ"],
      latitude: 43.24,
      longitude: 76.91,
    });
    assert.equal(office?.name, "Филиал №5");
    assert.equal(office?.address, "ул. Абая, 1, офис №12");
    assert.equal(office?.city, "Ａｌｍａｔｙ");
    assert.equal(office?.cityKey, "almaty");
    assert.deepEqual(office?.tags, ["trc"]);
    assert.deepEqual(
      listScenarioBusinessLocationIssues({
        key: "almaty_5",
        name: "Филиал №5",
        country: "KZ",
        city: "Almaty",
        latitude: 43.24,
        longitude: 76.91,
      }),
      [],
    );
  });

  it("parses merchant coordinates with a comma decimal", () => {
    assert.equal(
      parseScenarioLocationCoordinate("43,2389491", "latitude"),
      43.238949,
    );
    assert.equal(
      parseScenarioLocationCoordinate(" -76.5 ", "longitude"),
      -76.5,
    );
    assert.equal(parseScenarioLocationCoordinate("95", "latitude"), null);
    assert.equal(parseScenarioLocationCoordinate("abc", "longitude"), null);
    // A blank cell is not 0.
    assert.equal(parseScenarioLocationCoordinate("", "latitude"), null);
    assert.equal(parseScenarioLocationCoordinate("   ", "longitude"), null);
    assert.equal(
      normalizeScenarioBusinessLocation({
        key: "k",
        name: "n",
        country: "KZ",
        city: "c",
        latitude: "",
        longitude: 76.9,
      }),
      null,
    );
  });

  it("normalizes an office and refuses one it cannot route to", () => {
    assert.deepEqual(
      normalizeScenarioBusinessLocation({
        key: "almaty_abay",
        name: " Abay ",
        country: "kz",
        city: " Almaty ",
        latitude: "43,24",
        longitude: 76.91,
        tags: ["VIP", "vip", " Late hours "],
        mapUrl: "http://insecure.example",
      }),
      {
        key: "almaty_abay",
        name: "Abay",
        country: "KZ",
        city: "Almaty",
        cityKey: "almaty",
        tags: ["vip", "late hours"],
        latitude: 43.24,
        longitude: 76.91,
        sortOrder: 0,
      },
    );
    for (const missing of ["key", "name", "country", "city", "latitude"]) {
      const value: Record<string, unknown> = {
        key: "k",
        name: "n",
        country: "KZ",
        city: "c",
        latitude: 1,
        longitude: 1,
      };
      delete value[missing];
      assert.equal(normalizeScenarioBusinessLocation(value), null, missing);
    }
    assert.equal(
      normalizeScenarioBusinessLocation({
        key: "k",
        name: "n",
        country: "KZ",
        city: "c",
        latitude: 0,
        longitude: 0,
      }),
      null,
    );
  });
});

describe("office limits", () => {
  it("exports the limits the normalizer cuts at", () => {
    assert.deepEqual(SCENARIO_BUSINESS_LOCATION_LIMITS, {
      keyLength: 64,
      nameLength: 160,
      cityLength: 120,
      addressLength: 240,
      phoneLength: 40,
      mapUrlLength: 500,
      tags: 10,
      tagLength: 40,
    });
    const normalized = normalizeScenarioBusinessLocation({
      key: "k".repeat(64),
      name: "n".repeat(200),
      country: "KZ",
      city: "c".repeat(200),
      address: "a".repeat(300),
      phone: "1".repeat(50),
      mapUrl: `https://x.kz/${"m".repeat(488)}`,
      tags: [
        "t".repeat(50),
        ...Array.from({ length: 12 }, (_, index) => `tag${index}`),
      ],
      latitude: 1,
      longitude: 1,
    });
    assert.ok(normalized);
    assert.equal(normalized.key.length, 64);
    assert.equal(normalized.name.length, 160);
    assert.equal(normalized.city.length, 120);
    assert.equal(normalized.address?.length, 240);
    assert.equal(normalized.phone?.length, 40);
    assert.equal(normalized.mapUrl, undefined);
    assert.equal(normalized.tags.length, 10);
    assert.equal(normalized.tags[0]?.length, 40);
    assert.equal(normalizeScenarioBusinessLocationKey("k".repeat(65)), null);
    assert.equal(
      normalizeScenarioBusinessLocation({
        key: "k",
        name: "n",
        country: "KZ",
        city: "c",
        mapUrl: `https://x.kz/${"m".repeat(487)}`,
        latitude: 1,
        longitude: 1,
      })?.mapUrl?.length,
      500,
    );
  });
});

describe("location input parsing", () => {
  function point(latitude: number, longitude: number, source: string) {
    return { status: "point", point: { latitude, longitude }, source };
  }

  it("refuses long whitespace runs and oversized text quickly", () => {
    const started = Date.now();
    assert.deepEqual(
      parseScenarioLocationInput("1" + " ".repeat(1_900) + "x"),
      {
        status: "invalid",
      },
    );
    assert.deepEqual(
      parseScenarioLocationInput("1" + " ".repeat(32_000) + "2"),
      {
        status: "invalid",
      },
    );
    assert.deepEqual(
      parseScenarioLocationInput(
        "https://www.google.com/maps?q=1" + "%20".repeat(600) + "x",
      ),
      { status: "no_coordinates" },
    );
    assert.ok(Date.now() - started < 500);
  });

  it("reads a pasted pair with dot or comma decimals", () => {
    for (const [text, latitude, longitude] of [
      ["43.238949, 76.889709", 43.238949, 76.889709],
      ["43.238949,76.889709", 43.238949, 76.889709],
      ["43,238949; 76,889709", 43.238949, 76.889709],
      ["43,238949 76,889709", 43.238949, 76.889709],
      ["43,24,76,91", 43.24, 76.91],
      ["  -33.8688   151.2093  ", -33.8688, 151.2093],
      ["43.2389491, -76.8897094", 43.238949, -76.889709],
      ["-90;180", -90, 180],
    ] as const) {
      assert.deepEqual(
        parseScenarioLocationInput(text),
        point(latitude, longitude, "coordinates"),
        text,
      );
    }
  });

  it("reads the ambiguous 43,2,76 as 43.2 and 76", () => {
    assert.deepEqual(
      parseScenarioLocationInput("43,2,76"),
      point(43.2, 76, "coordinates"),
    );
  });

  it("refuses empty, unreadable, out-of-range and 0,0 input", () => {
    for (const value of [
      undefined,
      null,
      43.24,
      { latitude: 43.24, longitude: 76.91 },
      "",
      "   ",
      "0, 0",
      "0,0",
      "91, 76.91",
      "43.24, 181",
      "Almaty, Abay Ave 10",
      "https://",
      "geo:43.24,76.91",
      "javascript:alert(1)",
      "ftp://www.google.com/maps?q=43.24,76.91",
      "https://www.google.com/maps?q=95,76.91",
      "https://www.google.com/maps/@0,0,3z",
      "https://www.google.com/maps/place/x/data=!3d0!4d0",
    ]) {
      assert.deepEqual(
        parseScenarioLocationInput(value),
        { status: "invalid" },
        String(value),
      );
    }
  });

  it("round-trips its own Google Maps links", () => {
    const points: ScenarioLocationPoint[] = [
      abay,
      astana,
      tashkent,
      { latitude: -33.8688, longitude: 151.2093 },
      { latitude: 40.712776, longitude: -74.005974 },
      { latitude: -90, longitude: 180 },
      { latitude: 0, longitude: 12.5 },
      { latitude: 1, longitude: -1 },
    ].map(({ latitude, longitude }) => ({ latitude, longitude }));
    for (const value of points) {
      assert.deepEqual(
        parseScenarioLocationInput(buildScenarioLocationMapsUrl(value)),
        { status: "point", point: value, source: "maps_link" },
        JSON.stringify(value),
      );
    }
  });

  it("reads the point of a full Google Maps link", () => {
    for (const link of [
      "https://maps.google.com/?q=43.24,76.91",
      "http://maps.google.com/?q=43.24,76.91",
      "https://www.google.com/maps/search/?api=1&query=43.24%2C76.91",
      "https://www.google.com/maps/dir/?api=1&destination=43.24,76.91",
      "https://maps.google.ru/maps?saddr=Home&daddr=43.24,76.91",
      "https://www.google.kz/maps?ll=43.24,76.91&z=15",
      "https://www.google.com/maps?q=loc:43.24+76.91",
      "https://www.google.com/maps?q=Abay+Ave&ll=43.24,76.91",
      "https://www.google.com/maps?q=43.24,76.91&ll=1,2",
      "https://www.google.co.uk/maps/@43.24,76.91,15z",
      "https://www.google.com.tr/maps/@43.24,76.91,15z",
      "www.google.com/maps?q=43.24,76.91",
      "google.com/maps?q=43.24,76.91",
      "maps.google.com/?q=43.24,76.91",
    ]) {
      assert.deepEqual(
        parseScenarioLocationInput(link),
        point(43.24, 76.91, "maps_link"),
        link,
      );
    }
  });

  it("prefers the last place pin over the map centre", () => {
    assert.deepEqual(
      parseScenarioLocationInput(
        "https://www.google.com/maps/place/Abay/@43.2,76.8,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d43.238949!4d76.889709!16s%2Fg%2F11",
      ),
      point(43.238949, 76.889709, "maps_link"),
    );
    assert.deepEqual(
      parseScenarioLocationInput(
        "https://www.google.com/maps/place/x/@1,2,17z/data=!3d1.5!4d2.5!8m2!3d43.24!4d76.91",
      ),
      point(43.24, 76.91, "maps_link"),
    );
    assert.deepEqual(
      parseScenarioLocationInput(
        "https://www.google.com/maps/place/x/data=%213d43.24%214d76.91",
      ),
      point(43.24, 76.91, "maps_link"),
    );
  });

  it("recognises short share links it never follows", () => {
    for (const link of [
      "https://maps.app.goo.gl/AbCdEf123",
      "maps.app.goo.gl/AbCdEf123",
      "https://goo.gl/maps/AbCdEf",
      "goo.gl/maps/AbCdEf",
      "https://go.2gis.com/abc12",
      "go.2gis.com/abc12",
      "https://yandex.ru/maps/-/CDu6aW~w",
      "https://yandex.kz/maps/-/CDu6aW~w",
      "https://www.yandex.com.tr/maps/-/CDu6aW~w",
    ]) {
      assert.deepEqual(
        parseScenarioLocationInput(link),
        { status: "short_link" },
        link,
      );
    }
  });

  it("never guesses a point from a link that names none", () => {
    for (const link of [
      "https://www.google.com/maps?q=Abay+Ave+10,+Almaty",
      "https://www.google.com/maps/place/Abay+Ave",
      "https://www.google.com/search?q=43.24,76.91",
      "https://google.evil.com/maps?q=43.24,76.91",
      "https://notgoogle.com/maps?q=43.24,76.91",
      "https://goo.gl/AbCdEf",
      "https://2gis.kz/almaty/firm/70000001/76.889709%2C43.238949",
      "https://yandex.kz/maps/?ll=76.889709%2C43.238949&z=16",
      "https://yandex.ru/maps/org/abay/123/",
      "https://www.openstreetmap.org/#map=16/43.24/76.91",
      "https://example.com/?q=43.24,76.91",
    ]) {
      assert.deepEqual(
        parseScenarioLocationInput(link),
        { status: "no_coordinates" },
        link,
      );
    }
  });
});

describe("derived office keys", () => {
  it("transliterates Russian and Kazakh letters to lower-case Latin", () => {
    assert.equal(transliterateScenarioKeyText("Әл-Фараби"), "al-farabi");
    assert.equal(transliterateScenarioKeyText("Имя клиента"), "imya klienta");
    assert.equal(
      transliterateScenarioKeyText("Жеткізу мекенжайы"),
      "zhetkizu mekenzhayy",
    );
    assert.equal(transliterateScenarioKeyText("ҒҚҢӨҰҮҺІ"), "gqnouuhi");
    assert.equal(transliterateScenarioKeyText("Ёлка Café"), "elka cafe");
    assert.equal(transliterateScenarioKeyText("Щука ъь"), "shchuka ");
    assert.equal(transliterateScenarioKeyText("Abay 10"), "abay 10");
  });

  it("builds country, city and name keys", () => {
    for (const [params, key] of [
      [{ country: "KZ", city: "Almaty", name: "Abay" }, "kz_almaty_abay"],
      [{ country: "kz", city: "Алматы", name: "Абай" }, "kz_almaty_abay"],
      [
        { country: "KZ", city: "Алматы", name: "Әл-Фараби" },
        "kz_almaty_al_farabi",
      ],
      [
        { country: "KZ", city: "Нұр-Сұлтан", name: "ТРЦ «Керуен»" },
        "kz_nur_sultan_trts_keruen",
      ],
      [
        { country: "KZ", city: "Алматы", name: "Филиал №5" },
        "kz_almaty_filial_no5",
      ],
      [
        { country: "UZ", city: "Tashkent", name: "Chilonzor 2" },
        "uz_tashkent_chilonzor_2",
      ],
      [{ country: "KZ", city: " ALMATY ", name: "  Abay  " }, "kz_almaty_abay"],
    ] as const) {
      assert.equal(
        buildScenarioBusinessLocationKey(params),
        key,
        JSON.stringify(params),
      );
    }
  });

  it("gives the same row the same key every time", () => {
    const row = { country: "KZ", city: "Алматы", name: "Әл-Фараби" };
    const first = buildScenarioBusinessLocationKey(row);
    assert.equal(buildScenarioBusinessLocationKey({ ...row }), first);
    assert.equal(buildScenarioBusinessLocationKey(row), first);
  });

  it("keeps different cities and same-name cities of two countries apart", () => {
    assert.notEqual(
      buildScenarioBusinessLocationKey({
        country: "KZ",
        city: "Almaty",
        name: "Center",
      }),
      buildScenarioBusinessLocationKey({
        country: "KZ",
        city: "Astana",
        name: "Center",
      }),
    );
    assert.equal(
      buildScenarioBusinessLocationKey({
        country: "US",
        city: "Paris",
        name: "Main",
      }),
      "us_paris_main",
    );
    assert.equal(
      buildScenarioBusinessLocationKey({
        country: "FR",
        city: "Paris",
        name: "Main",
      }),
      "fr_paris_main",
    );
  });

  it("stays within 64 characters and is a valid office key", () => {
    const long = buildScenarioBusinessLocationKey({
      country: "KZ",
      city: "Алматы",
      name: "Филиал на проспекте Абая и улице Желтоксан, торговый центр Mega Park",
    });
    assert.ok(long);
    assert.ok(long.length <= 64, long);
    assert.ok(long.startsWith("kz_almaty_filial_na_prospekte"), long);
    assert.equal(normalizeScenarioBusinessLocationKey(long), long);
    assert.ok(
      normalizeScenarioBusinessLocation({
        key: long,
        name: "n",
        country: "KZ",
        city: "Алматы",
        latitude: 43.24,
        longitude: 76.91,
      }),
    );
    // The 64th character is a separator, so the key ends one earlier.
    assert.equal(
      buildScenarioBusinessLocationKey({
        country: "KZ",
        city: "Almaty",
        name: `${"a".repeat(53)} b`,
      }),
      `kz_almaty_${"a".repeat(53)}`,
    );
  });

  it("returns null without a valid country, or a usable city and name", () => {
    for (const params of [
      { country: "Kazakhstan", city: "Almaty", name: "Abay" },
      { country: "", city: "Almaty", name: "Abay" },
      { country: 7, city: "Almaty", name: "Abay" },
      { country: undefined, city: "Almaty", name: "Abay" },
      { country: "KZ", city: "", name: "Abay" },
      { country: "KZ", city: "!!!", name: "Abay" },
      { country: "KZ", city: "北京", name: "Abay" },
      { country: "KZ", city: undefined, name: "Abay" },
      { country: "KZ", city: "Almaty", name: "—" },
      { country: "KZ", city: "Almaty", name: "中心" },
      { country: "KZ", city: "Almaty", name: 12 },
    ]) {
      assert.equal(
        buildScenarioBusinessLocationKey(params),
        null,
        JSON.stringify(params),
      );
    }
  });
});

describe("outlier pins", () => {
  const almatyPinnedInAstana = office({
    key: "almaty_far",
    latitude: astana.latitude,
    longitude: astana.longitude,
  });

  it("flags only the office far from the rest of its city, naming the nearest", () => {
    const toAbay = measureScenarioLocationDistanceMeters(
      almatyPinnedInAstana,
      abay,
    );
    const toDostyk = measureScenarioLocationDistanceMeters(
      almatyPinnedInAstana,
      dostyk,
    );
    assert.deepEqual(
      findScenarioLocationOutlierOffices([abay, dostyk, almatyPinnedInAstana]),
      [
        {
          key: "almaty_far",
          cityValue: "KZ:almaty",
          nearestKey: toAbay <= toDostyk ? "almaty_abay" : "almaty_dostyk",
          distanceMeters: Math.min(toAbay, toDostyk),
        },
      ],
    );
  });

  it("never flags a city with a single office", () => {
    assert.deepEqual(findScenarioLocationOutlierOffices(offices), []);
    // Alone in Almaty, so pinned in Astana it has no peer to be far from.
    assert.deepEqual(
      findScenarioLocationOutlierOffices([
        astana,
        tashkent,
        almatyPinnedInAstana,
      ]),
      [],
    );
    assert.deepEqual(findScenarioLocationOutlierOffices([]), []);
  });

  it("keeps same-name cities of two countries apart", () => {
    const usAlmaty = office({
      key: "us_almaty",
      country: "US",
      latitude: 40.7,
      longitude: -74,
    });
    const usAlmaty2 = office({
      key: "us_almaty_2",
      country: "US",
      latitude: 40.71,
      longitude: -74.01,
    });
    assert.deepEqual(
      findScenarioLocationOutlierOffices([abay, usAlmaty, dostyk, usAlmaty2]),
      [],
    );
  });

  it("groups by the stored city key, so Алматы and Almaty are two cities", () => {
    const cyrillic = office({
      key: "almaty_cyrillic",
      city: "Алматы",
      latitude: astana.latitude,
      longitude: astana.longitude,
    });
    assert.deepEqual(
      findScenarioLocationOutlierOffices([abay, dostyk, cyrillic]),
      [],
    );
  });

  it("flags both offices of a two-office city that are far apart", () => {
    assert.deepEqual(
      findScenarioLocationOutlierOffices([abay, almatyPinnedInAstana]).map(
        (outlier) => [outlier.key, outlier.nearestKey],
      ),
      [
        ["almaty_abay", "almaty_far"],
        ["almaty_far", "almaty_abay"],
      ],
    );
  });

  it("reports outliers in input order", () => {
    const astanaPinnedInAlmaty = office({
      key: "astana_far",
      city: "Astana",
      latitude: abay.latitude,
      longitude: abay.longitude,
    });
    const astanaNearby = office({
      key: "astana_left_bank",
      city: "Astana",
      latitude: 51.128,
      longitude: 71.43,
    });
    assert.deepEqual(
      findScenarioLocationOutlierOffices([
        astanaPinnedInAlmaty,
        abay,
        almatyPinnedInAstana,
        astana,
        dostyk,
        astanaNearby,
      ]).map((outlier) => outlier.key),
      ["astana_far", "almaty_far"],
    );
  });

  it("flags a pin only past the distance, 50 km by default", () => {
    assert.equal(SCENARIO_LOCATION_OUTLIER_DISTANCE_KM, 50);
    const apart = measureScenarioLocationDistanceMeters(abay, dostyk);
    assert.deepEqual(
      findScenarioLocationOutlierOffices([abay, dostyk], apart / 1000),
      [],
    );
    assert.deepEqual(
      findScenarioLocationOutlierOffices([abay, dostyk], (apart - 1) / 1000),
      [
        {
          key: "almaty_abay",
          cityValue: "KZ:almaty",
          nearestKey: "almaty_dostyk",
          distanceMeters: apart,
        },
        {
          key: "almaty_dostyk",
          cityValue: "KZ:almaty",
          nearestKey: "almaty_abay",
          distanceMeters: apart,
        },
      ],
    );
    // About 60 km east of Dostyk: past the default.
    const suburb = office({
      key: "almaty_suburb",
      latitude: 43.24,
      longitude: 77.7,
    });
    const suburbDistance = Math.min(
      measureScenarioLocationDistanceMeters(abay, suburb),
      measureScenarioLocationDistanceMeters(dostyk, suburb),
    );
    assert.ok(suburbDistance > 55_000, String(suburbDistance));
    assert.deepEqual(
      findScenarioLocationOutlierOffices([abay, dostyk, suburb]).map(
        (outlier) => outlier.key,
      ),
      ["almaty_suburb"],
    );
  });
});

describe("office field issues", () => {
  const BLOCKING_ISSUES: readonly ScenarioBusinessLocationIssue[] = [
    "key_invalid",
    "name_missing",
    "country_invalid",
    "city_missing",
    "latitude_invalid",
    "longitude_invalid",
    "coordinates_zero",
  ];
  const valid = {
    key: "almaty_abay",
    name: "Abay",
    country: "KZ",
    city: "Almaty",
    latitude: 43.24,
    longitude: 76.91,
  };

  it("lists nothing for an office stored as entered", () => {
    assert.deepEqual(listScenarioBusinessLocationIssues(valid), []);
    const atLimits = {
      key: "k".repeat(64),
      name: "n".repeat(160),
      country: "KZ",
      city: "c".repeat(120),
      address: "a".repeat(240),
      phone: "1".repeat(40),
      mapUrl: `https://x.kz/${"m".repeat(487)}`,
      tags: Array.from({ length: 10 }, (_, index) =>
        `${index}`.padEnd(40, "t"),
      ),
      latitude: "43,24",
      longitude: -76.91,
      sortOrder: -3,
    };
    assert.deepEqual(listScenarioBusinessLocationIssues(atLimits), []);
    assert.deepEqual(normalizeScenarioBusinessLocation(atLimits), {
      ...atLimits,
      cityKey: atLimits.city,
      latitude: 43.24,
    });
  });

  it("gives a non-record every blocking issue but the zero point", () => {
    for (const value of [null, undefined, "office", 5, [], [valid]]) {
      assert.deepEqual(
        listScenarioBusinessLocationIssues(value),
        [
          "key_invalid",
          "name_missing",
          "country_invalid",
          "city_missing",
          "latitude_invalid",
          "longitude_invalid",
        ],
        JSON.stringify(value),
      );
    }
  });

  it("names each field problem", () => {
    const cases: Array<
      [Record<string, unknown>, ScenarioBusinessLocationIssue[]]
    > = [
      [{ key: "bad key!" }, ["key_invalid"]],
      [{ key: "" }, ["key_invalid"]],
      [{ key: "k".repeat(65) }, ["key_invalid"]],
      [{ key: 7 }, ["key_invalid"]],
      [{ key: undefined }, ["key_invalid"]],
      [{ name: "" }, ["name_missing"]],
      [{ name: "   " }, ["name_missing"]],
      [{ name: 5 }, ["name_missing"]],
      [{ name: undefined }, ["name_missing"]],
      [{ name: "n".repeat(161) }, ["name_too_long"]],
      [{ name: `  ${"n".repeat(160)}  ` }, []],
      [{ name: "a  \n b" }, []],
      [{ country: "Kazakhstan" }, ["country_invalid"]],
      [{ country: "" }, ["country_invalid"]],
      [{ country: "kz" }, []],
      [{ city: "" }, ["city_missing"]],
      [{ city: "c".repeat(121) }, ["city_too_long"]],
      [{ address: "a".repeat(241) }, ["address_too_long"]],
      [{ address: "a".repeat(240) }, []],
      [{ address: "" }, []],
      [{ phone: "1".repeat(41) }, ["phone_too_long"]],
      [{ phone: "+7 727 000 00 00" }, []],
      [{ mapUrl: "http://maps.example" }, ["map_url_invalid"]],
      [{ mapUrl: "not a link" }, ["map_url_invalid"]],
      [{ mapUrl: `https://x.kz/${"m".repeat(488)}` }, ["map_url_invalid"]],
      [{ mapUrl: 5 }, ["map_url_invalid"]],
      [{ mapUrl: { href: "https://x.kz" } }, ["map_url_invalid"]],
      [{ mapUrl: "https://2gis.kz/almaty/firm/1" }, []],
      [{ mapUrl: "" }, []],
      [{ mapUrl: "   " }, []],
      [{ mapUrl: null }, []],
      [{ tags: "vip" }, ["tags_invalid"]],
      [{ tags: ["vip", 5] }, ["tags_invalid"]],
      [{ tags: [null] }, ["tags_invalid"]],
      // A spreadsheet splits tags on these.
      [{ tags: ["a|b"] }, ["tags_invalid"]],
      [{ tags: ["mall; vip"] }, ["tags_invalid"]],
      [{ tags: ["a, b"] }, ["tags_invalid"]],
      [
        { tags: Array.from({ length: 11 }, (_, index) => `t${index}`) },
        ["tags_too_many"],
      ],
      [
        {
          tags: [
            "VIP",
            "vip",
            " Vip ",
            "",
            "  ",
            ...Array.from({ length: 9 }, (_, index) => `t${index}`),
          ],
        },
        [],
      ],
      [{ tags: ["t".repeat(41)] }, ["tag_too_long"]],
      [{ tags: null }, []],
      [{ tags: [] }, []],
      [{ latitude: "abc" }, ["latitude_invalid"]],
      [{ latitude: 91 }, ["latitude_invalid"]],
      [{ latitude: "" }, ["latitude_invalid"]],
      [{ latitude: undefined }, ["latitude_invalid"]],
      [{ longitude: 181 }, ["longitude_invalid"]],
      [{ longitude: "  " }, ["longitude_invalid"]],
      [
        { latitude: null, longitude: null },
        ["latitude_invalid", "longitude_invalid"],
      ],
      [{ latitude: 0, longitude: 0 }, ["coordinates_zero"]],
      [{ latitude: "0,0", longitude: "0" }, ["coordinates_zero"]],
      [{ latitude: 0 }, []],
      [{ sortOrder: 1.5 }, ["sort_order_invalid"]],
      [{ sortOrder: "3" }, ["sort_order_invalid"]],
      [{ sortOrder: Number.NaN }, ["sort_order_invalid"]],
      [{ sortOrder: Number.POSITIVE_INFINITY }, ["sort_order_invalid"]],
      [{ sortOrder: 2 ** 53 }, ["sort_order_invalid"]],
      [{ sortOrder: null }, []],
      [{ sortOrder: -4 }, []],
    ];
    for (const [overrides, issues] of cases) {
      assert.deepEqual(
        listScenarioBusinessLocationIssues({ ...valid, ...overrides }),
        issues,
        JSON.stringify(overrides),
      );
    }
  });

  it("lists several issues in the order of the issue list", () => {
    assert.deepEqual(
      listScenarioBusinessLocationIssues({
        key: "x y",
        name: "",
        country: "Kazakhstan",
        city: "c".repeat(121),
        address: "a".repeat(241),
        phone: "1".repeat(41),
        mapUrl: "http://a.kz",
        tags: [
          5,
          "t".repeat(41),
          ...Array.from({ length: 11 }, (_, index) => `t${index}`),
        ],
        latitude: 0,
        longitude: 0,
        sortOrder: 0.5,
      }),
      SCENARIO_BUSINESS_LOCATION_ISSUES.filter(
        (issue) =>
          issue !== "city_missing" &&
          issue !== "name_too_long" &&
          issue !== "latitude_invalid" &&
          issue !== "longitude_invalid",
      ),
    );
  });

  it("reports what the lenient normalizer would quietly change", () => {
    for (const [overrides, changed] of [
      [{ name: "n".repeat(161) }, "name"],
      [{ city: "c".repeat(121) }, "city"],
      [{ address: "a".repeat(241) }, "address"],
      [{ phone: "1".repeat(41) }, "phone"],
      [{ mapUrl: "http://maps.example" }, "mapUrl"],
      [{ tags: ["t".repeat(41)] }, "tags"],
      [{ tags: Array.from({ length: 11 }, (_, index) => `t${index}`) }, "tags"],
      [{ tags: ["vip", 5, "late"] }, "tags"],
      [{ tags: "vip" }, "tags"],
      [{ sortOrder: 1.5 }, "sortOrder"],
    ] as const) {
      const entered: Record<string, unknown> = { ...valid, ...overrides };
      const normalized = normalizeScenarioBusinessLocation(entered);
      assert.ok(normalized, JSON.stringify(overrides));
      assert.notDeepEqual(
        normalized[changed],
        entered[changed],
        JSON.stringify(overrides),
      );
      assert.ok(
        listScenarioBusinessLocationIssues(entered).length > 0,
        JSON.stringify(overrides),
      );
    }
  });

  it("refuses an office exactly when a blocking issue is listed", () => {
    const choices: Record<string, unknown[]> = {
      key: ["almaty_abay", "bad key", "", undefined, 7, "k".repeat(65)],
      name: ["Abay", "", "  ", undefined, 5, "n".repeat(161)],
      country: ["KZ", "kz", "Kazakhstan", "", undefined],
      city: ["Almaty", "Алматы", "", " ", undefined, "c".repeat(121)],
      address: [undefined, "", "Abay Ave 10", "a".repeat(241), 5],
      phone: [undefined, "", "+7 727", "1".repeat(41)],
      mapUrl: [undefined, null, "", "https://x.kz", "http://x.kz", 5],
      tags: [undefined, null, [], ["vip"], "vip", [5], ["t".repeat(41)]],
      latitude: [43.24, "43,24", 0, "0", "", "abc", 91, -90, undefined],
      longitude: [76.91, "76,91", 0, "0", "", 181, -180, undefined],
      sortOrder: [undefined, null, 0, -1, 1.5, "2"],
    };
    let seed = 7;
    const pick = (values: unknown[]) => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return values[(seed >>> 16) % values.length];
    };
    const samples: unknown[] = [null, undefined, "x", 5, [], valid];
    for (let index = 0; index < 3_000; index += 1) {
      samples.push(
        Object.fromEntries(
          Object.entries(choices).map(([field, values]) => [
            field,
            pick(values),
          ]),
        ),
      );
    }
    let refused = 0;
    for (const sample of samples) {
      const issues = listScenarioBusinessLocationIssues(sample);
      const blocked = issues.some((issue) => BLOCKING_ISSUES.includes(issue));
      const isRefused = normalizeScenarioBusinessLocation(sample) === null;
      if (isRefused) refused += 1;
      assert.equal(isRefused, blocked, JSON.stringify(sample));
      for (const issue of issues) {
        assert.ok(SCENARIO_BUSINESS_LOCATION_ISSUES.includes(issue), issue);
      }
    }
    // Both sides of the invariant were exercised.
    assert.ok(refused > 0 && refused < samples.length, String(refused));
  });
});

function entry(
  overrides: Partial<ScenarioRoutedLocationEntry> & {
    inboundMessageId: string;
  },
): ScenarioRoutedLocationEntry {
  return {
    sourceActionNodeId: "ask",
    sharedAt: "2026-10-05T10:00:00.000Z",
    decidedAt: "2026-10-05T10:00:01.000Z",
    source: "turn",
    outcome: "route",
    routeId: "kz",
    office: toScenarioRoutedLocationOffice(abay),
    distanceMeters: 2_140,
    ...overrides,
  };
}

describe("routed location ledger", () => {
  it("records decisions for one scenario and replaces another's", () => {
    let state: unknown = recordScenarioRoutedLocation(
      { lockedScenarioId: "s1" },
      { scenarioId: "s0", entry: entry({ inboundMessageId: "m0" }) },
    );
    state = recordScenarioRoutedLocation(state, {
      scenarioId: "s1",
      entry: entry({ inboundMessageId: "m1" }),
    });
    assert.deepEqual(
      readScenarioRoutedLocations(state, "s1").map(
        (item) => item.inboundMessageId,
      ),
      ["m1"],
    );
    assert.deepEqual(readScenarioRoutedLocations(state, "s0"), []);
    assert.equal(
      (state as { lockedScenarioId: string }).lockedScenarioId,
      "s1",
    );
  });

  it("keeps the newest decisions and one entry per message", () => {
    let state: unknown = {};
    for (let index = 0; index < MAX_SCENARIO_ROUTED_LOCATIONS + 3; index += 1) {
      state = recordScenarioRoutedLocation(state, {
        scenarioId: "s1",
        entry: entry({ inboundMessageId: `m${index}` }),
      });
    }
    state = recordScenarioRoutedLocation(state, {
      scenarioId: "s1",
      entry: entry({
        inboundMessageId: "m12",
        outcome: "unrouted",
        reason: "not_connected",
      }),
    });
    const entries = readScenarioRoutedLocations(state, "s1");
    assert.equal(entries.length, MAX_SCENARIO_ROUTED_LOCATIONS);
    assert.equal(entries[0]?.inboundMessageId, "m3");
    assert.equal(entries.at(-1)?.outcome, "unrouted");
    assert.equal(
      entries.filter((item) => item.inboundMessageId === "m12").length,
      1,
    );
  });

  it("drops unusable entries and never stores a share's own coordinates", () => {
    const ledger = normalizeScenarioRoutedLocations({
      scenarioId: "s1",
      entries: [
        { ...entry({ inboundMessageId: "m1" }), latitude: 1, longitude: 2 },
        { ...entry({ inboundMessageId: "m2" }), source: "guess" },
        { inboundMessageId: "m3" },
      ],
    });
    assert.deepEqual(
      ledger?.entries.map((item) => item.inboundMessageId),
      ["m1"],
    );
    assert.equal("latitude" in (ledger?.entries[0] ?? {}), false);
  });

  it("reads the latest decision that found an office", () => {
    let state: unknown = recordScenarioRoutedLocation(
      {},
      { scenarioId: "s1", entry: entry({ inboundMessageId: "m1" }) },
    );
    state = recordScenarioRoutedLocation(state, {
      scenarioId: "s1",
      entry: entry({
        inboundMessageId: "m2",
        outcome: "unrouted",
        reason: "not_connected",
      }),
    });
    assert.equal(readScenarioRoutedOffice(state, "s1")?.inboundMessageId, "m1");
    assert.equal(readScenarioRoutedOffice(state, "other"), null);
  });

  it("reads a newer routed decision without an office as empty, not an older office", () => {
    let state: unknown = recordScenarioRoutedLocation(
      {},
      { scenarioId: "s1", entry: entry({ inboundMessageId: "m1" }) },
    );
    const outsideWithoutOffice = entry({
      inboundMessageId: "m2",
      outcome: "outside",
    });
    delete outsideWithoutOffice.office;
    delete outsideWithoutOffice.distanceMeters;
    delete outsideWithoutOffice.routeId;
    state = recordScenarioRoutedLocation(state, {
      scenarioId: "s1",
      entry: outsideWithoutOffice,
    });
    const latest = readScenarioRoutedOffice(state, "s1");
    assert.equal(latest?.inboundMessageId, "m2");
    assert.deepEqual(readScenarioRoutedOfficeTemplateValues(latest), {
      name: "",
      address: "",
      city: "",
      phone: "",
      distance_km: "",
      maps_url: "",
    });
  });

  it("bounds a lookup by the wait, the newest decided share and consumed ids", () => {
    const waitStartedAt = new Date("2026-10-05T09:00:00.000Z");
    assert.deepEqual(
      readScenarioLocationLookupBounds({}, { scenarioId: "s1", waitStartedAt }),
      {
        since: new Date(
          waitStartedAt.getTime() - SCENARIO_LOCATION_WAIT_SKEW_MS,
        ),
        consumedMessageIds: [],
      },
    );
    const state = recordScenarioRoutedLocation(
      {},
      { scenarioId: "s1", entry: entry({ inboundMessageId: "m1" }) },
    );
    assert.deepEqual(
      readScenarioLocationLookupBounds(state, {
        scenarioId: "s1",
        waitStartedAt,
      }),
      {
        since: new Date("2026-10-05T10:00:00.000Z"),
        consumedMessageIds: ["m1"],
      },
    );
    assert.equal(
      readScenarioLocationLookupBounds(state, {
        scenarioId: "s1",
        waitStartedAt: null,
      }).since,
      null,
    );
  });

  it("renders office variables, empty before an office was found", () => {
    assert.deepEqual(
      readScenarioRoutedOfficeTemplateValues(entry({ inboundMessageId: "m1" })),
      {
        name: "Abay",
        address: "Abay Ave 10",
        city: "Almaty",
        phone: "+7 727 000 00 00",
        distance_km: "2.1",
        maps_url: "https://www.google.com/maps?q=43.24,76.91",
      },
    );
    assert.equal(
      readScenarioRoutedOfficeTemplateValues(
        entry({
          inboundMessageId: "m2",
          office: toScenarioRoutedLocationOffice(astana),
        }),
      ).maps_url,
      "https://2gis.kz/astana/firm/1",
    );
    assert.deepEqual(readScenarioRoutedOfficeTemplateValues(null), {
      name: "",
      address: "",
      city: "",
      phone: "",
      distance_km: "",
      maps_url: "",
    });
  });

  it("exposes the office variables as supported tokens", () => {
    for (const path of [
      "office.name",
      "office.address",
      "office.city",
      "office.phone",
      "office.distance_km",
      "office.maps_url",
    ]) {
      assert.equal(isSupportedScenarioTemplateToken(path), true, path);
      assert.ok(
        (listScenarioTemplateContextPaths() as string[]).includes(path),
        path,
      );
    }
    assert.equal(isSupportedScenarioTemplateToken("office"), false);
  });
});

import {
  clearRequestsListQueryParams,
  hasRequestsListQuery,
  parseRequestsListQuery,
  requestMatchesListQuery,
  requestsListQuerySignature,
} from "./list-query";

describe("parseRequestsListQuery", () => {
  it("parses status and insight filters from URLSearchParams", () => {
    expect(
      parseRequestsListQuery(
        new URLSearchParams("status=in_progress&filter=slaBreached")
      )
    ).toEqual({
      status: "in_progress",
      filter: "slaBreached",
    });
  });

  it("parses Next.js searchParams records and ignores invalid values", () => {
    expect(
      parseRequestsListQuery({
        status: "closed",
        filter: ["csatLow", "ignored"],
        conversation: "conv-1",
      })
    ).toEqual({
      status: "closed",
      filter: "csatLow",
    });

    expect(
      parseRequestsListQuery({
        status: "nope",
        filter: "unknown",
      })
    ).toEqual({
      status: null,
      filter: null,
    });
  });

  it("ignores the retired churn-risk insight filter", () => {
    expect(
      parseRequestsListQuery(new URLSearchParams("filter=churnRisk"))
    ).toEqual({ status: null, filter: null });
  });
});

describe("requests list query helpers", () => {
  it("builds signatures and mutates URL params", () => {
    const query = parseRequestsListQuery(
      new URLSearchParams("status=open&filter=bestPractice")
    );

    expect(hasRequestsListQuery(query)).toBe(true);
    expect(requestsListQuerySignature(query)).toBe(
      "status:open|filter:bestPractice"
    );

    const params = new URLSearchParams(
      "conversation=abc&status=open&filter=bestPractice"
    );
    expect(params.get("status")).toBe("open");
    expect(params.get("filter")).toBe("bestPractice");
    expect(params.get("conversation")).toBe("abc");

    clearRequestsListQueryParams(params);
    expect(params.get("status")).toBeNull();
    expect(params.get("filter")).toBeNull();
    expect(params.get("conversation")).toBe("abc");
  });

  it("filters rows by status and insight constraints", () => {
    const query = parseRequestsListQuery(
      new URLSearchParams("status=in_progress")
    );

    expect(
      requestMatchesListQuery({ status: "in_progress" }, query)
    ).toBe(true);
    expect(requestMatchesListQuery({ status: "open" }, query)).toBe(false);

    expect(
      requestMatchesListQuery(
        { status: "open", customerSatisfactionScore: 2 },
        parseRequestsListQuery(new URLSearchParams("filter=csatLow"))
      )
    ).toBe(true);
    expect(
      requestMatchesListQuery(
        { status: "open", customerSatisfactionScore: 5 },
        parseRequestsListQuery(new URLSearchParams("filter=csatLow"))
      )
    ).toBe(false);
  });
});

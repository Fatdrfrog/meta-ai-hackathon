const mockGetWhatsAppWorkspaceReadiness = jest.fn();
const mockReadTemplateFlowFacts = jest.fn();

jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceReadiness: (...args: unknown[]) =>
    mockGetWhatsAppWorkspaceReadiness(...args),
}));

jest.mock("@/lib/whatsapp/flows/template-flow-facts", () => ({
  readTemplateFlowFacts: (...args: unknown[]) =>
    mockReadTemplateFlowFacts(...args),
}));

import { NextResponse } from "next/server";
import { GET } from "./route";

const FACTS = [
  {
    flowId: "2244981489363579",
    state: "found",
    name: "Message templates_medal_pick_1_MARKETING_9b1bc",
    status: "PUBLISHED",
    screenIds: ["SURVEY_FORM"],
    checkedAt: "2026-09-28T12:00:00.000Z",
  },
];

function get(query: string) {
  return GET(
    new Request(`http://localhost/api/whatsapp/flows/template-health?${query}`)
  );
}

describe("GET /api/whatsapp/flows/template-health", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWhatsAppWorkspaceReadiness.mockResolvedValue({
      readiness: { hasWabaId: true, hasAccessToken: true },
      wabaId: "waba-1",
      accessToken: "access-token",
      phoneNumberId: "phone-1",
      sourceId: "source-1",
    });
    mockReadTemplateFlowFacts.mockResolvedValue(FACTS);
  });

  it("returns cached-or-live facts for the requested Flows", async () => {
    const response = await get(
      "workspaceId=ws-1&flowIds=2244981489363579,2244981489363579"
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      facts: FACTS,
      sourceId: "source-1",
    });
    expect(mockGetWhatsAppWorkspaceReadiness).toHaveBeenCalledWith("ws-1", {
      sourceId: undefined,
    });
    expect(mockReadTemplateFlowFacts).toHaveBeenCalledWith({
      wabaId: "waba-1",
      accessToken: "access-token",
      flowIds: ["2244981489363579"],
      refresh: false,
    });
  });

  it("passes the source and the refresh request through", async () => {
    await get("workspaceId=ws-1&sourceId=source-2&flowIds=1,2&refresh=1");

    expect(mockGetWhatsAppWorkspaceReadiness).toHaveBeenCalledWith("ws-1", {
      sourceId: "source-2",
    });
    expect(mockReadTemplateFlowFacts).toHaveBeenCalledWith(
      expect.objectContaining({ flowIds: ["1", "2"], refresh: true })
    );
  });

  it.each([
    ["no workspace", "flowIds=1"],
    ["no Flow ids", "workspaceId=ws-1"],
    ["a non-numeric id", "workspaceId=ws-1&flowIds=1,abc"],
    [
      "more than 25 Flows",
      `workspaceId=ws-1&flowIds=${Array.from({ length: 26 }, (_, i) => i + 1).join(",")}`,
    ],
  ])("rejects %s", async (_label, query) => {
    const response = await get(query);

    expect(response.status).toBe(400);
    expect(mockReadTemplateFlowFacts).not.toHaveBeenCalled();
  });

  it("returns the membership error unchanged", async () => {
    mockGetWhatsAppWorkspaceReadiness.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await get("workspaceId=ws-1&flowIds=1");

    expect(response.status).toBe(403);
    expect(mockReadTemplateFlowFacts).not.toHaveBeenCalled();
  });

  it("reports a WhatsApp connection without credentials", async () => {
    mockGetWhatsAppWorkspaceReadiness.mockResolvedValue({
      readiness: { hasWabaId: false, hasAccessToken: false },
      sourceId: "source-1",
    });

    const response = await get("workspaceId=ws-1&flowIds=1");

    expect(response.status).toBe(409);
    expect(mockReadTemplateFlowFacts).not.toHaveBeenCalled();
  });

  it("hides unexpected failures behind a generic error", async () => {
    mockReadTemplateFlowFacts.mockRejectedValue(
      new Error("Graph said something secret")
    );

    const response = await get("workspaceId=ws-1&flowIds=1");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Failed to check template Flows",
    });
  });
});

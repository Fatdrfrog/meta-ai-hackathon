import { parseScenarioResponseError, ScenarioRequestError } from "./http";

describe("scenario response error node ids", () => {
  it("canonicalizes, deduplicates, and bounds untrusted node ids", async () => {
    const nodeIds = [
      "node-a",
      " node-a ",
      "",
      "x".repeat(300),
      ...Array.from({ length: 120 }, (_, index) => `node-${index}`),
      null,
    ];

    const error = await parseScenarioResponseError(
      new Response(JSON.stringify({ error: "Invalid graph", nodeIds }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
      "Fallback"
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ScenarioRequestError);
    expect((error as ScenarioRequestError).nodeIds).toHaveLength(100);
    expect((error as ScenarioRequestError).nodeIds[0]).toBe("node-a");
    expect((error as ScenarioRequestError).nodeIds).not.toContain("");
    expect((error as ScenarioRequestError).nodeIds).toContain("x".repeat(300));
    expect((error as ScenarioRequestError).nodeIds).not.toContain(" node-a ");
  });
});

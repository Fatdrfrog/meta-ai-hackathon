import {
  buildFlowEndpointTokenFromConfig,
  decodeFlowEndpointToken,
  encodeFlowEndpointToken,
} from "@/lib/whatsapp/flows/endpoint-token";

describe("flows/endpoint-token", () => {
  it("roundtrips encode/decode", () => {
    const payload = {
      v: 1 as const,
      screens: ["A", "B"],
      routing: { A: ["B"], B: [] },
    };
    const t = encodeFlowEndpointToken(payload);
    expect(t.startsWith("airi1.")).toBe(true);
    expect(decodeFlowEndpointToken(t)).toEqual(payload);
  });

  it("returns null for legacy tokens", () => {
    expect(decodeFlowEndpointToken("flow_123_abc")).toBeNull();
  });

  it("buildFlowEndpointTokenFromConfig only for data_endpoint multi-screen", () => {
    expect(
      buildFlowEndpointTokenFromConfig({
        templateId: "t",
        ctaText: "Open",
        screens: [{ id: "S1", title: "One", fields: [] }],
      })
    ).toBeNull();

    const tok = buildFlowEndpointTokenFromConfig({
      templateId: "t",
      ctaText: "Open",
      flowNavigationMode: "data_endpoint",
      managedProvisioning: {
        operationId: "operation-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        contentRevision: 1,
        contentDigest: "f".repeat(64),
        flowId: "provider-flow-id",
        providerStatus: "PUBLISHED",
      },
      screens: [
        { id: "S1", title: "One", fields: [] },
        { id: "S2", title: "Two", fields: [] },
      ],
    });
    expect(tok).toBeTruthy();
    const d = decodeFlowEndpointToken(tok!);
    expect(d?.screens).toEqual(["S_ONE", "S_TWO"]);
    expect(d?.routing).toEqual({ S_ONE: ["S_TWO"], S_TWO: [] });
  });

  it.each([
    [[{ id: "ONLY", title: "Only", fields: [] }]],
    [
      [
        { id: "FIRST", title: "First", fields: [] },
        { id: "SECOND", title: "Second", fields: [] },
      ],
    ],
  ])("never derives local topology from opaque provider screens", screens => {
    expect(
      buildFlowEndpointTokenFromConfig({
        templateId: "provider-reference",
        ctaText: "Open",
        flowNavigationMode: "data_endpoint",
        screens,
        providerReference: {
          flowId: "provider-flow-id",
          sourceId: "source-1",
          wabaId: "waba-1",
          providerStatus: "PUBLISHED",
          jsonVersion: "7.3",
          dataApiVersion: "3.0",
        },
      })
    ).toBeNull();
  });

  it("rejects a single-screen data_endpoint config instead of encoding a linear fallback", () => {
    expect(() =>
      buildFlowEndpointTokenFromConfig({
        templateId: "t",
        ctaText: "Open",
        flowNavigationMode: "data_endpoint",
        screens: [{ id: "S1", title: "One", fields: [] }],
      })
    ).toThrow("at least two screens");
  });

  it("rejects oversized and reserved-key airi1 input before endpoint routing", () => {
    const oversizedValidPayload = Buffer.from(
      `{"v":1,"screens":["A","B"],"routing":{"A":["B"],"B":[]},"ignored":"${"x".repeat(20_000)}"}`,
      "utf8"
    ).toString("base64url");
    expect(
      decodeFlowEndpointToken(`airi1.${oversizedValidPayload}`)
    ).toBeNull();

    const unsafePayload = Buffer.from(
      '{"v":1,"screens":["__proto__","B"],"routing":{"__proto__":["B"],"B":[]}}',
      "utf8"
    ).toString("base64url");
    expect(decodeFlowEndpointToken(`airi1.${unsafePayload}`)).toBeNull();
  });
});

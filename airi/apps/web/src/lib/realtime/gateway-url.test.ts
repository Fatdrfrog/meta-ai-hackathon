import { getRealtimeGatewayUrl } from "./gateway-url";

describe("getRealtimeGatewayUrl", () => {
  it("prefers private runtime env over legacy public env", () => {
    expect(
      getRealtimeGatewayUrl({
        REALTIME_GATEWAY_URL: " https://private.example ",
        NEXT_PUBLIC_REALTIME_GATEWAY_URL: "https://public.example",
      })
    ).toBe("https://private.example");
  });

  it("keeps legacy public env as a fallback", () => {
    expect(
      getRealtimeGatewayUrl({
        NEXT_PUBLIC_REALTIME_GATEWAY_URL: "https://public.example",
      })
    ).toBe("https://public.example");
  });

  it("uses explicit local fallback when env is absent", () => {
    expect(getRealtimeGatewayUrl({}, "ws://localhost:8080")).toBe(
      "ws://localhost:8080"
    );
  });
});

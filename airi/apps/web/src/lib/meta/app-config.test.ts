import {
  MetaServerAppConfigError,
  getMetaServerAppConfig,
  resolveWhatsAppFlowEndpointUri,
  tryGetMetaServerAppConfig,
} from "./app-config";

describe("Meta server app configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.META_APP_ID;
    delete process.env.NEXT_PUBLIC_META_APP_ID;
    delete process.env.META_APP_SECRET;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("prefers the server-only Meta app ID", () => {
    process.env.META_APP_ID = " server-app ";
    process.env.NEXT_PUBLIC_META_APP_ID = "public-app";
    process.env.META_APP_SECRET = " server-secret ";

    expect(getMetaServerAppConfig()).toEqual({
      appId: "server-app",
      appSecret: "server-secret",
    });
  });

  it("keeps the documented public Meta app ID fallback", () => {
    process.env.NEXT_PUBLIC_META_APP_ID = " public-app ";
    process.env.META_APP_SECRET = "server-secret";

    expect(getMetaServerAppConfig()).toEqual({
      appId: "public-app",
      appSecret: "server-secret",
    });
  });

  it("fails deterministically when the Meta app ID is missing", () => {
    process.env.META_APP_SECRET = "secret-that-must-not-leak";

    try {
      getMetaServerAppConfig();
      throw new Error("Expected Meta app configuration to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(MetaServerAppConfigError);
      expect(error).toMatchObject({
        name: "MetaServerAppConfigError",
        code: "missing_meta_app_id",
        message: "Meta server app ID is not configured",
      });
      expect(String(error)).not.toContain("secret-that-must-not-leak");
    }
  });

  it("fails deterministically when the Meta app secret is missing", () => {
    process.env.META_APP_ID = "id-that-must-not-leak";

    try {
      getMetaServerAppConfig();
      throw new Error("Expected Meta app configuration to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(MetaServerAppConfigError);
      expect(error).toMatchObject({
        name: "MetaServerAppConfigError",
        code: "missing_meta_app_secret",
        message: "Meta server app secret is not configured",
      });
      expect(String(error)).not.toContain("id-that-must-not-leak");
    }
  });

  it("returns null for an optional missing Meta app configuration", () => {
    expect(tryGetMetaServerAppConfig()).toBeNull();
  });

  it("returns the canonical config for optional callers", () => {
    process.env.META_APP_ID = "server-app";
    process.env.META_APP_SECRET = "server-secret";

    expect(tryGetMetaServerAppConfig()).toEqual({
      appId: "server-app",
      appSecret: "server-secret",
    });
  });
});

describe("WhatsApp Flow endpoint URI", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("normalizes configured paths and trailing slashes to the HTTPS origin", () => {
    process.env.NEXT_PUBLIC_APP_URL =
      "https://flows.airi.chat/panel/workspaces/";

    expect(resolveWhatsAppFlowEndpointUri("endpoint_A1-b2")).toBe(
      "https://flows.airi.chat/api/webhooks/whatsapp/flow-endpoint/endpoint_A1-b2"
    );
  });

  it.each([
    [undefined, "missing_whatsapp_flow_endpoint_origin"],
    ["not-a-url", "invalid_whatsapp_flow_endpoint_origin"],
    ["http://flows.airi.chat", "invalid_whatsapp_flow_endpoint_origin"],
    ["https://localhost:3000", "invalid_whatsapp_flow_endpoint_origin"],
    ["https://127.0.0.1", "invalid_whatsapp_flow_endpoint_origin"],
    ["https://[::1]", "invalid_whatsapp_flow_endpoint_origin"],
    ["https://localhost.", "invalid_whatsapp_flow_endpoint_origin"],
    ["https://10.42.0.7", "invalid_whatsapp_flow_endpoint_origin"],
    ["https://172.16.4.2", "invalid_whatsapp_flow_endpoint_origin"],
    ["https://192.168.1.20", "invalid_whatsapp_flow_endpoint_origin"],
    ["https://169.254.169.254", "invalid_whatsapp_flow_endpoint_origin"],
  ] as const)(
    "rejects a non-public endpoint origin %p",
    (configuredOrigin, expectedCode) => {
      if (configuredOrigin === undefined) {
        delete process.env.NEXT_PUBLIC_APP_URL;
      } else {
        process.env.NEXT_PUBLIC_APP_URL = configuredOrigin;
      }

      expect(() => resolveWhatsAppFlowEndpointUri("endpoint_A1-b2")).toThrow(
        new MetaServerAppConfigError(expectedCode)
      );
    }
  );

  it.each([
    [
      "https://8.8.8.8/internal/path/",
      "https://8.8.8.8/api/webhooks/whatsapp/flow-endpoint/endpoint_A1-b2",
    ],
    [
      "https://[2606:4700:4700::1111]/internal/path/",
      "https://[2606:4700:4700::1111]/api/webhooks/whatsapp/flow-endpoint/endpoint_A1-b2",
    ],
    [
      "https://flows.airi.chat/internal/path/",
      "https://flows.airi.chat/api/webhooks/whatsapp/flow-endpoint/endpoint_A1-b2",
    ],
  ])("accepts a public HTTPS origin %p", (configuredOrigin, expectedUri) => {
    process.env.NEXT_PUBLIC_APP_URL = configuredOrigin;

    expect(resolveWhatsAppFlowEndpointUri("endpoint_A1-b2")).toBe(expectedUri);
  });

  it("does not infer an endpoint origin from deployment or request-host settings", () => {
    process.env.VERCEL_URL = "preview.airi.chat";
    process.env.HOST = "request.airi.chat";
    process.env.NEXTAUTH_URL = "https://auth.airi.chat";

    expect(() => resolveWhatsAppFlowEndpointUri("endpoint_A1-b2")).toThrow(
      new MetaServerAppConfigError("missing_whatsapp_flow_endpoint_origin")
    );
  });

  it.each(["", ".", "..", "../other", "nested/other", "encoded%2Fother"])(
    "rejects endpoint IDs that can alter the route path: %p",
    endpointId => {
      process.env.NEXT_PUBLIC_APP_URL = "https://flows.airi.chat";

      expect(() => resolveWhatsAppFlowEndpointUri(endpointId)).toThrow(
        new MetaServerAppConfigError("invalid_whatsapp_flow_endpoint_id")
      );
    }
  );
});

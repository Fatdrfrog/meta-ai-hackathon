const mockFetchSourceWithCredentialsResult = jest.fn();
const mockCreateCookieClient = jest.fn();
const mockDomainUnauthorized = jest.fn();

jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentialsResult: (...args: unknown[]) =>
    mockFetchSourceWithCredentialsResult(...args),
}));

// Widget visitors have no Airi session. The cookie client is anon for them
// and anon cannot read sources, so the lookup must never go through it.
jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateCookieClient(...args),
}));

jest.mock("@/lib/logger", () => ({
  widgetLogger: {
    domainUnauthorized: (...args: unknown[]) => mockDomainUnauthorized(...args),
  },
}));

import {
  fetchWidgetSourceByClientKey,
  resolveAuthorizedWidgetSource,
} from "./source-context";

function makeRequest(origin: string): Request {
  return new Request("https://www.airi.chat/api/widget/config", {
    headers: { origin },
  });
}

function mockWidgetSource(credentials: Record<string, unknown>) {
  mockFetchSourceWithCredentialsResult.mockResolvedValue({
    ok: true,
    source: {
      id: "source-1",
      workspace_id: "workspace-1",
      company_id: "company-1",
      credentials: {
        client_key: "widget_test",
        allowed_domains: ["www.airi.chat"],
        status: "active",
        ...credentials,
      },
    },
  });
}

describe("resolveAuthorizedWidgetSource", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWidgetSource({});
  });

  it("resolves the client key on the server without the visitor session client", async () => {
    const source = await fetchWidgetSourceByClientKey("widget_test");

    expect(source?.workspace_id).toBe("workspace-1");
    expect(mockFetchSourceWithCredentialsResult).toHaveBeenCalledWith(
      undefined,
      "web_widget",
      { "credentials->>client_key": "widget_test" }
    );
    expect(mockCreateCookieClient).not.toHaveBeenCalled();
  });

  it("rejects the client key when the server lookup fails", async () => {
    mockFetchSourceWithCredentialsResult.mockResolvedValue({
      ok: false,
      error: { code: "42501" },
    });

    const result = await resolveAuthorizedWidgetSource({
      request: makeRequest("https://www.airi.chat"),
      clientKey: "widget_test",
    });

    expect(result).toEqual({
      ok: false,
      status: 401,
      error: "Invalid client_key",
      origin: "https://www.airi.chat",
    });
  });

  it("returns the web widget source context for an authorized origin", async () => {
    const result = await resolveAuthorizedWidgetSource({
      request: makeRequest("https://www.airi.chat"),
      clientKey: "widget_test",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source.id).toBe("source-1");
      expect(result.credentials.allowed_domains).toEqual(["www.airi.chat"]);
      expect(result.origin).toBe("https://www.airi.chat");
    }
  });

  it("rejects origins outside the source allowlist", async () => {
    const result = await resolveAuthorizedWidgetSource({
      request: makeRequest("https://preview.example.com"),
      clientKey: "widget_test",
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Domain not authorized",
      origin: "https://preview.example.com",
    });
    expect(mockDomainUnauthorized).toHaveBeenCalledWith(
      "https://preview.example.com",
      "widget_test",
      "workspace-1",
      "company-1"
    );
  });

  it("rejects inactive widget sources before serving public widget APIs", async () => {
    mockWidgetSource({ status: "inactive" });

    const result = await resolveAuthorizedWidgetSource({
      request: makeRequest("https://www.airi.chat"),
      clientKey: "widget_test",
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Widget source inactive",
      origin: "https://www.airi.chat",
    });
  });

  it("rejects widget sources without an explicit domain allowlist", async () => {
    mockWidgetSource({ allowed_domains: [] });

    const result = await resolveAuthorizedWidgetSource({
      request: makeRequest("https://www.airi.chat"),
      clientKey: "widget_test",
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Domain not authorized",
      origin: "https://www.airi.chat",
    });
  });
});

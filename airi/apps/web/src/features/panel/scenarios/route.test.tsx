import type { ReactElement } from "react";

const mockGetReadOnlySupabaseContext = jest.fn();
const mockMembership = jest.fn();
const mockSelectSources = jest.fn();
const mockSources = jest.fn();
const mockFrom = jest.fn();
const mockGetLocale = jest.fn();
const mockLoadMessages = jest.fn();
const mockListScenarios = jest.fn();
const mockWebhookConfigured = jest.fn();
const mockTemporalConfigured = jest.fn();
const mockRedirect = jest.fn();
const mockFeatureFlags = jest.fn();
const mockLoadScenarioDetail = jest.fn();
const mockRegisteredAudienceEnabled = jest.fn();
const mockLoggerError = jest.fn();
const mockSupabase = { from: mockFrom };

jest.mock("@/features/panel/shared/workspace/server-context", () => ({
  getReadOnlySupabaseClient: async () => mockSupabase,
  getReadOnlySupabaseContext: (...args: unknown[]) =>
    mockGetReadOnlySupabaseContext(...args),
  getReadOnlySupabaseUser: jest.fn(),
}));
jest.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => mockRedirect(...args),
}));
jest.mock("@/i18n/message-loader", () => ({
  getLocaleFromCookie: (...args: unknown[]) => mockGetLocale(...args),
  loadScenariosClientMessages: (...args: unknown[]) =>
    mockLoadMessages(...args),
}));
jest.mock("@/lib/scenarios/list-workspace-scenario-summaries", () => ({
  listAllWorkspaceScenarioSummaries: (...args: unknown[]) =>
    mockListScenarios(...args),
}));
jest.mock("@/lib/scenarios/scenario-detail", () => ({
  loadScenarioDetail: (...args: unknown[]) => mockLoadScenarioDetail(...args),
}));
jest.mock("@/lib/email/registered-users-audience", () => ({
  isRegisteredUsersEmailAudienceEnabledForWorkspace: (...args: unknown[]) =>
    mockRegisteredAudienceEnabled(...args),
}));
jest.mock("@/lib/logger", () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}));
jest.mock("@/lib/higgsfield/higgsfield-webhook", () => ({
  isHiggsfieldWebhookConfigured: () => mockWebhookConfigured(),
}));
jest.mock("@/lib/temporal/higgsfield-assets", () => ({
  isTemporalConfigured: () => mockTemporalConfigured(),
}));
jest.mock("@/lib/workspace-feature-flags", () => ({
  getWorkspaceFeatureFlags: (...args: unknown[]) => mockFeatureFlags(...args),
}));
jest.mock("@/components/i18n/scoped-intl-provider", () => ({
  ScopedIntlProvider: () => null,
}));
jest.mock("@/components/scenarios/workspace/scenarios-workspace", () => ({
  ScenariosWorkspace: () => null,
}));

import { ScopedIntlProvider } from "@/components/i18n/scoped-intl-provider";
import { ScenariosWorkspace } from "@/components/scenarios/workspace/scenarios-workspace";
import type { InitialScenarioDetail } from "@/lib/scenarios/initial-scenario-detail";
import ScenariosPage from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const messages = { Scenarios: { title: "Scenarios" } };
const summaries = [
  { _id: "scenario-a", name: "Welcome", status: "draft", nodeCount: 2 },
  { _id: "scenario-b", name: "Follow-up", status: "live", nodeCount: 4 },
];
const whatsAppRow = {
  id: "wa-1",
  type: "whatsapp",
  name: "Sales",
  credential_verified_name: "Sales Line",
};
const emailRow = {
  id: "email-1",
  type: "email",
  name: "Support",
  credential_status: "active",
  credential_email_address: "support@example.com",
};
const calendarRow = { id: "calendar-1", type: "google_calendar", name: null };

type EditorProps = Record<string, unknown> & {
  initialScenarioDetail: Promise<InitialScenarioDetail | null>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function loadPage(
  searchParams: Record<string, string | string[] | undefined> = {}
) {
  return ScenariosPage({
    params: Promise.resolve({ workspaceId }),
    searchParams: Promise.resolve(searchParams),
  });
}

function editorProps(
  page: ReactElement<{ children: ReactElement<EditorProps> }>
): EditorProps {
  expect(page.type).toBe(ScopedIntlProvider);
  expect(page.props.children.type).toBe(ScenariosWorkspace);
  return page.props.children.props;
}

function withoutDetail({ initialScenarioDetail, ...props }: EditorProps) {
  void initialScenarioDetail;
  return props;
}

async function flushAsyncWork() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

describe("scenario initial page contract", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedirect.mockImplementation((href: string) => {
      throw new Error(`redirect:${href}`);
    });
    mockGetReadOnlySupabaseContext.mockResolvedValue({
      supabase: mockSupabase,
      user: { id: "user-1" },
    });
    mockMembership.mockResolvedValue({
      data: { workspace_id: workspaceId, role: " manager " },
    });
    mockFrom.mockImplementation((table: string) => {
      if (table === "company_users") {
        const query = {
          select: jest.fn(),
          eq: jest.fn(),
          maybeSingle: mockMembership,
        };
        query.select.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        return query;
      }
      if (table === "sources") {
        mockSelectSources.mockReturnValue({ eq: mockSources });
        return { select: mockSelectSources };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    mockSources.mockResolvedValue({
      data: [whatsAppRow, emailRow, calendarRow],
    });
    mockGetLocale.mockResolvedValue("en");
    mockLoadMessages.mockResolvedValue(messages);
    mockListScenarios.mockResolvedValue(summaries);
    mockWebhookConfigured.mockReturnValue(true);
    mockTemporalConfigured.mockReturnValue(true);
    mockFeatureFlags.mockResolvedValue({ scenario_node_settings_panel: false });
    mockLoadScenarioDetail.mockResolvedValue(null);
    mockRegisteredAudienceEnabled.mockResolvedValue(false);
  });

  it("passes scoped messages and serializable editor data without source credentials", async () => {
    const page = await loadPage({
      scenarioId: [" scenario-a ", "scenario-b"],
      preview: ["1", "0"],
      airiCreate: " 1 ",
    });
    const props = editorProps(page);
    const serializable = withoutDetail(props);

    expect(page.props.messages).toBe(messages);
    expect(mockLoadMessages).toHaveBeenCalledWith("en");
    expect(mockSources).toHaveBeenCalledWith("workspace_id", workspaceId);
    expect(mockListScenarios).toHaveBeenCalledWith(workspaceId);
    expect(serializable).toMatchObject({
      workspaceId,
      hasWhatsApp: true,
      hasConnectedSources: true,
      hasGoogleCalendar: true,
      connectedSourceMentions: ["whatsapp", "email", "higgsfield"],
      connectedSourceOptions: [
        { id: "wa-1", type: "whatsapp", label: "Sales" },
        { id: "email-1", type: "email", label: "Support" },
      ],
      initialScenarios: summaries,
      requestedScenarioId: "scenario-a",
      registeredAudienceEnabled: false,
      openPreviewOnMount: true,
      openAiriCreateOnMount: true,
    });
    expect(JSON.parse(JSON.stringify(serializable))).toEqual(serializable);
    expect(serializable).not.toHaveProperty("supabase");
    expect(serializable).not.toHaveProperty("user");
    expect(serializable).not.toHaveProperty("sources");
  });

  it("selects only the readiness credential keys, never whole credentials", async () => {
    await loadPage();

    const [columns] = mockSelectSources.mock.calls[0] as [string];
    const selected = columns.split(",").map(column => column.trim());
    expect(selected).not.toContain("credentials");
    expect(selected).toEqual(
      expect.arrayContaining([
        "id",
        "type",
        "name",
        "credential_bot_token:credentials->bot_token",
        "credential_status:credentials->status",
        "credential_is_on_biz_app:credentials->is_on_biz_app",
      ])
    );
  });

  it("starts auth-independent reads while the membership check is in flight", async () => {
    const membership = deferred<{
      data: { workspace_id: string; role: string };
    }>();
    mockMembership.mockReturnValueOnce(membership.promise);

    const page = loadPage();
    await flushAsyncWork();
    expect(mockSources).toHaveBeenCalledTimes(1);
    expect(mockListScenarios).toHaveBeenCalledTimes(1);
    expect(mockLoadMessages).toHaveBeenCalledTimes(1);
    expect(mockFeatureFlags).toHaveBeenCalledTimes(1);

    membership.resolve({ data: { workspace_id: workspaceId, role: "admin" } });
    expect(editorProps(await page).workspaceId).toBe(workspaceId);
  });

  it("builds nothing and loads no scenario detail until access resolves", async () => {
    const membership = deferred<{
      data: { workspace_id: string; role: string };
    }>();
    mockMembership.mockReturnValueOnce(membership.promise);
    let settled = false;

    const page = loadPage().then(result => {
      settled = true;
      return result;
    });
    await flushAsyncWork();
    expect(settled).toBe(false);
    expect(mockLoadScenarioDetail).not.toHaveBeenCalled();

    membership.resolve({ data: { workspace_id: workspaceId, role: "manager" } });
    await page;
    expect(mockLoadScenarioDetail).toHaveBeenCalledTimes(1);
  });

  it("redirects unauthenticated visitors and never reads a scenario detail", async () => {
    mockGetReadOnlySupabaseContext.mockResolvedValueOnce({
      supabase: mockSupabase,
      user: null,
    });

    await expect(loadPage()).rejects.toThrow("redirect:/login");
    await flushAsyncWork();
    expect(mockLoadScenarioDetail).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalledWith("company_users");
  });

  it("preserves the workspace Airi redirect when membership is absent", async () => {
    mockMembership.mockResolvedValueOnce({ data: null });

    await expect(loadPage()).rejects.toThrow(
      `redirect:/panel/w/${workspaceId}/airi`
    );
    await flushAsyncWork();
    expect(mockLoadScenarioDetail).not.toHaveBeenCalled();
  });

  it("checks the registered-phones allow-list alongside the membership check", async () => {
    const membership = deferred<{
      data: { workspace_id: string; role: string };
    }>();
    mockMembership.mockReturnValueOnce(membership.promise);
    mockSources.mockResolvedValueOnce({ data: [whatsAppRow] });
    mockRegisteredAudienceEnabled.mockResolvedValueOnce(true);

    let settled = false;
    const page = loadPage().then(result => {
      settled = true;
      return result;
    });
    await flushAsyncWork();
    // Started with the other reads, so it never adds a round trip after the
    // membership check; its answer is used only once access has passed.
    expect(mockSources).toHaveBeenCalledTimes(1);
    expect(mockRegisteredAudienceEnabled).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    membership.resolve({ data: { workspace_id: workspaceId, role: "admin" } });
    expect(editorProps(await page).registeredAudienceEnabled).toBe(true);
    expect(mockRegisteredAudienceEnabled).toHaveBeenCalledTimes(1);
  });

  it("redirects a WhatsApp workspace's non-member without an unhandled rejection from a failing allow-list check", async () => {
    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);
    try {
      mockMembership.mockResolvedValueOnce({ data: null });
      mockSources.mockResolvedValueOnce({ data: [whatsAppRow] });
      mockRegisteredAudienceEnabled.mockRejectedValue(
        new Error("allow-list offline")
      );

      await expect(loadPage()).rejects.toThrow(
        `redirect:/panel/w/${workspaceId}/airi`
      );
      await flushAsyncWork();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("lets the redirect win over read failures without unhandled rejections", async () => {
    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);
    try {
      mockMembership.mockResolvedValueOnce({ data: null });
      mockLoadMessages.mockRejectedValueOnce(new Error("catalog offline"));
      mockListScenarios.mockRejectedValueOnce(new Error("mongo offline"));
      mockSources.mockRejectedValueOnce(new Error("sources offline"));
      mockFeatureFlags.mockRejectedValueOnce(new Error("flags offline"));

      await expect(loadPage()).rejects.toThrow(
        `redirect:/panel/w/${workspaceId}/airi`
      );
      await flushAsyncWork();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it.each([
    [false, false, "Higgsfield webhook callback is not configured"],
    [true, false, "Temporal worker is not configured"],
    [true, true, ""],
  ])(
    "preserves generation readiness when webhook=%s and worker=%s",
    async (webhook, worker, reason) => {
      mockWebhookConfigured.mockReturnValueOnce(webhook);
      mockTemporalConfigured.mockReturnValueOnce(worker);
      const props = editorProps(await loadPage());
      expect(props.higgsfieldUnavailableReason).toBe(reason);
      expect(props.connectedSourceMentions).toEqual(
        webhook && worker
          ? ["whatsapp", "email", "higgsfield"]
          : ["whatsapp", "email"]
      );
    }
  );

  it("preserves empty-data fallbacks and ignores non-enabled launch flags", async () => {
    mockSources.mockResolvedValueOnce({ data: null });
    mockListScenarios.mockResolvedValueOnce(null);
    const props = editorProps(
      await loadPage({ scenarioId: [], preview: "true", airiCreate: "0" })
    );
    expect(props).toMatchObject({
      hasWhatsApp: false,
      hasConnectedSources: false,
      hasGoogleCalendar: false,
      initialScenarios: undefined,
      requestedScenarioId: null,
      registeredAudienceEnabled: false,
      openPreviewOnMount: false,
      openAiriCreateOnMount: false,
    });
    await expect(props.initialScenarioDetail).resolves.toBeNull();
    expect(mockLoadScenarioDetail).not.toHaveBeenCalled();
  });

  it("reads the node settings flag for the requested workspace", async () => {
    expect(editorProps(await loadPage()).nodeSettingsPanelEnabled).toBe(false);
    expect(mockFeatureFlags).toHaveBeenCalledWith(workspaceId, [
      "scenario_node_settings_panel",
    ]);

    mockFeatureFlags.mockResolvedValueOnce({
      scenario_node_settings_panel: true,
    });
    expect(editorProps(await loadPage()).nodeSettingsPanelEnabled).toBe(true);
  });

  it("keeps inline editing when the feature flags cannot be read", async () => {
    mockFeatureFlags.mockRejectedValueOnce(new Error("flag store offline"));
    expect(editorProps(await loadPage()).nodeSettingsPanelEnabled).toBe(false);
  });

  it("propagates scenario-loading errors instead of rendering an empty workspace", async () => {
    const failure = new Error("Fixture scenario load failed");
    mockListScenarios.mockRejectedValueOnce(failure);
    await expect(loadPage()).rejects.toBe(failure);
  });

  it.each([
    { label: "empty", initialScenarios: [] },
    { label: "populated", initialScenarios: summaries },
  ])(
    "rejects failed source reads before rendering the $label workspace",
    async ({ initialScenarios }) => {
      const failure = { message: "Fixture sources unavailable", code: "08006" };
      mockSources.mockResolvedValueOnce({ data: null, error: failure });
      mockListScenarios.mockResolvedValueOnce(initialScenarios);

      await expect(loadPage()).rejects.toMatchObject({
        message: "Failed to load scenario sources",
        cause: failure,
      });
    }
  );
});

describe("initial scenario detail", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetReadOnlySupabaseContext.mockResolvedValue({
      supabase: mockSupabase,
      user: { id: "user-1" },
    });
    mockMembership.mockResolvedValue({
      data: { workspace_id: workspaceId, role: "manager" },
    });
    mockFrom.mockImplementation((table: string) => {
      if (table === "company_users") {
        const query = {
          select: jest.fn(),
          eq: jest.fn(),
          maybeSingle: mockMembership,
        };
        query.select.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        return query;
      }
      return { select: () => ({ eq: mockSources }) };
    });
    mockSources.mockResolvedValue({ data: [] });
    mockGetLocale.mockResolvedValue("en");
    mockLoadMessages.mockResolvedValue(messages);
    mockListScenarios.mockResolvedValue(summaries);
    mockWebhookConfigured.mockReturnValue(false);
    mockTemporalConfigured.mockReturnValue(false);
    mockFeatureFlags.mockResolvedValue(null);
    mockLoadScenarioDetail.mockResolvedValue(null);
    mockRegisteredAudienceEnabled.mockResolvedValue(false);
  });

  it("streams the requested scenario's API body with a server read time", async () => {
    const updatedAt = new Date("2026-09-30T08:00:00.000Z");
    mockLoadScenarioDetail.mockResolvedValue({
      scenario: { _id: "scenario-b", name: "Follow-up", updatedAt },
      metadata: {
        linkedConditionParentCountByNodeId: {},
        mediaDisplayUrlsPending: true,
      },
    });
    const before = Date.now();

    const props = editorProps(await loadPage({ scenarioId: "scenario-b" }));
    const detail = await props.initialScenarioDetail;

    // Media signing is time-boxed; the canvas asks again for pending media.
    expect(mockLoadScenarioDetail).toHaveBeenCalledWith({
      workspaceId,
      scenarioId: "scenario-b",
      mediaSigning: "deferred",
    });
    expect(detail).toEqual({
      scenarioId: "scenario-b",
      loadedAt: expect.any(Number),
      response: {
        scenario: {
          _id: "scenario-b",
          name: "Follow-up",
          updatedAt: "2026-09-30T08:00:00.000Z",
        },
        metadata: {
          linkedConditionParentCountByNodeId: {},
          mediaDisplayUrlsPending: true,
        },
      },
    });
    expect(detail?.loadedAt).toBeGreaterThanOrEqual(before);
    expect(detail?.loadedAt).toBeLessThanOrEqual(Date.now());
  });

  it.each([
    ["absent", {}],
    ["no longer in the workspace", { scenarioId: "deleted-elsewhere" }],
  ])(
    "opens the first scenario when the requested one is %s",
    async (_label, searchParams) => {
      const props = editorProps(await loadPage(searchParams));
      await props.initialScenarioDetail;

      expect(mockLoadScenarioDetail).toHaveBeenCalledWith({
        workspaceId,
        scenarioId: "scenario-a",
        mediaSigning: "deferred",
      });
    }
  );

  it("starts the detail once access and the summaries are ready, not after every read", async () => {
    const sources = deferred<{ data: never[] }>();
    const catalog = deferred<typeof messages>();
    const flags = deferred<null>();
    mockSources.mockReturnValueOnce(sources.promise);
    mockLoadMessages.mockReturnValueOnce(catalog.promise);
    mockFeatureFlags.mockReturnValueOnce(flags.promise);
    let settled = false;

    const page = loadPage().then(result => {
      settled = true;
      return result;
    });
    await flushAsyncWork();
    expect(settled).toBe(false);
    expect(mockLoadScenarioDetail).toHaveBeenCalledWith({
      workspaceId,
      scenarioId: "scenario-a",
      mediaSigning: "deferred",
    });

    sources.resolve({ data: [] });
    catalog.resolve(messages);
    flags.resolve(null);
    expect(editorProps(await page).requestedScenarioId).toBeNull();
    expect(mockLoadScenarioDetail).toHaveBeenCalledTimes(1);
  });

  it("does not hold the page for the detail", async () => {
    mockLoadScenarioDetail.mockReturnValue(new Promise(() => undefined));

    const props = editorProps(await loadPage());

    expect(props.initialScenarioDetail).toBeInstanceOf(Promise);
  });

  it("resolves null for an empty workspace or a missing scenario", async () => {
    mockListScenarios.mockResolvedValueOnce([]);
    const empty = editorProps(await loadPage());
    await expect(empty.initialScenarioDetail).resolves.toBeNull();
    expect(mockLoadScenarioDetail).not.toHaveBeenCalled();

    mockLoadScenarioDetail.mockResolvedValueOnce(null);
    const missing = editorProps(await loadPage());
    await expect(missing.initialScenarioDetail).resolves.toBeNull();
  });

  it("logs a failed read and resolves null so the canvas asks the API", async () => {
    const failure = new Error("media api cold");
    mockLoadScenarioDetail.mockRejectedValueOnce(failure);

    const props = editorProps(await loadPage());

    await expect(props.initialScenarioDetail).resolves.toBeNull();
    expect(mockLoggerError).toHaveBeenCalledWith(
      "scenarios.initial_detail_failed",
      failure,
      { workspaceId, scenarioId: "scenario-a" }
    );
  });
});

describe("registered-phones audience flag", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetReadOnlySupabaseContext.mockResolvedValue({
      supabase: mockSupabase,
      user: { id: "user-1" },
    });
    mockMembership.mockResolvedValue({
      data: { workspace_id: workspaceId, role: "manager" },
    });
    mockFrom.mockImplementation((table: string) => {
      if (table === "company_users") {
        const query = {
          select: jest.fn(),
          eq: jest.fn(),
          maybeSingle: mockMembership,
        };
        query.select.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        return query;
      }
      return { select: () => ({ eq: mockSources }) };
    });
    mockGetLocale.mockResolvedValue("en");
    mockLoadMessages.mockResolvedValue(messages);
    mockListScenarios.mockResolvedValue([]);
    mockWebhookConfigured.mockReturnValue(false);
    mockTemporalConfigured.mockReturnValue(false);
    mockFeatureFlags.mockResolvedValue(null);
    mockLoadScenarioDetail.mockResolvedValue(null);
  });

  it.each([true, false])(
    "passes the allow-list answer %s for a WhatsApp workspace",
    async enabled => {
      mockSources.mockResolvedValue({ data: [whatsAppRow] });
      mockRegisteredAudienceEnabled.mockResolvedValue(enabled);

      const props = editorProps(await loadPage());

      expect(props.registeredAudienceEnabled).toBe(enabled);
      expect(mockRegisteredAudienceEnabled).toHaveBeenCalledWith({
        workspaceId,
      });
    }
  );

  it("skips the check without a connected WhatsApp source", async () => {
    mockSources.mockResolvedValue({ data: [emailRow, calendarRow] });
    mockRegisteredAudienceEnabled.mockResolvedValue(true);

    const props = editorProps(await loadPage());

    expect(props.registeredAudienceEnabled).toBe(false);
    expect(mockRegisteredAudienceEnabled).not.toHaveBeenCalled();
  });

  it("treats a failed check as disabled", async () => {
    mockSources.mockResolvedValue({ data: [whatsAppRow] });
    mockRegisteredAudienceEnabled.mockRejectedValue(new Error("offline"));

    expect(editorProps(await loadPage()).registeredAudienceEnabled).toBe(false);
  });
});

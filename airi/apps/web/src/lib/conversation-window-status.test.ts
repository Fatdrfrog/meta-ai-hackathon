const mockFetchSourceWithCredentials = jest.fn();

jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentials: (...args: unknown[]) =>
    mockFetchSourceWithCredentials(...args),
}));

import { buildConversationMessagingWindowStatus } from "./conversation-window-status";

const instagramSource = (credentials: Record<string, unknown>) => ({
  id: "source-2",
  credentials: {
    page_access_token: "page-token",
    auth_method: "instagram_business_login",
    instagram_scoped_id: "1784",
    ...credentials,
  },
});

describe("buildConversationMessagingWindowStatus", () => {
  const previousHumanAgentEnv = process.env.AIRI_INSTAGRAM_HUMAN_AGENT_ENABLED;

  beforeEach(() => {
    mockFetchSourceWithCredentials.mockReset();
    delete process.env.AIRI_INSTAGRAM_HUMAN_AGENT_ENABLED;
  });

  afterAll(() => {
    if (previousHumanAgentEnv === undefined) {
      delete process.env.AIRI_INSTAGRAM_HUMAN_AGENT_ENABLED;
    } else {
      process.env.AIRI_INSTAGRAM_HUMAN_AGENT_ENABLED = previousHumanAgentEnv;
    }
  });

  it("reads Human Agent from the source the conversation sends through", async () => {
    mockFetchSourceWithCredentials.mockResolvedValueOnce(
      instagramSource({ human_agent_enabled: true })
    );

    const status = await buildConversationMessagingWindowStatus({
      _id: "conversation-ig-1",
      channel: "instagram",
      workspaceId: "workspace-1",
      sourceId: "source-2",
      last_inbound_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });

    expect(mockFetchSourceWithCredentials).toHaveBeenCalledWith(
      "source-2",
      "instagram"
    );
    expect(status.requiresWindow).toBe(true);
    expect(status.windowInfo?.isWithinWindow).toBe(false);
    expect(status.humanAgent).toMatchObject({ supported: true, enabled: true });
  });

  it("reports Instagram as not connected when no account can send", async () => {
    mockFetchSourceWithCredentials.mockResolvedValue(
      instagramSource({ page_access_token: "" })
    );

    const status = await buildConversationMessagingWindowStatus({
      _id: "conversation-ig-2",
      channel: "instagram",
      workspaceId: "workspace-2",
      sourceId: "source-3",
      last_inbound_at: new Date(),
    });

    expect(status.humanAgent).toMatchObject({
      supported: true,
      enabled: false,
      reason: "instagram_not_connected",
    });
  });

  it("does not load Instagram credentials for other channels", async () => {
    const status = await buildConversationMessagingWindowStatus({
      _id: "conversation-wa-1",
      channel: "whatsapp",
      workspaceId: "workspace-1",
      sourceId: "source-wa",
      last_inbound_at: new Date(),
    });

    expect(mockFetchSourceWithCredentials).not.toHaveBeenCalled();
    expect(status.humanAgent).toEqual({ supported: false, enabled: false });
  });
});

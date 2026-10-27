/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AgentSettingsView from "./agent-settings-view";
import { DEFAULT_WORKSPACE_BOT_RUNTIME_SETTINGS } from "@/lib/airi/workspace-bot-contract";
import { captureClientEvent } from "@/lib/posthog/client";
import { installMatchMedia } from "@/test-support/dom-test-utils";

jest.mock("@/lib/posthog/client", () => ({ captureClientEvent: jest.fn() }));
const settings = {
  success: true,
  ...DEFAULT_WORKSPACE_BOT_RUNTIME_SETTINGS,
  agentPersona: { displayName: "Airi" },
  totalConversations: 0,
  enabledConversations: 0,
  scenariosEnabledConversations: 0,
  coachEnabledConversations: 0,
};
const response = (data: unknown, ok = true) => ({ ok, json: async () => data });

describe("AgentSettingsView", () => {
  beforeAll(() => {
    installMatchMedia();
  });
  beforeEach(() => jest.clearAllMocks());

  it("does not render an editable default form after a failed load and supports retry", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response({ error: "unavailable" }, false))
      .mockResolvedValueOnce(response(settings));
    render(<AgentSettingsView workspaceId="workspace_1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "agentLoadFailed"
    );
    expect(screen.queryByLabelText("agentDisplayName")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(await screen.findByLabelText("agentDisplayName")).toHaveValue(
      "Airi"
    );
    expect(screen.getByRole("button", { name: "agentSave" })).toBeDisabled();
  });

  it("rejects successful HTTP responses without the settings success contract", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(response({ error: "unavailable" }));
    render(<AgentSettingsView workspaceId="workspace_1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "agentLoadFailed"
    );
  });

  it("keeps a draft dirty when saving fails", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response(settings))
      .mockResolvedValueOnce(response({ error: "save failed" }, false));
    render(<AgentSettingsView workspaceId="workspace_1" />);
    fireEvent.change(await screen.findByLabelText("agentDisplayName"), {
      target: { value: "Sales" },
    });
    fireEvent.click(screen.getByRole("button", { name: "agentSave" }));
    expect(await screen.findByText("agentSaveFailed")).toBeInTheDocument();
    expect(screen.getByLabelText("agentDisplayName")).toHaveValue("Sales");
    expect(
      screen.getByRole("button", { name: "agentSave" })
    ).not.toBeDisabled();
    expect(screen.queryByText("agentSaveSuccess")).not.toBeInTheDocument();
  });

  it("uses the confirmed server snapshot after save and clears unsaved status", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response(settings))
      .mockResolvedValueOnce(
        response({ ...settings, agentPersona: { displayName: "Sales" } })
      );
    render(<AgentSettingsView workspaceId="workspace_1" />);
    fireEvent.change(await screen.findByLabelText("agentDisplayName"), {
      target: { value: "Sales " },
    });
    fireEvent.click(screen.getByRole("button", { name: "agentSave" }));
    expect(await screen.findByText("agentSaveSuccess")).toBeInTheDocument();
    expect(screen.getByLabelText("agentDisplayName")).toHaveValue("Sales");
    expect(screen.getByRole("button", { name: "agentSave" })).toBeDisabled();
    expect(screen.queryByText("agentUnsavedChanges")).not.toBeInTheDocument();
  });

  it("never silently drops an incomplete custom action", async () => {
    global.fetch = jest.fn().mockResolvedValue(response(settings));
    render(<AgentSettingsView workspaceId="workspace_1" />);
    await screen.findByLabelText("agentDisplayName");
    fireEvent.click(
      screen.getByRole("button", { name: "agentSectionActions" })
    );
    fireEvent.click(screen.getByRole("button", { name: "agentAddAction" }));
    fireEvent.change(screen.getByLabelText("agentActionName"), {
      target: { value: "Offer discount" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "agentIncompleteAction"
    );
    expect(screen.getByRole("button", { name: "agentSave" })).toBeDisabled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("agentActionWhen"), {
      target: { value: "Asked about price" },
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "agentSave" })
    ).not.toBeDisabled();
  });

  it("deduplicates restricted topics regardless of case", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      response({
        ...settings,
        agentPersona: { topicRestrictions: ["Politics"] },
      })
    );
    render(<AgentSettingsView workspaceId="workspace_1" />);
    const input = await screen.findByLabelText("agentTopicRestrictions");
    fireEvent.change(input, { target: { value: "politics" } });
    fireEvent.click(screen.getByRole("button", { name: "agentAddTopic" }));
    expect(screen.getByRole("button", { name: "agentSave" })).toBeDisabled();
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("saves an opt-in only when voice replies are available", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        response({
          ...settings,
          voiceReplyAccess: { available: true, reason: null },
        })
      )
      .mockResolvedValueOnce(
        response({
          ...settings,
          whatsappVoiceRepliesEnabled: true,
          voiceReplyAccess: { available: true, reason: null },
        })
      );
    render(<AgentSettingsView workspaceId="workspace_1" />);
    await screen.findByLabelText("agentDisplayName");
    fireEvent.click(screen.getByRole("button", { name: "agentSectionVoice" }));
    const toggle = screen.getByRole("switch", {
      name: "whatsappVoiceRepliesTitle",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "agentSave" }));
    expect(await screen.findByText("agentSaveSuccess")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    const [, options] = (global.fetch as jest.Mock).mock.calls[1];
    expect(JSON.parse(options.body).whatsappVoiceRepliesEnabled).toBe(true);
    expect(captureClientEvent).toHaveBeenCalledWith(
      "airi_voice_reply_setting_saved",
      { workspace_id: "workspace_1", enabled: true }
    );
  });

  it("disables opt-in and offers an upgrade on Free", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      response({
        ...settings,
        voiceReplyAccess: {
          available: false,
          reason: "subscription_required",
        },
      })
    );
    render(<AgentSettingsView workspaceId="workspace_1" />);
    await screen.findByLabelText("agentDisplayName");
    fireEvent.click(screen.getByRole("button", { name: "agentSectionVoice" }));
    expect(
      screen.getByRole("switch", { name: "whatsappVoiceRepliesTitle" })
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "whatsappVoiceRepliesUpgrade" })
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "upgradeToPro" })
    ).toBeInTheDocument();
    expect(captureClientEvent).toHaveBeenCalledWith(
      "airi_voice_reply_upgrade_clicked",
      { workspace_id: "workspace_1" }
    );
  });

  it("links paid workspaces without ElevenLabs to existing integrations", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      response({
        ...settings,
        voiceReplyAccess: { available: false, reason: "elevenlabs_required" },
      })
    );
    render(<AgentSettingsView workspaceId="workspace_1" />);
    await screen.findByLabelText("agentDisplayName");
    fireEvent.click(screen.getByRole("button", { name: "agentSectionVoice" }));
    expect(
      screen.getByRole("switch", { name: "whatsappVoiceRepliesTitle" })
    ).toBeDisabled();
    expect(
      screen.getByRole("link", { name: "whatsappVoiceRepliesConnect" })
    ).toHaveAttribute("href", "/panel/w/workspace_1/settings/integrations");
  });

  it("does not report a concurrent voice-setting change as this user's opt-in", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        response({
          ...settings,
          voiceReplyAccess: { available: true, reason: null },
        })
      )
      .mockResolvedValueOnce(
        response({
          ...settings,
          agentPersona: { displayName: "Sales" },
          whatsappVoiceRepliesEnabled: true,
          voiceReplyAccess: { available: true, reason: null },
        })
      );
    render(<AgentSettingsView workspaceId="workspace_1" />);
    fireEvent.change(await screen.findByLabelText("agentDisplayName"), {
      target: { value: "Sales" },
    });
    fireEvent.click(screen.getByRole("button", { name: "agentSave" }));
    expect(await screen.findByText("agentSaveSuccess")).toBeInTheDocument();
    expect(captureClientEvent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "agentSectionVoice" }));
    expect(
      screen.getByRole("switch", { name: "whatsappVoiceRepliesTitle" })
    ).toHaveAttribute("aria-checked", "true");
  });

  it("saves unrelated edits after downgrade without requesting voice replies again", async () => {
    const downgradedSettings = {
      ...settings,
      whatsappVoiceRepliesEnabled: true,
      voiceReplyAccess: { available: false, reason: "subscription_required" },
    };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response(downgradedSettings))
      .mockResolvedValueOnce(
        response({
          ...downgradedSettings,
          agentPersona: { displayName: "Sales" },
        })
      );
    render(<AgentSettingsView workspaceId="workspace_1" />);
    fireEvent.change(await screen.findByLabelText("agentDisplayName"), {
      target: { value: "Sales" },
    });
    fireEvent.click(screen.getByRole("button", { name: "agentSave" }));
    expect(await screen.findByText("agentSaveSuccess")).toBeInTheDocument();
    const [, options] = (global.fetch as jest.Mock).mock.calls[1];
    expect(JSON.parse(options.body)).not.toHaveProperty(
      "whatsappVoiceRepliesEnabled"
    );
    expect(captureClientEvent).not.toHaveBeenCalled();
  });

  it("refreshes upgrade guidance after a stale opt-in is rejected without reporting a saved setting", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        response({
          ...settings,
          voiceReplyAccess: { available: true, reason: null },
        })
      )
      .mockResolvedValueOnce(
        response(
          {
            voiceReplyAccess: {
              available: false,
              reason: "subscription_required",
            },
          },
          false
        )
      );
    render(<AgentSettingsView workspaceId="workspace_1" />);
    await screen.findByLabelText("agentDisplayName");
    fireEvent.click(screen.getByRole("button", { name: "agentSectionVoice" }));
    fireEvent.click(
      screen.getByRole("switch", { name: "whatsappVoiceRepliesTitle" })
    );
    fireEvent.click(screen.getByRole("button", { name: "agentSave" }));
    expect(await screen.findByText("agentSaveFailed")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "whatsappVoiceRepliesUpgrade" })
    ).toBeInTheDocument();
    expect(captureClientEvent).not.toHaveBeenCalled();
    const toggle = screen.getByRole("switch", {
      name: "whatsappVoiceRepliesTitle",
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(toggle).toBeDisabled();
    expect(screen.getByRole("button", { name: "agentSave" })).toBeDisabled();
  });

  it("allows disabling a saved opt-in after losing access", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        response({
          ...settings,
          whatsappVoiceRepliesEnabled: true,
          voiceReplyAccess: {
            available: false,
            reason: "subscription_required",
          },
        })
      )
      .mockResolvedValueOnce(
        response({
          ...settings,
          whatsappVoiceRepliesEnabled: false,
          voiceReplyAccess: {
            available: false,
            reason: "subscription_required",
          },
        })
      );
    render(<AgentSettingsView workspaceId="workspace_1" />);
    await screen.findByLabelText("agentDisplayName");
    fireEvent.click(screen.getByRole("button", { name: "agentSectionVoice" }));
    const toggle = screen.getByRole("switch", {
      name: "whatsappVoiceRepliesTitle",
    });
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "agentSave" }));
    expect(await screen.findByText("agentSaveSuccess")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toBeDisabled();
  });
});

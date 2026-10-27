/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { AiriManagerGuardCard } from "./airi-manager-guard-card";

jest.mock("next-intl", () => {
  const t = (key: string) => key;
  return { useTranslations: () => t };
});
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
const settings = {
  enabled: true,
  skipIfManagerRecentlyReplied: true,
  skipIfTaggedManagerMessage: true,
  managerRecentReplyWindowSeconds: 300,
  managerUserLinks: [],
};
const response = (data: unknown, ok = true) => ({ ok, json: async () => data });

describe("manager takeover settings", () => {
  afterEach(() => jest.useRealTimers());
  it("shows retry instead of editable defaults after loading fails", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(response({ error: "unavailable" }, false));
    render(<AiriManagerGuardCard workspaceId="workspace_1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("loadFailed");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument();
  });

  it("rejects malformed successful HTTP responses instead of claiming default settings are loaded", async () => {
    global.fetch = jest.fn().mockResolvedValue(response({ success: true }));
    render(<AiriManagerGuardCard workspaceId="workspace_1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("loadFailed");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("allows typing a shorter pause without clamping every keystroke and saves on blur", async () => {
    jest.useFakeTimers();
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response({ success: true, settings }))
      .mockResolvedValueOnce(
        response({
          success: true,
          settings: { ...settings, managerRecentReplyWindowSeconds: 60 },
        })
      );
    render(<AiriManagerGuardCard workspaceId="workspace_1" />);
    await act(async () => {});
    const input = screen.getByLabelText("windowLabel");
    fireEvent.change(input, { target: { value: "6" } });
    expect(input).toHaveValue(6);
    fireEvent.change(input, { target: { value: "60" } });
    expect(input).toHaveValue(60);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    fireEvent.blur(input);
    await act(async () => {
      jest.advanceTimersByTime(451);
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace_1/airi-manager-guard",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          ...settings,
          managerRecentReplyWindowSeconds: 60,
        }),
      })
    );
    expect(screen.getByText("savedStatus")).toBeInTheDocument();
  });
});

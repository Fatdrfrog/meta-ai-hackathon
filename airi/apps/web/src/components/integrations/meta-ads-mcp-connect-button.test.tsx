/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MetaAdsMcpConnectButton } from "./meta-ads-mcp-connect-button";

const mockConnect = jest.fn();
const mockSuccess = jest.fn();
const mockWarning = jest.fn();
const mockError = jest.fn();
jest.mock("@/lib/meta-ads/connect-meta-ads-mcp-client", () => ({
  connectMetaAdsMcpViaFacebookSdk: (...args: unknown[]) => mockConnect(...args),
}));
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockSuccess(...args),
    warning: (...args: unknown[]) => mockWarning(...args),
    error: (...args: unknown[]) => mockError(...args),
  },
}));
beforeEach(() => jest.clearAllMocks());

it("confirms campaign access without requiring optional AI management", async () => {
  const result = {
    ok: true,
    reportingReady: true,
    readiness: { canRead: false, canWrite: false },
  };
  mockConnect.mockResolvedValue(result);
  const onConnected = jest.fn();
  render(
    <MetaAdsMcpConnectButton
      workspaceId="workspace"
      label="Connect"
      intent="reporting"
      allowCreateGraphSource
      onConnected={onConnected}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(mockSuccess).toHaveBeenCalledWith("experience.reportingConnected")
  );
  expect(mockWarning).not.toHaveBeenCalled();
  expect(mockConnect).toHaveBeenCalledWith({
    workspaceId: "workspace",
    intent: "reporting",
    allowCreateGraphSource: true,
  });
  expect(onConnected).toHaveBeenCalledWith(result);
});

it("keeps saved access recoverable when the previous ad account is unavailable", async () => {
  const result = {
    ok: true,
    reportingReady: false,
    readiness: { canRead: false, canWrite: false },
  };
  mockConnect.mockResolvedValue(result);
  const onConnected = jest.fn();
  render(
    <MetaAdsMcpConnectButton
      workspaceId="workspace"
      label="Connect"
      intent="reporting"
      onConnected={onConnected}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(mockWarning).toHaveBeenCalledWith("experience.chooseAccount")
  );
  expect(mockSuccess).not.toHaveBeenCalled();
  expect(onConnected).toHaveBeenCalledWith(result);
});

it("prevents duplicate submissions and reports safe errors without provider details", async () => {
  let complete!: (value: unknown) => void;
  mockConnect.mockReturnValue(
    new Promise(resolve => {
      complete = resolve;
    })
  );
  const onPendingChange = jest.fn();
  render(
    <MetaAdsMcpConnectButton
      workspaceId="workspace"
      label="Connect"
      onPendingChange={onPendingChange}
    />
  );
  const button = screen.getByRole("button", { name: "Connect" });
  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(onPendingChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(button);
  expect(mockConnect).toHaveBeenCalledTimes(1);
  complete({ ok: false, error: "access_token=secret" });
  await waitFor(() => expect(button).toBeEnabled());
  expect(onPendingChange).toHaveBeenLastCalledWith(false);
  expect(mockError).toHaveBeenCalledWith("experience.connectionFailed");
});

it("shows the safe recovery for a known connection failure", async () => {
  mockConnect.mockResolvedValue({
    ok: false,
    errorCode: "server_not_configured",
    error: "App secret is missing",
  });
  render(<MetaAdsMcpConnectButton workspaceId="workspace" label="Connect" />);
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(mockError).toHaveBeenCalledWith(
      "errors.server_not_configured.message"
    )
  );
  expect(mockError).not.toHaveBeenCalledWith("App secret is missing");
});

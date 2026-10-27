/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const mockToastError = jest.fn();
const mockCaptureClientEvent = jest.fn();

jest.mock("next-intl", () => ({
  useTranslations:
    () =>
    (key: string, values?: Record<string, string>): string =>
      values ? `${key} ${JSON.stringify(values)}` : key,
}));

jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

jest.mock("@/lib/posthog/client", () => ({
  captureClientEvent: (...args: unknown[]) => mockCaptureClientEvent(...args),
}));

jest.mock("@/lib/facebook-sdk", () => {
  const actual = jest.requireActual("@/lib/facebook-sdk");
  return {
    ...actual,
    loadFacebookSDK: jest.fn(async () => window.FB),
  };
});

import {
  loadFacebookSDK,
  type FacebookLoginResponse,
} from "@/lib/facebook-sdk";
import { EmbeddedSignupButton } from "./embedded-signup-button";

type LoginCallback = (response: FacebookLoginResponse) => void;

const mockedLoadFacebookSDK = loadFacebookSDK as jest.MockedFunction<
  typeof loadFacebookSDK
>;

function postMetaMessage(data: Record<string, unknown>) {
  window.dispatchEvent(
    new MessageEvent("message", {
      origin: "https://www.facebook.com",
      data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", ...data }),
    })
  );
}

function installFacebookLogin(
  onLogin: (callback: LoginCallback) => void
): jest.Mock {
  const login = jest.fn((callback: LoginCallback) => onLogin(callback));
  window.FB = { init: jest.fn(), login } as unknown as typeof window.FB;
  return login;
}

function eventProperties(event: string) {
  const call = mockCaptureClientEvent.mock.calls.find(
    ([name]) => name === event
  );
  return call?.[1] as Record<string, unknown> | undefined;
}

function failureEventProperties() {
  return eventProperties("whatsapp_embedded_signup_failed");
}

describe("EmbeddedSignupButton failure reporting", () => {
  const originalEnv = {
    appId: process.env.NEXT_PUBLIC_META_APP_ID,
    cloudConfigId: process.env.NEXT_PUBLIC_META_CLOUD_EMBEDDED_SIGNUP_CONFIG_ID,
  };

  beforeEach(() => {
    mockToastError.mockReset();
    mockCaptureClientEvent.mockReset();
    mockedLoadFacebookSDK.mockImplementation(async () => window.FB!);
    process.env.NEXT_PUBLIC_META_APP_ID = "app-1";
    process.env.NEXT_PUBLIC_META_CLOUD_EMBEDDED_SIGNUP_CONFIG_ID = "config-1";
  });

  afterEach(() => {
    delete window.FB;
    process.env.NEXT_PUBLIC_META_APP_ID = originalEnv.appId;
    process.env.NEXT_PUBLIC_META_CLOUD_EMBEDDED_SIGNUP_CONFIG_ID =
      originalEnv.cloudConfigId;
  });

  async function clickConnect() {
    // Let the SDK preload effect settle before clicking.
    await act(async () => {
      render(
        <EmbeddedSignupButton label="Connect" workspaceId="workspace-1" />
      );
    });
    const button = screen.getByRole("button", { name: "Connect" });
    await act(async () => {
      fireEvent.click(button);
    });
    return button;
  }

  it("shows Meta's reported error and records it when no code comes back", async () => {
    installFacebookLogin(callback => {
      postMetaMessage({
        event: "CANCEL",
        data: {
          error_message: "Display name rejected.",
          error_code: "524126",
          session_id: "session-1",
        },
      });
      callback({ status: "unknown" });
    });

    const button = await clickConnect();

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("failure.errorTitle", {
        description: `failure.errorDescription ${JSON.stringify({
          message: "Display name rejected.",
        })}`,
        duration: 10_000,
      })
    );
    expect(mockCaptureClientEvent).toHaveBeenCalledWith(
      "whatsapp_embedded_signup_started",
      { flow: "cloud_api", intent: "new", workspace_id: "workspace-1" }
    );
    expect(failureEventProperties()).toMatchObject({
      outcome: "error",
      error_code: "524126",
      error_message: "Display name rejected.",
      meta_session_id: "session-1",
      fb_login_status: "unknown",
      workspace_id: "workspace-1",
    });
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("waits for a CANCEL that Meta posts after the login callback", async () => {
    installFacebookLogin(callback => {
      callback({ status: "unknown" });
      setTimeout(() => {
        postMetaMessage({
          event: "CANCEL",
          data: { current_step: "PHONE_NUMBER_SETUP" },
        });
      }, 50);
    });

    await clickConnect();

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("failure.cancelledTitle", {
        description: "failure.cancelledDescription",
        duration: 10_000,
      })
    );
    expect(failureEventProperties()).toMatchObject({
      outcome: "cancelled",
      current_step: "PHONE_NUMBER_SETUP",
    });
  });

  it("separates a finished Meta flow without a code from a plain close", async () => {
    installFacebookLogin(callback => {
      postMetaMessage({
        event: "FINISH",
        data: { waba_id: "waba-1", phone_number_id: "phone-1" },
      });
      callback({ status: "unknown" });
    });

    await clickConnect();

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "failure.finishedWithoutCodeTitle",
        {
          description: "failure.finishedWithoutCodeDescription",
          duration: 10_000,
        }
      )
    );
    expect(failureEventProperties()).toMatchObject({
      outcome: "finished_without_code",
      meta_event: "FINISH",
      waba_id: "waba-1",
      phone_number_id: "phone-1",
    });
  });

  it("reports a window that closed with an empty auth response", async () => {
    installFacebookLogin(callback => {
      callback({ status: "connected", authResponse: {} as never });
    });

    const button = await clickConnect();

    await waitFor(
      () =>
        expect(mockToastError).toHaveBeenCalledWith("failure.closedTitle", {
          description: "failure.closedDescription",
          duration: 10_000,
        }),
      { timeout: 3_000 }
    );
    expect(failureEventProperties()).toMatchObject({
      outcome: "closed",
      fb_login_status: "connected",
    });
    expect(button).toBeEnabled();
  });

  it("ignores session messages from origins other than Meta", async () => {
    installFacebookLogin(callback => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://evilfacebook.com",
          data: JSON.stringify({
            type: "WA_EMBEDDED_SIGNUP",
            event: "CANCEL",
            data: { error_message: "Spoofed" },
          }),
        })
      );
      callback({ status: "unknown" });
    });

    await clickConnect();

    await waitFor(() => expect(failureEventProperties()).toBeDefined(), {
      timeout: 3_000,
    });
    expect(failureEventProperties()).toMatchObject({ outcome: "closed" });
  });

  it("records a received code without sending the code to analytics", async () => {
    // jsdom cannot navigate; it reports the callback redirect on console.error.
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    installFacebookLogin(callback => {
      postMetaMessage({
        event: "FINISH",
        data: { waba_id: "waba-1", phone_number_id: "phone-1" },
      });
      callback({
        status: "connected",
        authResponse: { code: "secret-oauth-code" },
      });
    });

    try {
      await clickConnect();

      await waitFor(() =>
        expect(mockCaptureClientEvent).toHaveBeenCalledWith(
          "whatsapp_embedded_signup_code_received",
          {
            flow: "cloud_api",
            intent: "new",
            workspace_id: "workspace-1",
            meta_event: "FINISH",
          }
        )
      );
      expect(failureEventProperties()).toBeUndefined();
      expect(mockToastError).not.toHaveBeenCalled();
      expect(JSON.stringify(mockCaptureClientEvent.mock.calls)).not.toContain(
        "secret-oauth-code"
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("records clicks while the Facebook SDK is unavailable", async () => {
    mockedLoadFacebookSDK.mockRejectedValue(
      new Error("Facebook SDK script failed to load")
    );
    const consoleWarn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    try {
      await clickConnect();
    } finally {
      consoleWarn.mockRestore();
    }

    expect(failureEventProperties()).toEqual({
      flow: "cloud_api",
      intent: "new",
      workspace_id: "workspace-1",
      outcome: "sdk_unavailable",
      error_name: undefined,
    });
    expect(eventProperties("whatsapp_embedded_signup_started")).toBeUndefined();
  });

  it("records a Meta launch that throws", async () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    installFacebookLogin(() => {
      throw new DOMException(
        "The object can not be found here.",
        "NotFoundError"
      );
    });

    try {
      const button = await clickConnect();

      expect(failureEventProperties()).toMatchObject({
        outcome: "launch_failed",
        error_name: "NotFoundError",
      });
      expect(mockToastError).toHaveBeenCalledWith(
        expect.stringContaining("launchErrors.configNotFound")
      );
      expect(button).toBeEnabled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("preloads the Facebook SDK while the button is still disabled", async () => {
    mockedLoadFacebookSDK.mockClear();

    await act(async () => {
      render(
        <EmbeddedSignupButton
          label="Connect"
          workspaceId="workspace-1"
          disabled
        />
      );
    });

    expect(mockedLoadFacebookSDK).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("shows a translated notice instead of a browser alert when signup is not configured", async () => {
    delete process.env.NEXT_PUBLIC_META_CLOUD_EMBEDDED_SIGNUP_CONFIG_ID;
    const alertSpy = jest
      .spyOn(window, "alert")
      .mockImplementation(() => undefined);
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      await clickConnect();
      expect(alertSpy).not.toHaveBeenCalled();
      expect(mockToastError).toHaveBeenCalledWith(
        expect.stringContaining("launchErrors.configMissing")
      );
      expect(failureEventProperties()).toMatchObject({
        outcome: "config_missing",
      });
    } finally {
      alertSpy.mockRestore();
      consoleError.mockRestore();
    }
  });
});

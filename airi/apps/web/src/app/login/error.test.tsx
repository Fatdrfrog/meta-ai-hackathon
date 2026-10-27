/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import LoginError from "./error";

const captureClientExceptionMock = jest.fn();

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    ({
      signInConnectionErrorTitle: "Sign-in didn't go through",
      signInConnectionErrorDescription:
        "We couldn't reach airi.chat. Check your internet connection or VPN, then try again.",
      signInPageErrorTitle: "The sign-in page hit a problem",
      signInPageErrorDescription:
        "Try again. If it keeps happening, reload the page.",
      tryAgain: "Try again",
      reloadPage: "Reload page",
    })[key] ?? key,
}));

jest.mock("@/lib/posthog/client", () => ({
  captureClientException: (...args: unknown[]) =>
    captureClientExceptionMock(...args),
}));

jest.mock("@/components/landing/landing-static-background", () => ({
  LandingStaticBackground: () => null,
}));

jest.mock("@/components/landing/landing-light-theme", () => ({
  LandingLightTheme: () => null,
}));

describe("login error boundary", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("keeps a sign-in request lost on the network on a retry screen and reports it", () => {
    const error = new TypeError("Failed to fetch");
    const reset = jest.fn();

    render(<LoginError error={error} reset={reset} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Sign-in didn't go through"
    );
    expect(
      screen.getByText(/Check your internet connection or VPN/)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(reset).toHaveBeenCalledTimes(1);
    expect(captureClientExceptionMock).toHaveBeenCalledWith(error, {
      error_boundary: "login",
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[login] page error boundary",
      error
    );
  });

  it("uses the general copy for errors that are not network failures", () => {
    render(
      <LoginError
        error={new Error("Unexpected render failure")}
        reset={jest.fn()}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The sign-in page hit a problem"
    );
    expect(
      screen.queryByText(/Check your internet connection/)
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reload page" })
    ).toBeInTheDocument();
  });
});

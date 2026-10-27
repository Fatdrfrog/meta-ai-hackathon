/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import GlobalError from "./global-error";

const captureClientExceptionMock = jest.fn();

jest.mock("@/lib/posthog/client", () => ({
  captureClientException: (...args: unknown[]) =>
    captureClientExceptionMock(...args),
}));

function setLocaleCookie(locale: string | null) {
  document.cookie =
    locale === null
      ? "NEXT_LOCALE=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/"
      : `NEXT_LOCALE=${locale}; path=/`;
}

describe("global error boundary", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    setLocaleCookie(null);
    consoleErrorSpy.mockRestore();
  });

  it("replaces Next's default error page with localized copy and a retry", () => {
    setLocaleCookie("ru");
    const error = new Error("Root layout failed");
    const reset = jest.fn();

    render(<GlobalError error={error} reset={reset} />);

    expect(
      screen.getByRole("heading", { name: "Страница не загрузилась" })
    ).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("lang", "ru");

    fireEvent.click(screen.getByRole("button", { name: "Попробовать снова" }));

    expect(reset).toHaveBeenCalledTimes(1);
    expect(captureClientExceptionMock).toHaveBeenCalledWith(error, {
      error_boundary: "global",
    });
  });

  it("falls back to English and names a lost connection", () => {
    render(
      <GlobalError error={new TypeError("network error")} reset={jest.fn()} />
    );

    expect(
      screen.getByRole("heading", { name: "This page didn't load" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Check your internet connection or VPN/)
    ).toBeInTheDocument();
  });
});

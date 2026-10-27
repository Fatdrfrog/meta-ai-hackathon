/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import PanelError from "./error-route";

const captureClientExceptionMock = jest.fn();

jest.mock("@/lib/posthog/client", () => ({
  captureClientException: (...args: unknown[]) =>
    captureClientExceptionMock(...args),
}));

describe("PanelError", () => {
  beforeEach(() => {
    captureClientExceptionMock.mockReset();
  });

  it("reports the crash to PostHog so panel failures are not silent", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error(
      "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node."
    );

    render(<PanelError error={error} reset={jest.fn()} />);

    expect(captureClientExceptionMock).toHaveBeenCalledWith(error, {
      error_boundary: "panel",
    });
    errorSpy.mockRestore();
  });

  it("shows a retry action after a render crash", () => {
    const reset = jest.fn();
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const error = Object.assign(new Error("maximum update depth exceeded"), {
      digest: "digest-1",
    });

    render(<PanelError error={error} reset={reset} />);

    expect(screen.getByRole("alert")).toHaveTextContent("hint");
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

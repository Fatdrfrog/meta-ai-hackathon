import {
  isBenignBrowserErrorMessage,
  isBenignResizeObserverMessage,
  shouldDropBenignExceptionEvent,
} from "./benign-browser-errors";

describe("benign-browser-errors", () => {
  it("matches known ResizeObserver browser noise", () => {
    expect(
      isBenignResizeObserverMessage(
        "ResizeObserver loop completed with undelivered notifications."
      )
    ).toBe(true);
    expect(
      isBenignResizeObserverMessage("ResizeObserver loop limit exceeded")
    ).toBe(true);
    expect(isBenignResizeObserverMessage("TypeError: boom")).toBe(false);
  });

  it("keeps translator DOM errors visible because they crash the page", () => {
    // These replaced the whole panel with "This page couldn't load"; the DOM
    // guards prevent them, so any that still happen must reach PostHog.
    expect(
      isBenignBrowserErrorMessage(
        "NotFoundError: Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node."
      )
    ).toBe(false);
    expect(
      isBenignBrowserErrorMessage(
        "Node.removeChild: The node to be removed is not a child of this node"
      )
    ).toBe(false);
    expect(isBenignBrowserErrorMessage("TypeError: boom")).toBe(false);
  });

  it("drops PostHog exception events for benign browser noise", () => {
    // posthog-js autocapture shape: `$exception_list` with items keyed `value`.
    expect(
      shouldDropBenignExceptionEvent({
        event: "$exception",
        properties: {
          $exception_list: [
            {
              type: "Error",
              value: "ResizeObserver loop limit exceeded",
            },
          ],
        },
      })
    ).toBe(true);

    expect(
      shouldDropBenignExceptionEvent({
        event: "$exception",
        properties: {
          $exception_list: [
            {
              type: "DOMException",
              value:
                "NotFoundError: Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.",
            },
          ],
        },
      })
    ).toBe(false);

    // Manual capture shape: an explicit top-level `$exception_message`.
    expect(
      shouldDropBenignExceptionEvent({
        event: "$exception",
        properties: {
          $exception_message:
            "ResizeObserver loop completed with undelivered notifications.",
        },
      })
    ).toBe(true);

    expect(
      shouldDropBenignExceptionEvent({
        event: "$exception",
        properties: {
          $exception_list: [{ type: "TypeError", value: "boom" }],
        },
      })
    ).toBe(false);

    expect(
      shouldDropBenignExceptionEvent({
        event: "$pageview",
        properties: {
          $exception_list: [
            {
              type: "Error",
              value: "ResizeObserver loop limit exceeded",
            },
          ],
        },
      })
    ).toBe(false);
  });
});

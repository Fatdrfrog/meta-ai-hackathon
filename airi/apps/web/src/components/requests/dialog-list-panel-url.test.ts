/**
 * @jest-environment jsdom
 */
import {
  buildConversationSelectionUrl,
  updateUrlWithoutNavigation,
} from "./dialog-list-panel-url";

describe("buildConversationSelectionUrl", () => {
  it("preserves message search params without requiring a Next router navigation", () => {
    const url = buildConversationSelectionUrl({
      currentSearchParams: "page=2&searchType=profile_name&searchQuery=old",
      conversationId: "conv_123",
      pathname: "/panel/w/ws_1/requests",
      messageSearchQuery: "delivery issue",
    });

    expect(url).toBe(
      "/panel/w/ws_1/requests?page=2&searchType=message_within_chat&searchQuery=delivery+issue&conversation=conv_123"
    );
  });

  it("clears stale message search params for normal conversation selection", () => {
    const url = buildConversationSelectionUrl({
      currentSearchParams:
        "searchType=message_within_chat&searchQuery=delivery",
      conversationId: "conv_456",
      pathname: "/panel/w/ws_1/requests",
      messageSearchQuery: null,
    });

    expect(url).toBe("/panel/w/ws_1/requests?conversation=conv_456");
  });
});

describe("updateUrlWithoutNavigation", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("replaces by default and pushes on request, keeping the history state", () => {
    const state = { __NA: true };
    jest.spyOn(window.history, "state", "get").mockReturnValue(state);
    const replace = jest
      .spyOn(window.history, "replaceState")
      .mockImplementation(() => undefined);
    const push = jest
      .spyOn(window.history, "pushState")
      .mockImplementation(() => undefined);

    updateUrlWithoutNavigation("/requests?conversation=a");
    updateUrlWithoutNavigation("/requests?conversation=b", true);

    expect(replace).toHaveBeenCalledWith(state, "", "/requests?conversation=a");
    expect(push).toHaveBeenCalledWith(state, "", "/requests?conversation=b");
  });

  it("retries without state when the browser rejects the current one", () => {
    const replace = jest
      .spyOn(window.history, "replaceState")
      .mockImplementationOnce(() => {
        throw new DOMException("not cloneable", "DataCloneError");
      })
      .mockImplementation(() => undefined);

    updateUrlWithoutNavigation("/requests");

    expect(replace).toHaveBeenLastCalledWith(null, "", "/requests");
    expect(replace).toHaveBeenCalledTimes(2);
  });
});

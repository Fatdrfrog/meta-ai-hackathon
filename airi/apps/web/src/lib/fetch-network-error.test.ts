import { isFetchNetworkError } from "./fetch-network-error";

describe("isFetchNetworkError", () => {
  it.each([
    ["Chrome, no response", "Failed to fetch"],
    ["Chrome, body cut off", "network error"],
    ["Safari", "Load failed"],
    ["Safari, dropped connection", "The network connection was lost."],
    ["Firefox", "NetworkError when attempting to fetch resource."],
  ])("recognises %s", (_browser, message) => {
    expect(isFetchNetworkError(new TypeError(message))).toBe(true);
  });

  it("ignores other TypeErrors and non-network errors", () => {
    expect(
      isFetchNetworkError(
        new TypeError("Cannot read properties of undefined (reading 'id')")
      )
    ).toBe(false);
    expect(isFetchNetworkError(new Error("Failed to fetch"))).toBe(false);
    expect(isFetchNetworkError("Failed to fetch")).toBe(false);
    expect(isFetchNetworkError(null)).toBe(false);
  });
});
